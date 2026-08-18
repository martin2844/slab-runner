import { randomUUID } from "node:crypto";
import type {
  AppServerConnection,
  RpcId,
  RpcNotification,
  RpcServerRequest,
} from "../app-server/connection.js";
import { collectHeaderSecrets, type Redactor } from "../lib/redactor.js";
import {
  approxTokens,
  measurePayload,
  measureText,
  summarizeSearchTool,
} from "../lib/observability.js";
import type {
  RuntimeAdapter,
  RuntimeEventSink,
  RuntimeHealth,
  RuntimeTurnContext,
} from "../runtime/adapter.js";
import { normalizeRuntimeError, RunnerError } from "../runtime/errors.js";
import type {
  AgentExecutionRequest,
  McpServerDefinition,
} from "../runtime/protocol.js";

interface NativeApproval {
  id: string;
  nativeId: RpcId;
  method: string;
  params: Record<string, unknown>;
}

interface ActiveRun {
  runId: string;
  threadId: string;
  turnId: string | null;
  emit: RuntimeEventSink;
  redactor: Redactor;
  fullAccess: boolean;
  usageCallIndex: number;
  toolStarts: Map<
    string,
    {
      startedAt: string;
      timestampMs: number;
      data: Record<string, unknown>;
    }
  >;
  terminalToolIds: Set<string>;
  approvals: Map<string, NativeApproval>;
  approvalsByNativeId: Map<string, string>;
  resolve(): void;
  reject(error: Error): void;
  settled: boolean;
  cancelRequested: boolean;
  lastError: string | null;
}

const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]);

const READ_ONLY_MCP_TOOLS: Record<string, readonly string[]> = {
  work: [
    "list_projects",
    "get_project",
    "list_issues",
    "get_issue",
    "search_issues",
    "list_comments",
    "list_links",
    "get_blocked_issues",
    "get_issue_history",
  ],
  docs: [
    "list_docs",
    "search_docs",
    "get_doc",
    "list_doc_revisions",
    "get_doc_revision",
  ],
  posthog: ["list_projects", "query_analytics"],
};

const MCP_SERVER_ALIASES: Record<string, keyof typeof READ_ONLY_MCP_TOOLS> = {
  work: "work",
  slab: "work",
  docs: "docs",
  "slab-docs": "docs",
  posthog: "posthog",
};

export class CodexAdapter implements RuntimeAdapter {
  readonly id = "codex";
  readonly #runs = new Map<string, ActiveRun>();
  readonly #runByThread = new Map<string, ActiveRun>();
  readonly #captureFullToolPayloads =
    process.env.RUNNER_OBSERVABILITY_FULL_PAYLOADS === "true";

  constructor(
    private readonly connection: AppServerConnection,
    private readonly safeCwd: string,
  ) {
    connection.on("notification", (message) =>
      this.handleNotification(message),
    );
    connection.on("serverRequest", (message) =>
      this.handleServerRequest(message),
    );
    connection.on("crash", () => this.handleCrash());
  }

  async start(): Promise<void> {
    await this.connection.start();
  }

  health(): Promise<RuntimeHealth> {
    return Promise.resolve({ id: this.id, available: this.connection.ready });
  }

  async startThread(request: AgentExecutionRequest): Promise<string> {
    this.assertAvailable();
    const result = await this.connection.request(
      "thread/start",
      this.threadParams(request),
    );
    return this.readThreadId(result);
  }

  async resumeThread(request: AgentExecutionRequest): Promise<string> {
    this.assertAvailable();
    const threadId = request.thread.runtimeThreadId;
    if (!threadId) {
      throw new RunnerError(
        "THREAD_NOT_FOUND",
        "Runtime thread was not found",
        404,
      );
    }
    try {
      const result = await this.connection.request("thread/resume", {
        threadId,
        ...this.threadParams(request),
      });
      return this.readThreadId(result);
    } catch (error) {
      throw normalizeRuntimeError(error);
    }
  }

