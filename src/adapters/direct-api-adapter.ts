import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions.js";
import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
  Response,
  Tool,
} from "openai/resources/responses/responses.js";
import { collectHeaderSecrets, type Redactor } from "../lib/redactor.js";
import { emailApprovalContext } from "../lib/approval-context.js";
import { approxTokens, measurePayload } from "../lib/observability.js";
import type {
  RuntimeAdapter,
  RuntimeDefinition,
  RuntimeEventSink,
  RuntimeHealth,
  RuntimeTurnContext,
} from "../runtime/adapter.js";
import { RunnerError } from "../runtime/errors.js";
import type { AgentExecutionRequest } from "../runtime/protocol.js";
import { effectiveMcpToolMode } from "../runtime/mcp-policy.js";
import { McpToolClient, type DiscoveredMcpTool } from "./mcp-tool-client.js";

type PendingApproval = {
  resolve(decision: "approve" | "deny"): void;
};

type ActiveRun = {
  request: AgentExecutionRequest;
  emit: RuntimeEventSink;
  redactor: Redactor;
  abortController: AbortController;
  approvals: Map<string, PendingApproval>;
  mcp: McpToolClient;
  callIndex: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalCostUsd: number | null;
  cancelRequested: boolean;
};

export type DirectAuthentication = {
  mode: "api_key";
  credential: string;
  baseUrl: string;
  apiFormat: "responses" | "chat_completions";
  providerRouting?: {
    requireParameters: boolean;
    dataCollection: "allow" | "deny";
    zdr: boolean;
  };
};

export type DirectApiClientFactory = (
  authentication: DirectAuthentication,
) => OpenAI;

export type DirectApiRuntimeProfile = {
  definition: RuntimeDefinition;
  providerName: string;
  authentication:
    | { kind: "direct" }
    | {
        kind: "openrouter";
        baseUrl: string;
        providerRouting: NonNullable<DirectAuthentication["providerRouting"]>;
      };
};

const MAX_MODEL_CALLS = 32;

export const DIRECT_API_RUNTIME_DEFINITION = {
  id: "direct_api",
  displayName: "Direct API",
  stability: "experimental",
  authModes: ["api_key"],
  capabilities: {
    freshThreads: true,
    threadResume: true,
    mcpServers: true,
    mcpToolAllowlist: true,
    toolApprovals: true,
    toolLifecycle: true,
    runtimeWarnings: true,
    usageReporting: true,
    cancellation: true,
    modelSelection: true,
    modelDiscovery: true,
    modelValidation: true,
    contextProfiling: true,
    budgetIncrementalUsage: true,
    budgetNativeTokenLimit: false,
    budgetNativeCostLimit: false,
  },
} satisfies RuntimeDefinition;

const DIRECT_API_RUNTIME_PROFILE: DirectApiRuntimeProfile = {
  definition: DIRECT_API_RUNTIME_DEFINITION,
  providerName: "Direct API",
  authentication: { kind: "direct" },
};

export class DirectApiAdapter implements RuntimeAdapter {
  readonly definition: RuntimeDefinition;
  readonly #runs = new Map<string, ActiveRun>();

  constructor(
    private readonly clientFactory: DirectApiClientFactory = (authentication) =>
      new OpenAI({
        apiKey: authentication.credential,
        baseURL: authentication.baseUrl,
        timeout: 60_000,
        maxRetries: 0,
        fetch: (input, init) => fetch(input, { ...init, redirect: "manual" }),
      }),
    private readonly mcpFactory: () => McpToolClient = () =>
      new McpToolClient(),
    private readonly profile: DirectApiRuntimeProfile = DIRECT_API_RUNTIME_PROFILE,
  ) {
    this.definition = profile.definition;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  health(signal?: AbortSignal): Promise<RuntimeHealth> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    return Promise.resolve({
      available: false,
      status: "authentication_required",
      reasonCode: "authentication_required",
      authentication: { status: "required", mode: "api_key" },
      checkedAt: new Date().toISOString(),
    });
  }

  startThread(request: AgentExecutionRequest): Promise<string> {
    this.assertAuthentication(request);
    this.assertBudgetSupport(request);
    return Promise.resolve(randomUUID());
  }

