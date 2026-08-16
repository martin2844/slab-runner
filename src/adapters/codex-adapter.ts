import { randomUUID } from "node:crypto";
import type {
  AppServerConnection,
  RpcId,
  RpcNotification,
  RpcServerRequest,
} from "../app-server/connection.js";
import { collectHeaderSecrets, type Redactor } from "../lib/redactor.js";
import type {
  RuntimeAdapter,
  RuntimeEventSink,
  RuntimeHealth,
  RuntimeTurnContext,
} from "../runtime/adapter.js";
import {
  normalizeRuntimeError,
  RunnerError,
} from "../runtime/errors.js";
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

export class CodexAdapter implements RuntimeAdapter {
  readonly id = "codex";
  readonly #runs = new Map<string, ActiveRun>();
  readonly #runByThread = new Map<string, ActiveRun>();

  constructor(
    private readonly connection: AppServerConnection,
    private readonly safeCwd: string,
  ) {
    connection.on("notification", (message) => this.handleNotification(message));
    connection.on("serverRequest", (message) => this.handleServerRequest(message));
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

  private assertAvailable(): void {
    if (!this.connection.ready) {
      throw new RunnerError(
        "RUNTIME_UNAVAILABLE",
        "Codex runtime is unavailable",
        503,
      );
    }
  }

  private threadParams(request: AgentExecutionRequest): Record<string, unknown> {
    return {
      ...(request.runtime.model ? { model: request.runtime.model } : {}),
      cwd: request.cwd ?? this.safeCwd,
      approvalPolicy: "on-request",
      sandbox: "read-only",
      serviceName: "slab_runner",
      developerInstructions: this.buildDeveloperInstructions(request),
      config: this.mcpConfig(request.mcpServers),
    };
  }

  private mcpConfig(
    servers: McpServerDefinition[],
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
            default_tools_approval_mode: "auto",
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
            ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}),
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
        run.emit("usage.updated", this.safeRecord(run, params.tokenUsage));
        break;
      case "error": {
        if (params.willRetry !== true) {
          const error = this.record(params.error);
          run.lastError =
            typeof error.message === "string" ? error.message : "Runtime turn failed";
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
      if ((phase === "final_answer" || phase === null) && typeof item.text === "string") {
        run.emit("assistant.completed", {
          message: run.redactor.text(item.text),
          ...(typeof item.id === "string" ? { itemId: item.id } : {}),
        });
      }
      return;
    }
    if (typeof type !== "string" || !TOOL_ITEM_TYPES.has(type)) return;
    const data: Record<string, unknown> = {
      toolId: typeof item.id === "string" ? item.id : "unknown",
      kind: type,
      name: this.toolName(item),
      ...(typeof item.server === "string" ? { server: item.server } : {}),
      ...(typeof item.status === "string" ? { status: item.status } : {}),
      ...(typeof item.durationMs === "number"
        ? { durationMs: item.durationMs }
        : {}),
      ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    };
    run.emit(
      lifecycle === "started" ? "tool.started" : "tool.completed",
      this.safeRecord(run, data),
    );
  }

  private toolName(item: Record<string, unknown>): string {
    if (item.type === "mcpToolCall") {
      return [item.server, item.tool].filter((part) => typeof part === "string").join(".");
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
    return typeof item.type === "string" ? (names[item.type] ?? item.type) : "tool";
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
        (typeof turnError.message === "string" ? turnError.message : "Runtime turn failed");
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
        ...(typeof params.command === "string" ? { command: params.command } : {}),
        ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
        ...(typeof params.itemId === "string" ? { toolId: params.itemId } : {}),
        ...(typeof params.serverName === "string"
          ? { server: params.serverName }
          : {}),
        ...(typeof params.message === "string" ? { message: params.message } : {}),
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
    run.settled = true;
    this.#runs.delete(run.runId);
    if (this.#runByThread.get(run.threadId) === run) {
      this.#runByThread.delete(run.threadId);
    }
    run.approvals.clear();
    run.approvalsByNativeId.clear();
    if (error) run.reject(error);
    else run.resolve();
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