  async runTurn(context: RuntimeTurnContext): Promise<void> {
    this.assertAvailable();
    if (this.#runs.has(context.request.runId)) {
      throw new RunnerError(
        "RUN_ALREADY_EXISTS",
        "A run with this identifier already exists",
        409,
      );
    }
    if (this.#runByThread.has(context.runtimeThreadId)) {
      throw new RunnerError(
        "INVALID_REQUEST",
        "Runtime thread already has an active run",
        409,
      );
    }

    let complete!: () => void;
    let fail!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    const run: ActiveRun = {
      runId: context.request.runId,
      threadId: context.runtimeThreadId,
      turnId: null,
      emit: context.emit,
      redactor: collectHeaderSecrets(
        context.request.mcpServers.map(({ headers }) => headers),
      ),
      fullAccess: context.request.agent.fullAccess,
      usageCallIndex: 0,
      toolStarts: new Map(),
      terminalToolIds: new Set(),
      approvals: new Map(),
      approvalsByNativeId: new Map(),
      resolve: complete,
      reject: fail,
      settled: false,
      cancelRequested: false,
      lastError: null,
    };
    this.#runs.set(run.runId, run);
    this.#runByThread.set(run.threadId, run);

    try {
      const result = await this.connection.request("turn/start", {
        threadId: run.threadId,
        input: [
          {
            type: "text",
            text: this.buildTurnMessage(context.request),
            text_elements: [],
          },
        ],
        ...(context.request.runtime.model
          ? { model: context.request.runtime.model }
          : {}),
      });
      run.turnId = this.readTurnId(result);
      if (run.cancelRequested && !run.settled) await this.interrupt(run);
    } catch (error) {
      this.finish(run, normalizeRuntimeError(error));
    }
    return completion;
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run || run.settled) {
      throw new RunnerError("RUN_NOT_FOUND", "Active run was not found", 404);
    }
    run.cancelRequested = true;
    if (run.turnId) await this.interrupt(run);
  }

  respondToApproval(
    runId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<void> {
    const run = this.#runs.get(runId);
    const approval = run?.approvals.get(approvalId);
    if (!run || !approval) {
      throw new RunnerError(
        "APPROVAL_FAILED",
        "Pending approval was not found",
        404,
      );
    }
    try {
      this.connection.respond(
        approval.nativeId,
        this.approvalResponse(approval, decision),
      );
      run.approvals.delete(approvalId);
      run.approvalsByNativeId.delete(String(approval.nativeId));
      run.emit("approval.resolved", { approvalId, decision });
      return Promise.resolve();
    } catch {
      return Promise.reject(
        new RunnerError(
          "APPROVAL_FAILED",
          "The approval could not be sent to the runtime",
          502,
        ),
      );
    }
  }

  async shutdown(): Promise<void> {
    for (const run of this.#runs.values()) {
      this.finish(
        run,
        new RunnerError("RUN_CANCELLED", "Run was cancelled", 409),
      );
    }
    await this.connection.stop();
  }

  contextProfile(request: AgentExecutionRequest): Record<string, unknown> {
    const developerInstructions = this.buildDeveloperInstructions(request);
    const turnInput = this.buildTurnMessage(request);
    const suppliedInstructions = request.agent.instructions;
    const initialUserInput = request.message;
    const contextOnly = request.context
      .map(({ role, body }) => `${role.toUpperCase()}: ${body}`)
      .join("\n\n");
    const mcpConfiguration = this.mcpConfig(
      request.mcpServers,
      request.agent.fullAccess,
    );
    const safeConfiguration = {
      mcp_servers: Object.fromEntries(
        request.mcpServers.map(({ name, url, headers }) => [
          name,
          {
            url,
            headerNames: Object.keys(headers).sort(),
          },
        ]),
      ),
    };
    const metric = (value: string) => ({
      bytes: Buffer.byteLength(value, "utf8"),
      approxTokens: approxTokens(value.length),
    });
    const configText = JSON.stringify(mcpConfiguration);
    const safeConfigText = JSON.stringify(safeConfiguration);

    return {
      runtime: this.id,
      estimator: "characters_divided_by_4",
      developerInstructionsTotal: metric(developerInstructions),
      agentInstructionsProvided: metric(suppliedInstructions),
      runnerGeneratedInstructionsApprox: {
        bytes: Math.max(
          0,
          Buffer.byteLength(developerInstructions, "utf8") -
            Buffer.byteLength(suppliedInstructions, "utf8"),
        ),
        approxTokens: Math.max(
          0,
          approxTokens(developerInstructions.length) -
            approxTokens(suppliedInstructions.length),
        ),
      },
      turnInputTotal: metric(turnInput),
      initialUserInput: metric(initialUserInput),
      rehydratedConversationContextApprox: {
        ...metric(contextOnly),
        messageCount: request.context.length,
      },
      mcpConfiguration: {
        bytes: Buffer.byteLength(configText, "utf8"),
        approxTokens: approxTokens(configText.length),
        safeConfigurationBytes: Buffer.byteLength(safeConfigText, "utf8"),
        serverCount: request.mcpServers.length,
      },
    };
  }

  private assertAvailable(): void {
    if (!this.connection.ready) {
      throw new RunnerError(
        "RUNTIME_UNAVAILABLE",
        "Codex runtime is unavailable",
        503,
      );
    }
  }

  private threadParams(
    request: AgentExecutionRequest,
  ): Record<string, unknown> {
    return {
      ...(request.runtime.model ? { model: request.runtime.model } : {}),
      cwd: request.cwd ?? this.safeCwd,
      approvalPolicy: "on-request",
      sandbox: "read-only",
      serviceName: "slab_runner",
      developerInstructions: this.buildDeveloperInstructions(request),
      config: this.mcpConfig(request.mcpServers, request.agent.fullAccess),
    };
  }

  private mcpConfig(
    servers: McpServerDefinition[],
    fullAccess: boolean,
  ): Record<string, unknown> {
    return {
      mcp_servers: Object.fromEntries(
        servers.map(({ name, url, headers }) => [
          name,
          {
            url,
            http_headers: headers,
            enabled: true,
            required: true,
            default_tools_approval_mode: fullAccess ? "approve" : "prompt",
            ...(!fullAccess && READ_ONLY_MCP_TOOLS[name]
              ? {
                  tools: Object.fromEntries(
                    READ_ONLY_MCP_TOOLS[name].map((tool) => [
                      tool,
                      { approval_mode: "approve" },
                    ]),
                  ),
                }
              : {}),
          },
        ]),
      ),
    };
  }

  private buildDeveloperInstructions(request: AgentExecutionRequest): string {
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

  private readThreadId(result: unknown): string {
    const id = this.record(this.record(result).thread).id;
    if (typeof id !== "string" || !id) {
      throw new RunnerError(
        "UNKNOWN_RUNTIME_ERROR",
        "Codex returned an invalid thread response",
        502,
      );
    }
    return id;
  }

  private readTurnId(result: unknown): string {
    const id = this.record(this.record(result).turn).id;
    if (typeof id !== "string" || !id) {
      throw new RunnerError(
        "UNKNOWN_RUNTIME_ERROR",
        "Codex returned an invalid turn response",
        502,
      );
    }
    return id;
  }

  private handleNotification(message: RpcNotification): void {
    const params = message.params ?? {};
    if (message.method === "serverRequest/resolved") {
      this.handleServerRequestResolved(params);
      return;
    }
    const threadId = params.threadId;
    if (typeof threadId !== "string") return;
    const run = this.#runByThread.get(threadId);
    if (!run || run.settled) return;

    switch (message.method) {
      case "item/agentMessage/delta": {
        if (typeof params.delta === "string") {
          run.emit("assistant.delta", {
            delta: run.redactor.text(params.delta),
            ...(typeof params.itemId === "string"
              ? { itemId: params.itemId }
              : {}),
          });
        }
        break;
      }
      case "item/started":
        this.handleItem(run, params, "started");
        break;
      case "item/completed":
        this.handleItem(run, params, "completed");
        break;
      case "thread/tokenUsage/updated":
        this.handleUsageUpdated(run, params.tokenUsage);
        break;
      case "error": {
        const rawError = params.error;
        const error = this.record(rawError);
        const message =
          typeof error.message === "string"
            ? error.message
            : typeof rawError === "string"
              ? rawError
              : typeof params.message === "string"
                ? params.message
                : "Codex runtime reported an error.";
        run.emit(
          "runtime.warning",
          this.safeRecord(run, {
            message: message.slice(0, 500),
            ...(typeof error.code === "string" ? { code: error.code } : {}),
            ...(typeof error.type === "string" ? { type: error.type } : {}),
            willRetry: params.willRetry === true,
            timestamp: new Date().toISOString(),
            ...(typeof params.itemId === "string"
              ? { itemId: params.itemId }
              : typeof error.itemId === "string"
                ? { itemId: error.itemId }
                : {}),
          }),
        );
        if (params.willRetry !== true) {
          run.lastError =
            typeof error.message === "string"
              ? error.message
              : "Runtime turn failed";
        }
        break;
      }
      case "turn/completed":
        this.handleTurnCompleted(run, params);
        break;
    }
  }

  private handleItem(
    run: ActiveRun,
    params: Record<string, unknown>,
    lifecycle: "started" | "completed",
  ): void {
    const item = this.record(params.item);
    const type = item.type;
    if (type === "agentMessage" && lifecycle === "completed") {
      const phase = item.phase;
      if (
        (phase === "final_answer" || phase === null) &&
        typeof item.text === "string"
      ) {
        run.emit("assistant.completed", {
          message: run.redactor.text(item.text),
          ...(typeof item.id === "string" ? { itemId: item.id } : {}),
        });
      }
      return;
    }
    if (typeof type !== "string" || !TOOL_ITEM_TYPES.has(type)) return;
    const toolId = typeof item.id === "string" ? item.id : "unknown";
    const observedAt = new Date();
    if (lifecycle === "started") {
      if (run.toolStarts.has(toolId)) return;
      run.terminalToolIds.delete(toolId);
      run.toolStarts.set(toolId, {
        startedAt: observedAt.toISOString(),
        timestampMs: observedAt.getTime(),
        data: {},
      });
    } else if (run.terminalToolIds.has(toolId)) {
      return;
    }
    const trackedStart = run.toolStarts.get(toolId);
    const reportedDuration =
      typeof item.durationMs === "number" ? item.durationMs : null;
    const durationMs =
      reportedDuration ??
      (lifecycle === "completed" && trackedStart
        ? Math.max(0, observedAt.getTime() - trackedStart.timestampMs)
        : null);
    const server =
      type === "mcpToolCall" && typeof item.server === "string"
        ? item.server
        : "runtime";
    const tool = this.toolIdentifier(item);
    const argumentsValue = this.toolArguments(item);
    const responseValue = this.toolResponse(item);
    const argumentsMeasurement = measurePayload(argumentsValue, run.redactor);
    const responseMeasurement = measurePayload(responseValue, run.redactor);
    const searchSummary =
      lifecycle === "completed"
        ? summarizeSearchTool(tool, argumentsValue, responseValue)
        : null;
    const data: Record<string, unknown> = {
      toolId,
      runId: run.runId,
      kind: type,
      name: this.toolName(item),
      server,
      tool,
      ...(typeof item.status === "string" ? { status: item.status } : {}),
      startedAt:
        trackedStart?.startedAt ??
        (lifecycle === "completed" && durationMs !== null
          ? new Date(observedAt.getTime() - durationMs).toISOString()
          : observedAt.toISOString()),
      ...(lifecycle === "completed"
        ? { completedAt: observedAt.toISOString() }
        : {}),
      ...(durationMs !== null ? { durationMs } : {}),
      ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
      argumentsBytes: argumentsMeasurement.bytes,
      argumentsApproxTokens: argumentsMeasurement.approxTokens,
      ...(argumentsMeasurement.preview
        ? { argumentsPreview: argumentsMeasurement.preview }
        : {}),
      ...(this.#captureFullToolPayloads
        ? { debugArgumentsPayload: run.redactor.value(argumentsValue) }
        : {}),
      ...(lifecycle === "completed"
        ? {
            responseBytes: responseMeasurement.bytes,
            responseApproxTokens: responseMeasurement.approxTokens,
            ...(responseMeasurement.preview
              ? { responsePreview: responseMeasurement.preview }
              : {}),
            success: this.toolSucceeded(item),
            ...(searchSummary
              ? {
                  searchQuery: searchSummary.query,
                  searchResultCount: searchSummary.resultCount,
                  searchResults: searchSummary.results,
                }
              : {}),
            ...(this.#captureFullToolPayloads
              ? { debugResponsePayload: run.redactor.value(responseValue) }
              : {}),
          }
        : {}),
    };
    if (type === "commandExecution") {
      const command = typeof item.command === "string" ? item.command : "";
      const output =
        typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
      const commandMeasurement = measureText(command, run.redactor);
      const outputMeasurement = measureText(output, run.redactor);
      Object.assign(data, {
        command: commandMeasurement.preview,
        commandBytes: commandMeasurement.bytes,
        commandApproxTokens: commandMeasurement.approxTokens,
        outputBytes: outputMeasurement.bytes,
        outputApproxTokens: outputMeasurement.approxTokens,
        ...(lifecycle === "completed" && outputMeasurement.preview
          ? { outputPreview: outputMeasurement.preview }
          : {}),
        stdoutBytes: null,
        stderrBytes: null,
        stdoutApproxTokens: null,
        stderrApproxTokens: null,
        streamBreakdownAvailable: false,
      });
    }
    const safeData = this.safeRecord(run, data);
    if (lifecycle === "started" && trackedStart) trackedStart.data = safeData;
    run.emit(
      lifecycle === "started" ? "tool.started" : "tool.completed",
      safeData,
    );
    if (lifecycle === "completed") {
      run.toolStarts.delete(toolId);
      run.terminalToolIds.add(toolId);
    }
  }

  private handleUsageUpdated(run: ActiveRun, value: unknown): void {
    const usage = this.safeRecord(run, value);
    const last = this.record(usage.last);
    const inputTokens = this.number(last.inputTokens);
    const cachedInputTokens = this.number(last.cachedInputTokens);
    run.usageCallIndex += 1;
    run.emit("usage.updated", {
      ...usage,
      callIndex: run.usageCallIndex,
      inputTokens,
      cachedInputTokens,
      uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
      outputTokens: this.number(last.outputTokens),
      reasoningOutputTokens: this.number(last.reasoningOutputTokens),
      totalTokens: this.number(last.totalTokens),
      modelContextWindow:
        typeof usage.modelContextWindow === "number"
          ? usage.modelContextWindow
          : null,
    });
  }

  private toolIdentifier(item: Record<string, unknown>): string {
    if (item.type === "commandExecution") return "shell";
    if (typeof item.tool === "string") return item.tool;
    return this.toolName(item);
  }

  private toolArguments(item: Record<string, unknown>): unknown {
    if (item.type === "commandExecution") return item.command ?? "";
    if ("arguments" in item) return item.arguments;
    return null;
  }

  private toolResponse(item: Record<string, unknown>): unknown {
    if (item.type === "commandExecution") return item.aggregatedOutput ?? "";
    if (item.type === "mcpToolCall") return item.result ?? item.error ?? null;
    if (item.type === "dynamicToolCall") return item.contentItems ?? null;
    return null;
  }

  private toolSucceeded(item: Record<string, unknown>): boolean {
    if (item.type === "commandExecution") {
      return item.status === "completed" && item.exitCode === 0;
    }
    if (typeof item.success === "boolean") return item.success;
    return item.status === "completed" && !item.error;
  }

  private number(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  private toolName(item: Record<string, unknown>): string {
    if (item.type === "mcpToolCall") {
      return [item.server, item.tool]
        .filter((part) => typeof part === "string")
        .join(".");
    }
    if (typeof item.tool === "string") return item.tool;
    const names: Record<string, string> = {
      commandExecution: "shell",
      fileChange: "file_change",
      webSearch: "web_search",
      imageView: "image_view",
      imageGeneration: "image_generation",
      collabAgentToolCall: "agent_collaboration",
    };
    return typeof item.type === "string"
      ? (names[item.type] ?? item.type)
      : "tool";
  }

  private handleTurnCompleted(
    run: ActiveRun,
    params: Record<string, unknown>,
  ): void {
    const turn = this.record(params.turn);
    const status = turn.status;
    if (status === "completed") this.finish(run);
    else if (status === "interrupted" || run.cancelRequested) {
      this.finish(
        run,
        new RunnerError("RUN_CANCELLED", "Run was cancelled", 409),
      );
    } else {
      const turnError = this.record(turn.error);
      const message =
        run.lastError ??
        (typeof turnError.message === "string"
          ? turnError.message
          : "Runtime turn failed");
      this.finish(run, normalizeRuntimeError(new Error(message)));
    }
  }

  private handleServerRequest(message: RpcServerRequest): void {
    const params = message.params ?? {};
    if (message.method === "currentTime/read") {
      this.connection.respond(message.id, {
        currentTimeAt: Math.floor(Date.now() / 1_000),
      });
      return;
    }
    const threadId = params.threadId;
    if (typeof threadId !== "string") return;
    const run = this.#runByThread.get(threadId);
    if (!run || run.settled) return;
    if (
      ![
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "mcpServer/elicitation/request",
      ].includes(message.method)
    ) {
      return;
    }

    const autoApprovedTool = this.autoApprovedMcpTool(message, run.fullAccess);
    if (autoApprovedTool) {
      this.connection.respond(message.id, {
        action: "accept",
        content: null,
        _meta: null,
      });
      run.emit("approval.resolved", {
        decision: "auto",
        kind: "mcp_elicitation",
        server: autoApprovedTool.server,
        tool: autoApprovedTool.tool,
      });
      return;
    }

    const approvalId = randomUUID();
    const approval: NativeApproval = {
      id: approvalId,
      nativeId: message.id,
      method: message.method,
      params,
    };
    run.approvals.set(approvalId, approval);
    run.approvalsByNativeId.set(String(message.id), approvalId);
    run.emit(
      "approval.required",
      this.safeRecord(run, {
        approvalId,
        kind: this.approvalKind(message.method),
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        ...(typeof params.command === "string"
          ? { command: params.command }
          : {}),
        ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
        ...(typeof params.itemId === "string" ? { toolId: params.itemId } : {}),
        ...(typeof params.serverName === "string"
          ? { server: params.serverName }
          : {}),
        ...(typeof params.message === "string"
          ? { message: params.message }
          : {}),
      }),
    );
  }

  private handleServerRequestResolved(params: Record<string, unknown>): void {
    const threadId = params.threadId;
    if (typeof threadId !== "string") return;
    const run = this.#runByThread.get(threadId);
    if (!run || !this.isRpcId(params.requestId)) return;
    const nativeId = String(params.requestId);
    const approvalId = run.approvalsByNativeId.get(nativeId);
    if (!approvalId) return;
    run.approvalsByNativeId.delete(nativeId);
    run.approvals.delete(approvalId);
    run.emit("approval.resolved", {
      approvalId,
      decision: "runtime",
    });
  }

  private approvalKind(method: string): string {
    if (method.includes("commandExecution")) return "command";
    if (method.includes("fileChange")) return "file_change";
    if (method.includes("permissions")) return "permissions";
    return "mcp_elicitation";
  }

  private autoApprovedMcpTool(
    message: RpcServerRequest,
    fullAccess: boolean,
  ): { server: string; tool: string } | null {
    if (message.method !== "mcpServer/elicitation/request") return null;
    const params = message.params ?? {};
    const server = params.serverName;
    const prompt = params.message;
    if (typeof server !== "string" || typeof prompt !== "string") return null;
    const serverKind = MCP_SERVER_ALIASES[server];
    if (!serverKind) return null;
    const readOnlyTools = READ_ONLY_MCP_TOOLS[serverKind];
    if (!readOnlyTools) return null;
    const match = /^Allow the [^\n]+ MCP server to run tool "([^"]+)"\?$/.exec(
      prompt,
    );
    const tool = match?.[1];
    if (!tool || (!fullAccess && !readOnlyTools.includes(tool))) return null;
    return { server, tool };
  }

  private approvalResponse(
    approval: NativeApproval,
    decision: "approve" | "deny",
  ): Record<string, unknown> {
    if (approval.method === "item/permissions/requestApproval") {
      const requested = this.record(approval.params.permissions);
      return {
        permissions:
          decision === "approve"
            ? {
                ...(requested.network ? { network: requested.network } : {}),
                ...(requested.fileSystem
                  ? { fileSystem: requested.fileSystem }
                  : {}),
              }
            : {},
        scope: "turn",
      };
    }
    if (approval.method === "mcpServer/elicitation/request") {
      return {
        action: decision === "approve" ? "accept" : "decline",
        content: null,
        _meta: null,
      };
    }
    return { decision: decision === "approve" ? "accept" : "decline" };
  }

  private async interrupt(run: ActiveRun): Promise<void> {
    if (!run.turnId) return;
    try {
      await this.connection.request("turn/interrupt", {
        threadId: run.threadId,
        turnId: run.turnId,
      });
    } catch (error) {
      if (!run.settled) throw normalizeRuntimeError(error);
    }
  }

  private handleCrash(): void {
    for (const run of [...this.#runs.values()]) {
      this.finish(
        run,
        new RunnerError("RUNTIME_CRASHED", "Codex runtime crashed", 502),
      );
    }
  }

  private finish(run: ActiveRun, error?: Error): void {
    if (run.settled) return;
    this.failOpenTools(run);
    run.settled = true;
    this.#runs.delete(run.runId);
    if (this.#runByThread.get(run.threadId) === run) {
      this.#runByThread.delete(run.threadId);
    }
    run.approvals.clear();
    run.approvalsByNativeId.clear();
    run.terminalToolIds.clear();
    if (error) run.reject(error);
    else run.resolve();
  }

  private failOpenTools(run: ActiveRun): void {
    const completedAt = new Date();
    for (const [toolId, started] of [...run.toolStarts]) {
      run.toolStarts.delete(toolId);
      run.terminalToolIds.add(toolId);
      run.emit(
        "tool.failed",
        this.safeRecord(run, {
          ...started.data,
          toolId,
          runId: run.runId,
          status: "failed",
          success: false,
          reason: "terminal_event_missing",
          startedAt: started.startedAt,
          completedAt: completedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - started.timestampMs),
        }),
      );
    }
  }

  private safeRecord(run: ActiveRun, value: unknown): Record<string, unknown> {
    const redacted = run.redactor.value(value);
    return this.record(redacted);
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private isRpcId(value: unknown): value is RpcId {
    return typeof value === "string" || typeof value === "number";
  }
}