  resumeThread(request: AgentExecutionRequest): Promise<string> {
    this.assertAuthentication(request);
    this.assertBudgetSupport(request);
    if (!request.thread.runtimeThreadId) {
      return Promise.reject(
        new RunnerError(
          "THREAD_NOT_FOUND",
          "Runtime thread was not found",
          404,
        ),
      );
    }
    return Promise.resolve(request.thread.runtimeThreadId);
  }

  async runTurn(context: RuntimeTurnContext): Promise<void> {
    if (this.#runs.has(context.request.runId)) {
      throw new RunnerError(
        "RUN_ALREADY_EXISTS",
        "A run with this identifier already exists",
        409,
      );
    }
    const authentication = this.assertAuthentication(context.request);
    this.assertBudgetSupport(context.request);
    const run: ActiveRun = {
      request: context.request,
      emit: context.emit,
      redactor: collectHeaderSecrets(
        context.request.mcpServers.map(({ headers }) => headers),
        [authentication.credential],
      ),
      abortController: new AbortController(),
      approvals: new Map(),
      mcp: this.mcpFactory(),
      callIndex: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalCostUsd: null,
      cancelRequested: false,
    };
    this.#runs.set(context.request.runId, run);
    try {
      await run.mcp.connect(
        context.request.mcpServers,
        run.abortController.signal,
      );
      const client = this.client(authentication);
      if (authentication.apiFormat === "responses") {
        await this.runResponses(run, client);
      } else {
        await this.runChatCompletions(run, client, authentication);
      }
      if (run.cancelRequested) {
        throw new RunnerError("RUN_CANCELLED", "Run was cancelled", 409);
      }
    } catch (error) {
      if (run.cancelRequested || run.abortController.signal.aborted) {
        throw new RunnerError("RUN_CANCELLED", "Run was cancelled", 409);
      }
      if (error instanceof RunnerError) throw error;
      const status = this.errorStatus(error);
      if (status === 401 || status === 403) {
        throw new RunnerError(
          "RUNTIME_AUTHENTICATION_REQUIRED",
          `${this.profile.providerName} authentication failed`,
          401,
        );
      }
      throw new RunnerError(
        "RUNTIME_CRASHED",
        `${this.profile.providerName} runtime could not complete the run`,
        502,
      );
    } finally {
      this.resolvePendingApprovals(run, "deny");
      await run.mcp.close();
      this.#runs.delete(context.request.runId);
    }
  }

