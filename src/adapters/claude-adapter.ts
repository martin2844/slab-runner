import { randomUUID } from "node:crypto";
import {
  query as createClaudeQuery,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AnthropicCredentialProxy } from "./anthropic-credential-proxy.js";
import type { AnthropicCredentialLease } from "./anthropic-credential-proxy.js";
import { collectHeaderSecrets, type Redactor } from "../lib/redactor.js";
import { emailApprovalContext } from "../lib/approval-context.js";
import {
  approxTokens,
  measurePayload,
  summarizeSearchTool,
} from "../lib/observability.js";
import type {
  RuntimeAdapter,
  RuntimeDefinition,
  RuntimeEventSink,
  RuntimeHealth,
  RuntimeTurnContext,
} from "../runtime/adapter.js";
import { RunnerError } from "../runtime/errors.js";
import type {
  AgentExecutionRequest,
  McpServerDefinition,
} from "../runtime/protocol.js";
import {
  effectiveMcpToolMode,
  effectiveMcpToolPolicy,
} from "../runtime/mcp-policy.js";

export type ClaudeQueryFactory = typeof createClaudeQuery;

export interface ClaudeCredentialBoundary {
  readonly ready: boolean;
  start(): Promise<void>;
  register(apiKey: string): AnthropicCredentialLease;
  stop(): Promise<void>;
}

type ToolStart = {
  startedAt: string;
  timestampMs: number;
  data: Record<string, unknown>;
  argumentsValue: unknown;
};

type PendingApproval = {
  resolve(result: PermissionResult): void;
  toolUseId: string;
};

type ActiveRun = {
  request: AgentExecutionRequest;
  emit: RuntimeEventSink;
  redactor: Redactor;
  abortController: AbortController;
  query: Query | null;
  toolStarts: Map<string, ToolStart>;
  terminalToolIds: Set<string>;
  approvals: Map<string, PendingApproval>;
  assistantText: string;
  usageCallIndex: number;
  cancelRequested: boolean;
};

export const CLAUDE_RUNTIME_DEFINITION = {
  id: "claude",
  displayName: "Claude Agent",
  stability: "experimental",
  authModes: ["api_key"],
  capabilities: {
    freshThreads: true,
    threadResume: true,
    mcpServers: true,
    // The SDK permission policy controls approval, not model-visible tool
    // discovery. Keep this false until Runner can enforce a real allowlist.
    mcpToolAllowlist: false,
    toolApprovals: true,
    toolLifecycle: true,
    runtimeWarnings: true,
    usageReporting: true,
    cancellation: true,
    modelSelection: true,
    modelDiscovery: false,
    modelValidation: false,
    contextProfiling: true,
    budgetIncrementalUsage: false,
    budgetNativeTokenLimit: false,
    budgetNativeCostLimit: true,
  },
} satisfies RuntimeDefinition;

export class ClaudeAdapter implements RuntimeAdapter {
  readonly definition = CLAUDE_RUNTIME_DEFINITION;
  readonly #runs = new Map<string, ActiveRun>();

  constructor(
    private readonly safeCwd: string,
    private readonly credentialProxy: ClaudeCredentialBoundary = new AnthropicCredentialProxy(),
    private readonly queryFactory: ClaudeQueryFactory = createClaudeQuery,
  ) {}

  async start(): Promise<void> {
    await this.credentialProxy.start();
  }

  health(signal?: AbortSignal): Promise<RuntimeHealth> {
    if (signal?.aborted) {
      return Promise.reject(
        new DOMException("The operation was aborted", "AbortError"),
      );
    }
    const checkedAt = new Date().toISOString();
    if (!this.credentialProxy.ready) {
      return Promise.resolve({
        available: false,
        status: "unavailable",
        reasonCode: "not_started",
        authentication: { status: "unknown", mode: null },
        checkedAt,
      });
    }
    return Promise.resolve({
      available: false,
      status: "authentication_required",
      reasonCode: "authentication_required",
      authentication: { status: "required", mode: "api_key" },
      checkedAt,
    });
  }

  startThread(request: AgentExecutionRequest): Promise<string> {
    return Promise.resolve().then(() => {
      this.assertAuthentication(request);
      return randomUUID();
    });
  }

  resumeThread(request: AgentExecutionRequest): Promise<string> {
    return Promise.resolve().then(() => {
      this.assertAuthentication(request);
      const runtimeThreadId = request.thread.runtimeThreadId;
      if (!runtimeThreadId) {
        throw new RunnerError(
          "THREAD_NOT_FOUND",
          "Runtime thread was not found",
          404,
        );
      }
      return runtimeThreadId;
    });
  }

  async runTurn(context: RuntimeTurnContext): Promise<void> {
    if (this.#runs.has(context.request.runId)) {
      throw new RunnerError(
        "RUN_ALREADY_EXISTS",
        "A run with this identifier already exists",
        409,
      );
    }
    if (context.request.budget?.maxTokens != null) {
      throw new RunnerError(
        "RUNTIME_BUDGET_UNSUPPORTED",
        "Claude does not provide an enforceable per-run token limit",
        409,
      );
    }
    const apiKey = this.assertAuthentication(context.request);
    const lease = this.credentialProxy.register(apiKey);
    const run: ActiveRun = {
      request: context.request,
      emit: context.emit,
      redactor: collectHeaderSecrets(
        context.request.mcpServers.map(({ headers }) => headers),
        [apiKey, lease.credential],
      ),
      abortController: new AbortController(),
      query: null,
      toolStarts: new Map(),
      terminalToolIds: new Set(),
      approvals: new Map(),
      assistantText: "",
      usageCallIndex: 0,
      cancelRequested: false,
    };
    this.#runs.set(context.request.runId, run);

    let failure: RunnerError | null = null;
    try {
      const query = this.queryFactory({
        prompt: this.buildTurnMessage(context.request),
        options: this.queryOptions(run, context.runtimeThreadId, lease),
      });
      run.query = query;
      for await (const message of query) {
        const result = this.handleMessage(run, message);
        if (result) failure = result;
      }
      if (run.cancelRequested) {
        throw new RunnerError("RUN_CANCELLED", "Run was cancelled", 409);
      }
      if (failure) throw failure;
    } catch (error) {
      if (run.cancelRequested || run.abortController.signal.aborted) {
        throw new RunnerError("RUN_CANCELLED", "Run was cancelled", 409);
      }
      if (error instanceof RunnerError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (/auth|api.?key|unauthorized|401/i.test(message)) {
        throw new RunnerError(
          "RUNTIME_AUTHENTICATION_REQUIRED",
          "Claude authentication failed",
          401,
        );
      }
      throw new RunnerError(
        "RUNTIME_CRASHED",
        "Claude runtime could not complete the run",
        502,
      );
    } finally {
      this.failOpenTools(run);
      this.resolvePendingApprovals(run, "deny");
      run.query?.close();
      lease.release();
      this.#runs.delete(context.request.runId);
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) {
      throw new RunnerError("RUN_NOT_FOUND", "Active run was not found", 404);
    }
    run.cancelRequested = true;
    this.resolvePendingApprovals(run, "deny");
    run.abortController.abort();
    try {
      await run.query?.interrupt();
    } catch {
      run.query?.close();
    }
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
    approval.resolve(
      decision === "approve"
        ? { behavior: "allow", toolUseID: approval.toolUseId }
        : {
            behavior: "deny",
            message: "The operator denied this action.",
            toolUseID: approval.toolUseId,
          },
    );
    run.emit("approval.resolved", { approvalId, decision });
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.#runs.keys()].map((runId) => this.cancelRun(runId)),
    );
    await this.credentialProxy.stop();
  }