  cancelRun(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) {
      return Promise.reject(
        new RunnerError("RUN_NOT_FOUND", "Active run was not found", 404),
      );
    }
    run.cancelRequested = true;
    this.resolvePendingApprovals(run, "deny");
    run.abortController.abort();
    return Promise.resolve();
  }

  respondToApproval(
    runId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<void> {
    const run = this.#runs.get(runId);
    const approval = run?.approvals.get(approvalId);
    if (!run || !approval) {
      return Promise.reject(
        new RunnerError(
          "APPROVAL_FAILED",
          "Pending approval was not found",
          404,
        ),
      );
    }
    run.approvals.delete(approvalId);
    approval.resolve(decision);
    run.emit("approval.resolved", { approvalId, decision });
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.#runs.keys()].map((runId) => this.cancelRun(runId)),
    );
  }

  contextProfile(request: AgentExecutionRequest): Record<string, unknown> {
    const prompt = this.turnMessage(request);
    return {
      runtime: this.definition.id,
      estimator: "characters_divided_by_4",
      systemPrompt: {
        bytes: Buffer.byteLength(request.agent.instructions, "utf8"),
        approxTokens: approxTokens(request.agent.instructions.length),
      },
      turnInputTotal: {
        bytes: Buffer.byteLength(prompt, "utf8"),
        approxTokens: approxTokens(prompt.length),
      },
      rehydratedConversationContextApprox: {
        messageCount: request.context.length,
        bytes: Buffer.byteLength(
          request.context.map(({ body }) => body).join("\n"),
          "utf8",
        ),
        approxTokens: approxTokens(
          request.context.reduce((total, { body }) => total + body.length, 0),
        ),
      },
      mcpConfiguration: {
        serverCount: request.mcpServers.length,
        servers: request.mcpServers.map(({ name, url, headers }) => ({
          name,
          url,
          headerNames: Object.keys(headers).sort(),
        })),
      },
    };
  }

  private client(authentication: DirectAuthentication): OpenAI {
    return this.clientFactory(authentication);
  }

  private async runResponses(run: ActiveRun, client: OpenAI): Promise<void> {
    const input: ResponseInputItem[] = [
      ...run.request.context.map(({ role, body }) => ({ role, content: body })),
      { role: "user", content: run.request.message },
    ];
    const tools: Tool[] = this.availableMcpTools(run).map((definition) => ({
      type: "function",
      name: definition.providerName,
      description: definition.description,
      parameters: definition.inputSchema,
      strict: false,
    }));
    for (let turn = 0; turn < MAX_MODEL_CALLS; turn += 1) {
      const stream = await client.responses.create(
        {
          model: this.model(run.request),
          instructions: this.systemPrompt(run.request),
          input,
          tools,
          tool_choice: "auto",
          parallel_tool_calls: false,
          store: false,
          stream: true,
          ...(this.remainingOutputTokens(run) != null
            ? { max_output_tokens: this.remainingOutputTokens(run)! }
            : {}),
        },
        { signal: run.abortController.signal },
      );
      let completedResponse: Response | null = null;
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          run.emit("assistant.delta", {
            delta: run.redactor.text(event.delta),
          });
        } else if (event.type === "error") {
          run.emit("runtime.warning", {
            message: run.redactor.text(event.message),
            code: event.code ?? "provider_stream_error",
            willRetry: false,
            timestamp: new Date().toISOString(),
          });
        } else if (event.type === "response.completed") {
          completedResponse = event.response;
        }
      }
      if (!completedResponse) {
        throw new RunnerError(
          "RUNTIME_CRASHED",
          "Direct API stream ended without a completed response",
          502,
        );
      }
      const response: Response = completedResponse;
      if (!response.usage && this.hasHardBudget(run)) {
        throw new RunnerError(
          "RUNTIME_BUDGET_UNSUPPORTED",
          "Direct API provider omitted usage required for budget enforcement",
          409,
        );
      }
      if (response.usage)
        this.recordUsage(run, {
          inputTokens: response.usage.input_tokens,
          cachedInputTokens:
            response.usage.input_tokens_details?.cached_tokens ?? 0,
          outputTokens: response.usage.output_tokens,
          reasoningOutputTokens:
            response.usage.output_tokens_details?.reasoning_tokens ?? 0,
          model: response.model,
        });
      // Responses output items produced by the function-only request are valid
      // subsequent input items. The SDK unions differ for unrelated built-ins.
      input.push(...(response.output as unknown as ResponseInputItem[]));
      const calls = response.output.filter(
        (item): item is ResponseFunctionToolCall =>
          item.type === "function_call",
      );
      if (calls.length === 0) {
        run.emit("assistant.completed", {
          message: run.redactor.text(response.output_text),
        });
        return;
      }
      for (const call of calls) {
        const output = await this.executeTool(
          run,
          call.call_id,
          call.name,
          call.arguments,
        );
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output,
        });
      }
    }
    throw new RunnerError(
      "RUNTIME_CRASHED",
      "Direct API exceeded the maximum model-call loop",
      502,
    );
  }

  private async runChatCompletions(
    run: ActiveRun,
    client: OpenAI,
    authentication: DirectAuthentication,
  ): Promise<void> {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: this.systemPrompt(run.request) },
      ...run.request.context.map(({ role, body }) => ({ role, content: body })),
      { role: "user", content: run.request.message },
    ];
    const tools: ChatCompletionTool[] = this.availableMcpTools(run).map(
      (definition) => ({
        type: "function",
        function: {
          name: definition.providerName,
          description: definition.description,
          parameters: definition.inputSchema,
        },
      }),
    );
    for (let turn = 0; turn < MAX_MODEL_CALLS; turn += 1) {
      const stream = await client.chat.completions.create(
        {
          model: this.model(run.request),
          messages,
          ...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {}),
          stream: true,
          ...(this.profile.authentication.kind === "direct"
            ? { stream_options: { include_usage: true } }
            : {}),
          ...(authentication.providerRouting
            ? {
                provider: {
                  require_parameters:
                    authentication.providerRouting.requireParameters,
                  data_collection:
                    authentication.providerRouting.dataCollection,
                  zdr: authentication.providerRouting.zdr,
                },
              }
            : {}),
          ...(this.remainingOutputTokens(run) != null
            ? { max_tokens: this.remainingOutputTokens(run)! }
            : {}),
        },
        { signal: run.abortController.signal },
      );
      let text = "";
      let usageObserved = false;
      let rawUsage: unknown = null;
      let usageModel: string | null = null;
      let terminalReason: string | null = null;
      const calls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        if (choice?.finish_reason) terminalReason = choice.finish_reason;
        if (typeof delta?.content === "string") {
          const safe = run.redactor.text(delta.content);
          text += safe;
          run.emit("assistant.delta", { delta: safe });
        }
        for (const toolCall of delta?.tool_calls ?? []) {
          const current = calls.get(toolCall.index) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (toolCall.id) current.id = toolCall.id;
          if (toolCall.function?.name) current.name += toolCall.function.name;
          if (toolCall.function?.arguments) {
            current.arguments += toolCall.function.arguments;
          }
          calls.set(toolCall.index, current);
        }
        if (chunk.usage) {
          if (usageObserved) {
            throw new RunnerError(
              "RUNTIME_CRASHED",
              `${this.profile.providerName} emitted multiple usage records for one model call`,
              502,
            );
          }
          usageObserved = true;
          rawUsage = chunk.usage;
          usageModel = chunk.model;
        }
      }
      if (
        !usageObserved &&
        (this.hasHardBudget(run) ||
          this.profile.authentication.kind === "openrouter")
      ) {
        throw new RunnerError(
          this.hasHardBudget(run)
            ? "RUNTIME_BUDGET_UNSUPPORTED"
            : "RUNTIME_CRASHED",
          `${this.profile.providerName} omitted required model-call usage`,
          this.hasHardBudget(run) ? 409 : 502,
        );
      }
      if (usageObserved) {
        this.recordUsage(
          run,
          this.parseChatUsage(
            rawUsage,
            usageModel,
            this.profile.authentication.kind === "openrouter",
          ),
        );
      }
      if (!terminalReason) {
        throw new RunnerError(
          "RUNTIME_CRASHED",
          "OpenAI-compatible stream ended without a terminal reason",
          502,
        );
      }
      if (calls.size === 0) {
        if (terminalReason !== "stop") {
          throw new RunnerError(
            "RUNTIME_CRASHED",
            `OpenAI-compatible response ended with ${terminalReason}`,
            502,
          );
        }
        run.emit("assistant.completed", { message: text });
        return;
      }
      if (
        terminalReason !== "tool_calls" &&
        terminalReason !== "function_call"
      ) {
        throw new RunnerError(
          "RUNTIME_CRASHED",
          `OpenAI-compatible tool response ended with ${terminalReason}`,
          502,
        );
      }
      for (const call of calls.values()) {
        if (!call.id || !call.name) {
          throw new RunnerError(
            "RUNTIME_CRASHED",
            "OpenAI-compatible provider emitted an incomplete tool call",
            502,
          );
        }
      }
      const toolCalls: ChatCompletionMessageFunctionToolCall[] = [
        ...calls.values(),
      ].map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls,
      });
      for (const call of toolCalls) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: await this.executeTool(
            run,
            call.id,
            call.function.name,
            call.function.arguments,
          ),
        });
      }
    }
    throw new RunnerError(
      "RUNTIME_CRASHED",
      `${this.profile.providerName} exceeded the maximum model-call loop`,
      502,
    );
  }

  private async executeTool(
    run: ActiveRun,
    toolId: string,
    providerName: string,
    rawArguments: string,
  ): Promise<string> {
    const definition = run.mcp.get(providerName);
    if (!definition) {
      return this.rejectUndispatchedTool(run, {
        toolId,
        providerName,
        rawArguments,
        reason: "tool_not_found",
        code: "TOOL_NOT_FOUND",
        message: "Tool is unavailable.",
      });
    }
    if (
      effectiveMcpToolMode(
        definition.server,
        definition.tool,
        run.request.agent.fullAccess,
      ) === "deny"
    ) {
      return this.rejectUndispatchedTool(run, {
        toolId,
        providerName,
        rawArguments,
        definition,
        reason: "policy_denied",
        code: "TOOL_DENIED",
        message: "Tool is not available for this agent.",
      });
    }
    const parsedArguments = this.parseArguments(rawArguments);
    if (!parsedArguments.ok) {
      return this.rejectUndispatchedTool(run, {
        toolId,
        providerName,
        rawArguments,
        definition,
        reason: "invalid_arguments",
        code: "INVALID_TOOL_ARGUMENTS",
        message: "Tool arguments must be a JSON object.",
      });
    }
    const argumentsValue = parsedArguments.value;
    if (!(await this.authorizeTool(run, definition, argumentsValue))) {
      return JSON.stringify({
        error: {
          code: "APPROVAL_DENIED",
          message: "The operator denied this action.",
        },
      });
    }
    const started = new Date();
    const measurement = measurePayload(argumentsValue, run.redactor);
    const base = {
      toolId,
      runId: run.request.runId,
      kind: "mcpToolCall",
      name: providerName,
      server: definition.server.name,
      tool: definition.tool,
      startedAt: started.toISOString(),
      argumentsBytes: measurement.bytes,
      argumentsApproxTokens: measurement.approxTokens,
      ...(measurement.preview ? { argumentsPreview: measurement.preview } : {}),
    };
    run.emit("tool.started", base);
    try {
      const response = await run.mcp.call(
        definition,
        argumentsValue,
        run.abortController.signal,
      );
      const completed = new Date();
      const responseMeasurement = measurePayload(response, run.redactor);
      run.emit("tool.completed", {
        ...base,
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        responseBytes: responseMeasurement.bytes,
        responseApproxTokens: responseMeasurement.approxTokens,
        ...(responseMeasurement.preview
          ? { responsePreview: responseMeasurement.preview }
          : {}),
        success: true,
      });
      return JSON.stringify(response);
    } catch (error) {
      const completed = new Date();
      run.emit("tool.failed", {
        ...base,
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        success: false,
        reason: "provider_reported_failure",
      });
      return JSON.stringify({
        error: {
          code: "TOOL_FAILED",
          message: run.redactor.text(
            error instanceof Error ? error.message : "Tool failed.",
          ),
        },
      });
    }
  }

  private authorizeTool(
    run: ActiveRun,
    definition: DiscoveredMcpTool,
    argumentsValue: Record<string, unknown>,
  ): Promise<boolean> {
    const mode = effectiveMcpToolMode(
      definition.server,
      definition.tool,
      run.request.agent.fullAccess,
    );
    if (mode === "approve") return Promise.resolve(true);
    if (mode === "deny") return Promise.resolve(false);
    const approvalId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const measurement = measurePayload(argumentsValue, run.redactor);
      run.approvals.set(approvalId, {
        resolve: (decision) => resolve(decision === "approve"),
      });
      run.emit("approval.required", {
        approvalId,
        kind: "tool",
        command: `${definition.server.name}.${definition.tool}`,
        tool: definition.providerName,
        argumentsBytes: measurement.bytes,
        argumentsApproxTokens: measurement.approxTokens,
        ...(measurement.preview
          ? { argumentsPreview: measurement.preview }
          : {}),
        ...emailApprovalContext(
          definition.server.name,
          definition.tool,
          argumentsValue,
          run.redactor,
        ),
      });
    });
  }

  private recordUsage(
    run: ActiveRun,
    usage: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
      model: string;
      costUsd?: number | null;
    },
  ): void {
    run.callIndex += 1;
    run.inputTokens += usage.inputTokens;
    run.cachedInputTokens += usage.cachedInputTokens;
    run.outputTokens += usage.outputTokens;
    if (usage.costUsd != null) {
      run.totalCostUsd = (run.totalCostUsd ?? 0) + usage.costUsd;
    }
    const uncachedInputTokens = Math.max(
      0,
      usage.inputTokens - usage.cachedInputTokens,
    );
    run.emit("usage.updated", {
      callIndex: run.callIndex,
      usageScope: "model_call",
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheCreationInputTokens: 0,
      uncachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      model: usage.model,
      ...(usage.costUsd != null
        ? { costUsd: usage.costUsd, costSource: "provider_reported" }
        : {}),
    });
    const budget = run.request.budget;
    const totalTokens = run.inputTokens + run.outputTokens;
    if (budget?.maxTokens != null && totalTokens >= budget.maxTokens) {
      throw new RunnerError(
        "RUNTIME_BUDGET_EXCEEDED",
        `${this.profile.providerName} stopped after reaching the run token limit`,
        409,
      );
    }
    if (budget?.maxCostUsd != null) {
      const uncached = Math.max(0, run.inputTokens - run.cachedInputTokens);
      const estimatedCost = budget.pricing
        ? (uncached * budget.pricing.inputUsdPerMillion +
            run.cachedInputTokens * budget.pricing.cachedInputUsdPerMillion +
            run.outputTokens * budget.pricing.outputUsdPerMillion) /
          1_000_000
        : null;
      const cost = run.totalCostUsd ?? estimatedCost;
      if (cost === null) {
        throw new RunnerError(
          "RUNTIME_BUDGET_UNSUPPORTED",
          `${this.profile.providerName} omitted cost required for budget enforcement`,
          409,
        );
      }
      if (cost >= budget.maxCostUsd) {
        throw new RunnerError(
          "RUNTIME_BUDGET_EXCEEDED",
          `${this.profile.providerName} stopped after reaching the run cost limit`,
          409,
        );
      }
    }
  }

  private remainingOutputTokens(run: ActiveRun): number | null {
    const maximum = run.request.budget?.maxTokens;
    if (maximum == null) return null;
    return Math.max(1, maximum - run.inputTokens - run.outputTokens);
  }

  private hasHardBudget(run: ActiveRun): boolean {
    return (
      run.request.budget?.maxTokens != null ||
      run.request.budget?.maxCostUsd != null
    );
  }

  private availableMcpTools(run: ActiveRun): DiscoveredMcpTool[] {
    return run.mcp
      .definitions()
      .filter(
        (definition) =>
          effectiveMcpToolMode(
            definition.server,
            definition.tool,
            run.request.agent.fullAccess,
          ) !== "deny",
      );
  }

  private parseArguments(
    value: string,
  ): { ok: true; value: Record<string, unknown> } | { ok: false } {
    try {
      const parsed: unknown = JSON.parse(value || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ok: true, value: parsed as Record<string, unknown> }
        : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  private rejectUndispatchedTool(
    run: ActiveRun,
    input: {
      toolId: string;
      providerName: string;
      rawArguments: string;
      definition?: DiscoveredMcpTool;
      reason: "invalid_arguments" | "tool_not_found" | "policy_denied";
      code: "INVALID_TOOL_ARGUMENTS" | "TOOL_NOT_FOUND" | "TOOL_DENIED";
      message: string;
    },
  ): string {
    const started = new Date();
    const measurement = measurePayload(input.rawArguments, run.redactor);
    const base = {
      toolId: input.toolId,
      runId: run.request.runId,
      kind: "mcpToolCall",
      name: input.providerName,
      server: input.definition?.server.name ?? "unresolved",
      tool: input.definition?.tool ?? input.providerName,
      startedAt: started.toISOString(),
      argumentsBytes: measurement.bytes,
      argumentsApproxTokens: measurement.approxTokens,
      ...(measurement.preview ? { argumentsPreview: measurement.preview } : {}),
    };
    run.emit("tool.started", base);
    run.emit("tool.failed", {
      ...base,
      completedAt: started.toISOString(),
      durationMs: 0,
      success: false,
      reason: input.reason,
    });
    return JSON.stringify({
      error: { code: input.code, message: input.message },
    });
  }

  private resolvePendingApprovals(
    run: ActiveRun,
    decision: "approve" | "deny",
  ): void {
    for (const [approvalId, approval] of run.approvals) {
      approval.resolve(decision);
      run.emit("approval.resolved", { approvalId, decision });
    }
    run.approvals.clear();
  }

  private assertAuthentication(
    request: AgentExecutionRequest,
  ): DirectAuthentication {
    const authentication = request.runtime.authentication;
    if (authentication?.mode !== "api_key" || !authentication.credential) {
      throw new RunnerError(
        "RUNTIME_AUTHENTICATION_REQUIRED",
        `${this.profile.providerName} requires a configured API key`,
        401,
      );
    }
    if (this.profile.authentication.kind === "openrouter") {
      return {
        mode: "api_key",
        credential: authentication.credential,
        baseUrl: this.profile.authentication.baseUrl,
        apiFormat: "chat_completions",
        providerRouting:
          authentication.providerRouting ??
          this.profile.authentication.providerRouting,
      };
    }
    if (!authentication.baseUrl || !authentication.apiFormat) {
      throw new RunnerError(
        "RUNTIME_AUTHENTICATION_REQUIRED",
        "Direct API requires a configured endpoint and API key",
        401,
      );
    }
    return {
      mode: "api_key",
      credential: authentication.credential,
      baseUrl: authentication.baseUrl,
      apiFormat: authentication.apiFormat,
    };
  }

  private assertBudgetSupport(request: AgentExecutionRequest): void {
    if (
      this.profile.authentication.kind === "direct" &&
      request.budget?.maxCostUsd != null &&
      !request.budget.pricing
    ) {
      throw new RunnerError(
        "RUNTIME_BUDGET_UNSUPPORTED",
        "Direct API requires pricing to enforce a run cost limit",
        409,
      );
    }
  }

  private model(request: AgentExecutionRequest): string {
    if (!request.runtime.model) {
      throw new RunnerError(
        "RUNTIME_UNAVAILABLE",
        `${this.profile.providerName} requires an explicit model`,
        409,
      );
    }
    return request.runtime.model;
  }

  private systemPrompt(request: AgentExecutionRequest): string {
    return [
      `You are the Slab agent named ${request.agent.name}.`,
      `Agent identifier: ${request.agent.id}`,
      `Role: ${request.agent.role}`,
      "Follow these agent instructions:",
      request.agent.instructions,
      "Use only the capabilities exposed by this runtime and its allowed MCP servers.",
    ].join("\n\n");
  }

  private turnMessage(request: AgentExecutionRequest): string {
    if (request.context.length === 0) return request.message;
    return [
      ...request.context.map(
        ({ role, body }) => `${role.toUpperCase()}: ${body}`,
      ),
      `USER: ${request.message}`,
    ].join("\n\n");
  }

  private errorStatus(error: unknown): number | null {
    return error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status) || null
      : null;
  }

  private parseChatUsage(
    usage: unknown,
    model: string | null,
    requireCost: boolean,
  ): {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    model: string;
    costUsd: number | null;
  } {
    const record = this.recordValue(usage);
    const promptDetails = this.recordValue(record?.prompt_tokens_details);
    const completionDetails = this.recordValue(
      record?.completion_tokens_details,
    );
    const inputTokens = this.nonnegativeInteger(record?.prompt_tokens);
    const outputTokens = this.nonnegativeInteger(record?.completion_tokens);
    const cachedInputTokens =
      promptDetails?.cached_tokens === undefined
        ? 0
        : this.nonnegativeInteger(promptDetails.cached_tokens);
    const reasoningOutputTokens =
      completionDetails?.reasoning_tokens === undefined
        ? 0
        : this.nonnegativeInteger(completionDetails.reasoning_tokens);
    const rawCost = record?.cost;
    const costUsd =
      requireCost &&
      typeof rawCost === "number" &&
      Number.isFinite(rawCost) &&
      rawCost >= 0
        ? rawCost
        : null;
    if (
      !record ||
      inputTokens === null ||
      outputTokens === null ||
      cachedInputTokens === null ||
      cachedInputTokens > inputTokens ||
      reasoningOutputTokens === null ||
      reasoningOutputTokens > outputTokens ||
      !model ||
      (requireCost && costUsd === null)
    ) {
      throw new RunnerError(
        "RUNTIME_CRASHED",
        `${this.profile.providerName} returned invalid model-call usage`,
        502,
      );
    }
    return {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      model,
      costUsd,
    };
  }

  private recordValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private nonnegativeInteger(value: unknown): number | null {
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : null;
  }
}