  contextProfile(request: AgentExecutionRequest): Record<string, unknown> {
    const prompt = this.buildTurnMessage(request);
    const configuration = {
      runtime: this.definition.id,
      model: request.runtime.model,
      serverCount: request.mcpServers.length,
      servers: request.mcpServers.map(({ name, url, headers }) => ({
        name,
        url,
        headerNames: Object.keys(headers).sort(),
      })),
    };
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
        bytes: Buffer.byteLength(JSON.stringify(configuration), "utf8"),
        approxTokens: approxTokens(JSON.stringify(configuration).length),
        serverCount: request.mcpServers.length,
      },
    };
  }

  private queryOptions(
    run: ActiveRun,
    runtimeThreadId: string,
    lease: { baseUrl: string; credential: string },
  ): Options {
    const fresh = run.request.thread.runtimeThreadId === null;
    return {
      cwd: run.request.cwd ?? this.safeCwd,
      systemPrompt: this.buildSystemPrompt(run.request),
      ...(run.request.runtime.model
        ? { model: run.request.runtime.model }
        : {}),
      ...(run.request.budget?.maxCostUsd
        ? { maxBudgetUsd: run.request.budget.maxCostUsd }
        : {}),
      ...(fresh ? { sessionId: runtimeThreadId } : { resume: runtimeThreadId }),
      mcpServers: Object.fromEntries(
        run.request.mcpServers.map((server) => [
          server.name,
          {
            type: "http" as const,
            url: server.url,
            headers: server.headers,
            alwaysLoad: true,
            tools: Object.entries(server.approval?.tools ?? {}).map(
              ([name, mode]) => ({
                name,
                permission_policy:
                  mode === "approve" ? "always_allow" : "always_ask",
              }),
            ),
          },
        ]),
      ),
      strictMcpConfig: true,
      settingSources: [],
      permissionMode: "default",
      allowedTools: this.allowedTools(run.request),
      canUseTool: (toolName, input, options) =>
        this.authorizeTool(run, toolName, input, options),
      includePartialMessages: true,
      abortController: run.abortController,
      env: this.runtimeEnvironment(lease),
    };
  }

  private runtimeEnvironment(lease: {
    baseUrl: string;
    credential: string;
  }): Record<string, string | undefined> {
    const inherited = [
      "HOME",
      "PATH",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "SHELL",
      "USER",
    ];
    return {
      ...Object.fromEntries(inherited.map((key) => [key, process.env[key]])),
      ANTHROPIC_BASE_URL: lease.baseUrl,
      ANTHROPIC_API_KEY: lease.credential,
      CLAUDE_AGENT_SDK_CLIENT_APP: "slab-runner/0.1.0",
    };
  }

  private allowedTools(request: AgentExecutionRequest): string[] {
    const allowed = new Set<string>();
    for (const server of request.mcpServers) {
      const policy = effectiveMcpToolPolicy(
        server,
        request.agent.fullAccess,
      );
      if (policy.defaultMode === "approve") {
        allowed.add(`mcp__${server.name}__*`);
      }
      for (const [tool, mode] of Object.entries(policy.tools)) {
        const name = `mcp__${server.name}__${tool}`;
        if (mode === "approve") allowed.add(name);
        else allowed.delete(name);
      }
    }
    return [...allowed];
  }

  private authorizeTool(
    run: ActiveRun,
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string; title?: string },
  ): Promise<PermissionResult> {
    const target = this.mcpTarget(run.request.mcpServers, toolName);
    if (target) {
      const mode = effectiveMcpToolMode(
        target.server,
        target.tool,
        run.request.agent.fullAccess,
      );
      if (mode === "approve") {
        return Promise.resolve({
          behavior: "allow",
          toolUseID: options.toolUseID,
        });
      }
      if (mode === "deny") {
        return Promise.resolve({
          behavior: "deny",
          message: "Tool is not available for this agent.",
          toolUseID: options.toolUseID,
        });
      }
    }
    return this.requestApproval(run, toolName, input, options);
  }

  private requestApproval(
    run: ActiveRun,
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string; title?: string },
  ): Promise<PermissionResult> {
    const approvalId = randomUUID();
    const target = this.mcpTarget(run.request.mcpServers, toolName);
    return new Promise<PermissionResult>((resolve) => {
      let settled = false;
      const settle = (
        result: PermissionResult,
        decision: "approve" | "deny",
        emitted: boolean,
      ) => {
        if (settled) return;
        settled = true;
        run.approvals.delete(approvalId);
        options.signal.removeEventListener("abort", abort);
        resolve(result);
        if (emitted) {
          run.emit("approval.resolved", {
            approvalId,
            decision,
            ...(decision === "deny" ? { reason: "runtime_cancelled" } : {}),
          });
        }
      };
      const abort = () => {
        settle(
          {
            behavior: "deny",
            message: "The action was cancelled.",
            toolUseID: options.toolUseID,
          },
          "deny",
          run.approvals.has(approvalId),
        );
      };
      if (options.signal.aborted) {
        abort();
        return;
      }
      run.approvals.set(approvalId, {
        toolUseId: options.toolUseID,
        resolve: (result) => {
          settle(
            result,
            result.behavior === "allow" ? "approve" : "deny",
            false,
          );
        },
      });
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) {
        abort();
        return;
      }
      const measurement = measurePayload(input, run.redactor);
      run.emit("approval.required", {
        approvalId,
        kind: "tool",
        command: options.title ?? toolName,
        tool: toolName,
        argumentsBytes: measurement.bytes,
        argumentsApproxTokens: measurement.approxTokens,
        ...(measurement.preview
          ? { argumentsPreview: measurement.preview }
          : {}),
        ...(target
          ? emailApprovalContext(
              target.server.name,
              target.tool,
              input,
              run.redactor,
            )
          : {}),
      });
    });
  }

  private handleMessage(
    run: ActiveRun,
    message: SDKMessage,
  ): RunnerError | null {
    if (message.type === "stream_event") {
      const event = message.event as unknown as Record<string, unknown>;
      const delta = this.record(event.delta);
      if (
        event.type === "content_block_delta" &&
        delta.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        const text = run.redactor.text(delta.text);
        run.assistantText += text;
        run.emit("assistant.delta", { delta: text });
      }
      return null;
    }
    if (message.type === "assistant") {
      if (message.error) {
        run.emit("runtime.warning", {
          message: `Claude reported ${message.error.replaceAll("_", " ")}.`,
          code: message.error,
          willRetry: false,
          timestamp: new Date().toISOString(),
        });
      }
      const content = this.record(message.message).content;
      for (const block of Array.isArray(content) ? content : []) {
        const value = block as unknown as Record<string, unknown>;
        if (value.type === "tool_use") this.startTool(run, value);
      }
      return null;
    }
    if (message.type === "user") {
      const content = this.record(message.message).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const value = block as unknown as Record<string, unknown>;
          if (value.type === "tool_result") this.finishTool(run, value);
        }
      }
      return null;
    }
    if (message.type === "system" && message.subtype === "api_retry") {
      run.emit("runtime.warning", {
        message: `Claude API request will retry (${message.error.replaceAll("_", " ")}).`,
        code: message.error,
        willRetry: true,
        attempt: message.attempt,
        maxRetries: message.max_retries,
        timestamp: new Date().toISOString(),
      });
      return null;
    }
    if (message.type === "auth_status" && message.error) {
      run.emit("runtime.warning", {
        message: "Claude authentication reported an error.",
        code: "authentication_failed",
        willRetry: false,
        timestamp: new Date().toISOString(),
      });
      return new RunnerError(
        "RUNTIME_AUTHENTICATION_REQUIRED",
        "Claude authentication failed",
        401,
      );
    }
    if (message.type === "result") {
      this.emitUsage(run, message);
      if (message.is_error || message.subtype !== "success") {
        if (message.subtype === "error_max_budget_usd") {
          return new RunnerError(
            "RUNTIME_BUDGET_EXCEEDED",
            "Claude stopped after reaching the run cost limit",
            409,
          );
        }
        const details =
          message.subtype === "success"
            ? message.result
            : message.errors.join(" ");
        const apiErrorStatus =
          message.subtype === "success" ? message.api_error_status : null;
        if (
          apiErrorStatus === 401 ||
          apiErrorStatus === 403 ||
          /auth|api.?key|unauthorized|401|403/i.test(details)
        ) {
          return new RunnerError(
            "RUNTIME_AUTHENTICATION_REQUIRED",
            "Claude authentication failed",
            401,
          );
        }
        return new RunnerError(
          "RUNTIME_CRASHED",
          "Claude runtime could not complete the run",
          502,
        );
      }
      const resultText = run.redactor.text(message.result);
      run.emit("assistant.completed", {
        message: resultText || run.assistantText,
      });
    }
    return null;
  }

  private startTool(run: ActiveRun, block: Record<string, unknown>): void {
    const toolId = typeof block.id === "string" ? block.id : randomUUID();
    if (run.toolStarts.has(toolId) || run.terminalToolIds.has(toolId)) return;
    const observedAt = new Date();
    const name = typeof block.name === "string" ? block.name : "runtime_tool";
    const input = block.input ?? {};
    const target = this.mcpTarget(run.request.mcpServers, name);
    const measurement = measurePayload(input, run.redactor);
    const data: Record<string, unknown> = {
      toolId,
      runId: run.request.runId,
      kind: target ? "mcpToolCall" : "dynamicToolCall",
      name,
      server: target?.server.name ?? "runtime",
      tool: target?.tool ?? name,
      startedAt: observedAt.toISOString(),
      argumentsBytes: measurement.bytes,
      argumentsApproxTokens: measurement.approxTokens,
      ...(measurement.preview ? { argumentsPreview: measurement.preview } : {}),
    };
    run.toolStarts.set(toolId, {
      startedAt: observedAt.toISOString(),
      timestampMs: observedAt.getTime(),
      data,
      argumentsValue: input,
    });
    run.emit("tool.started", data);
  }

  private finishTool(run: ActiveRun, block: Record<string, unknown>): void {
    const toolId =
      typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    if (!toolId || run.terminalToolIds.has(toolId)) return;
    const start = run.toolStarts.get(toolId);
    if (!start) return;
    const completedAt = new Date();
    const response = block.content ?? null;
    const failed = block.is_error === true;
    const measurement = measurePayload(response, run.redactor);
    const tool =
      typeof start.data.tool === "string" ? start.data.tool : "runtime_tool";
    const summary = summarizeSearchTool(tool, start.argumentsValue, response);
    const data = {
      ...start.data,
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - start.timestampMs),
      responseBytes: measurement.bytes,
      responseApproxTokens: measurement.approxTokens,
      ...(measurement.preview ? { responsePreview: measurement.preview } : {}),
      success: !failed,
      ...(failed ? { reason: "provider_reported_failure" } : {}),
      ...(summary
        ? {
            searchQuery: summary.query,
            searchResultCount: summary.resultCount,
            searchResults: summary.results,
          }
        : {}),
    };
    run.emit(failed ? "tool.failed" : "tool.completed", data);
    run.toolStarts.delete(toolId);
    run.terminalToolIds.add(toolId);
  }

  private failOpenTools(run: ActiveRun): void {
    const completedAt = new Date();
    for (const [toolId, start] of run.toolStarts) {
      if (run.terminalToolIds.has(toolId)) continue;
      run.emit("tool.failed", {
        ...start.data,
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - start.timestampMs),
        success: false,
        status: "failed",
        reason: "terminal_event_missing",
      });
      run.terminalToolIds.add(toolId);
    }
    run.toolStarts.clear();
  }

  private emitUsage(
    run: ActiveRun,
    message: Extract<SDKMessage, { type: "result" }>,
  ): void {
    const models = Object.entries(message.modelUsage).map(([model, usage]) => ({
      model,
      provider: usage.provider ?? null,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      outputTokens: usage.outputTokens,
      contextWindow: usage.contextWindow,
      costUsd: usage.costUSD,
    }));
    const uncachedInputTokens = models.reduce(
      (total, item) => total + item.inputTokens,
      0,
    );
    const cachedInputTokens = models.reduce(
      (total, item) => total + item.cachedInputTokens,
      0,
    );
    const cacheCreationInputTokens = models.reduce(
      (total, item) => total + item.cacheCreationInputTokens,
      0,
    );
    const inputTokens =
      uncachedInputTokens + cachedInputTokens + cacheCreationInputTokens;
    const outputTokens = models.reduce(
      (total, item) => total + item.outputTokens,
      0,
    );
    run.usageCallIndex += 1;
    run.emit("usage.updated", {
      callIndex: run.usageCallIndex,
      usageScope: "run_aggregate",
      providerTurnCount: message.num_turns,
      inputTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      uncachedInputTokens: uncachedInputTokens + cacheCreationInputTokens,
      outputTokens,
      reasoningOutputTokens: 0,
      totalTokens: inputTokens + outputTokens,
      modelContextWindow:
        models.reduce(
          (maximum, item) => Math.max(maximum, item.contextWindow),
          0,
        ) || null,
      totalCostUsd: message.total_cost_usd,
      costSource: "sdk_estimated",
      durationMs: message.duration_ms,
      modelUsage: models,
    });
  }

  private resolvePendingApprovals(
    run: ActiveRun,
    decision: "approve" | "deny",
  ): void {
    for (const [approvalId, approval] of run.approvals) {
      approval.resolve(
        decision === "approve"
          ? { behavior: "allow", toolUseID: approval.toolUseId }
          : {
              behavior: "deny",
              message: "The run ended before this action was approved.",
              toolUseID: approval.toolUseId,
            },
      );
      run.emit("approval.resolved", { approvalId, decision });
    }
    run.approvals.clear();
  }

  private assertAuthentication(request: AgentExecutionRequest): string {
    const authentication = request.runtime.authentication;
    if (authentication?.mode !== "api_key" || !authentication.credential) {
      throw new RunnerError(
        "RUNTIME_AUTHENTICATION_REQUIRED",
        "Claude requires a configured Anthropic API key",
        401,
      );
    }
    return authentication.credential;
  }

  private buildSystemPrompt(request: AgentExecutionRequest): string {
    return [
      `You are the Slab agent named ${request.agent.name}.`,
      `Agent identifier: ${request.agent.id}`,
      `Role: ${request.agent.role}`,
      "Follow these agent instructions:",
      request.agent.instructions,
      "Use only the capabilities exposed by this runtime and its allowed MCP servers.",
    ].join("\n\n");
  }

  private buildTurnMessage(request: AgentExecutionRequest): string {
    if (request.context.length === 0) return request.message;
    const history = request.context
      .map(({ role, body }) => `${role.toUpperCase()}: ${body}`)
      .join("\n\n");
    return [
      "Conversation context supplied by the Slab control plane:",
      history,
      "Current user message:",
      request.message,
    ].join("\n\n");
  }

  private mcpTarget(
    servers: McpServerDefinition[],
    toolName: string,
  ): { server: McpServerDefinition; tool: string } | null {
    for (const server of servers) {
      const prefix = `mcp__${server.name}__`;
      if (toolName.startsWith(prefix)) {
        return { server, tool: toolName.slice(prefix.length) };
      }
    }
    return null;
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
