import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { constants as fsConstants } from "node:fs";
import { approxTokens, measurePayload } from "../lib/observability.js";
import { collectHeaderSecrets, type Redactor } from "../lib/redactor.js";
import type {
  RuntimeAdapter,
  RuntimeDefinition,
  RuntimeEventSink,
  RuntimeHealth,
  RuntimeTurnContext,
} from "../runtime/adapter.js";
import {
  isMcpFailureMessage,
  isThreadNotFoundMessage,
  RunnerError,
} from "../runtime/errors.js";
import type {
  AgentExecutionRequest,
  McpServerDefinition,
} from "../runtime/protocol.js";
import { effectiveMcpToolPolicy } from "../runtime/mcp-policy.js";

const MAX_JSONL_LINE_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 16_384;
const TERMINATE_GRACE_MS = 2_000;

export interface GeminiProcess {
  stdout: Readable;
  stderr: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type GeminiProcessFactory = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
) => GeminiProcess;

type GeminiAuthProbe = (geminiHome: string) => Promise<boolean>;

type ToolStart = {
  startedAt: string;
  timestampMs: number;
  data: Record<string, unknown>;
  argumentsValue: unknown;
};

type ActiveRun = {
  request: AgentExecutionRequest;
  emit: RuntimeEventSink;
  process: GeminiProcess;
  redactor: Redactor;
  toolStarts: Map<string, ToolStart>;
  terminalToolIds: Set<string>;
  assistantText: string;
  sawResult: boolean;
  resultFailed: boolean;
  terminalError: { type: string; message: string } | null;
  mcpStartupFailed: boolean;
  cancelRequested: boolean;
  terminationTimer: NodeJS.Timeout | null;
  stderr: string;
  serverAliases: Map<string, string>;
};

type JsonRecord = Record<string, unknown>;

export const GEMINI_RUNTIME_DEFINITION = {
  id: "gemini",
  displayName: "Gemini CLI",
  stability: "experimental",
  authModes: ["oauth"],
  capabilities: {
    freshThreads: true,
    threadResume: true,
    mcpServers: true,
    mcpToolAllowlist: true,
    // Gemini headless mode cannot pause and round-trip a Slab approval. Tools
    // configured as prompt are omitted from discovery for this adapter.
    toolApprovals: false,
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
    budgetNativeCostLimit: false,
  },
} satisfies RuntimeDefinition;

function defaultProcessFactory(
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): GeminiProcess {
  return spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as GeminiProcess;
}

async function defaultAuthProbe(geminiHome: string): Promise<boolean> {
  const directory = join(geminiHome, ".gemini");
  const credentials = join(directory, "oauth_creds.json");
  const settings = join(directory, "settings.json");
  try {
    const [credentialStat, rawSettings] = await Promise.all([
      stat(credentials),
      readFile(settings, "utf8"),
    ]);
    if (!credentialStat.isFile() || credentialStat.size === 0) return false;
    const parsed = JSON.parse(rawSettings) as JsonRecord;
    const security = record(parsed.security);
    const auth = record(security.auth);
    return (
      auth.selectedType === "oauth-personal" ||
      parsed.selectedAuthType === "oauth-personal"
    );
  } catch {
    return false;
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function safeServerAlias(
  index: number,
  name: string,
  usedAliases: Set<string>,
): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const preferred = /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)
    ? name
    : `slab-${index + 1}-${normalized || "server"}`;
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 8);
  const boundedPreferred =
    preferred.length <= 25 ? preferred : `slab-${index + 1}-${suffix}`;
  if (!usedAliases.has(boundedPreferred)) {
    usedAliases.add(boundedPreferred);
    return boundedPreferred;
  }
  for (let attempt = 1; attempt <= usedAliases.size + 1; attempt += 1) {
    const attemptHash = createHash("sha256")
      .update(`${name}\0${attempt}`)
      .digest("hex")
      .slice(0, 6);
    const candidate = `s${String(index + 1).slice(-4)}-${attempt.toString(36)}-${attemptHash}`;
    if (usedAliases.has(candidate)) continue;
    usedAliases.add(candidate);
    return candidate;
  }
  throw new RunnerError(
    "INVALID_REQUEST",
    "MCP server names could not be represented uniquely for Gemini CLI",
    400,
  );
}

function allowedTools(
  server: McpServerDefinition,
  fullAccess: boolean,
): {
  includeTools?: string[];
  excludeTools?: string[];
} {
  const approval = effectiveMcpToolPolicy(server, fullAccess);
  const entries = Object.entries(approval.tools);
  if (approval.defaultMode !== "approve") {
    return {
      includeTools: entries
        .filter(([, mode]) => mode === "approve")
        .map(([tool]) => tool),
    };
  }
  const excluded = entries
    .filter(([, mode]) => mode !== "approve")
    .map(([tool]) => tool);
  return excluded.length > 0 ? { excludeTools: excluded } : {};
}

function buildPrompt(request: AgentExecutionRequest): string {
  const context = request.context
    .map(({ role, body }) => `${role.toUpperCase()}: ${body}`)
    .join("\n\n");
  return [
    "System instructions:",
    request.agent.instructions,
    ...(context ? ["Conversation context:", context] : []),
    "Current user input:",
    request.message,
    "Use only the MCP capabilities exposed for this run.",
  ].join("\n\n");
}

function buildPolicy(serverAliases: Iterable<string>): string {
  const rules = [
    "[[rule]]",
    'toolName = "*"',
    'decision = "deny"',
    "priority = 900",
    'denyMessage = "Only run-scoped MCP tools are available in Slab."',
  ];
  for (const alias of serverAliases) {
    rules.push(
      "",
      "[[rule]]",
      `mcpName = ${JSON.stringify(alias)}`,
      'decision = "allow"',
      "priority = 950",
    );
  }
  return `${rules.join("\n")}\n`;
}

export class GeminiAdapter implements RuntimeAdapter {
  readonly definition = GEMINI_RUNTIME_DEFINITION;
  readonly #runs = new Map<string, ActiveRun>();
  readonly #initializingRuns = new Set<string>();
  readonly #initializationCancellations = new Set<string>();
  readonly #initializationControllers = new Map<string, AbortController>();
  readonly #turns = new Map<string, Promise<void>>();
  #binaryAvailable = false;
  #shuttingDown = false;

  constructor(
    private readonly safeCwd: string,
    private readonly geminiHome: string,
    private readonly geminiBin = "gemini",
    private readonly processFactory: GeminiProcessFactory = defaultProcessFactory,
    private readonly authProbe: GeminiAuthProbe = defaultAuthProbe,
  ) {}

  async start(): Promise<void> {
    this.#shuttingDown = false;
    await mkdir(this.geminiHome, { recursive: true, mode: 0o700 });
    await this.probeBinary();
    this.#binaryAvailable = true;
  }

  async health(signal?: AbortSignal): Promise<RuntimeHealth> {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    const checkedAt = new Date().toISOString();
    if (!this.#binaryAvailable) {
      return {
        available: false,
        status: "unavailable",
        reasonCode: "not_started",
        authentication: { status: "unknown", mode: null },
        checkedAt,
      };
    }
    const authenticated = await this.probeAuthentication(signal);
    return authenticated
      ? {
          available: true,
          status: "available",
          reasonCode: "ready",
          authentication: { status: "authenticated", mode: "oauth" },
          checkedAt,
        }
      : {
          available: false,
          status: "authentication_required",
          reasonCode: "authentication_required",
          authentication: { status: "required", mode: "oauth" },
          checkedAt,
        };
  }

  startThread(request: AgentExecutionRequest): Promise<string> {
    void request;
    return Promise.resolve(randomUUID());
  }

  resumeThread(request: AgentExecutionRequest): Promise<string> {
    if (!request.thread.runtimeThreadId) {
      throw new RunnerError(
        "INVALID_REQUEST",
        "Gemini runtime thread ID is required to resume a session",
        400,
      );
    }
    return Promise.resolve(request.thread.runtimeThreadId);
  }

  runTurn(context: RuntimeTurnContext): Promise<void> {
    if (this.#shuttingDown) {
      return Promise.reject(
        new RunnerError(
          "RUNTIME_UNAVAILABLE",
          "Gemini CLI is shutting down",
          503,
        ),
      );
    }
    const runId = context.request.runId;
    const turn = this.executeTurn(context).finally(() => {
      this.#turns.delete(runId);
    });
    this.#turns.set(runId, turn);
    return turn;
  }

  private async executeTurn(context: RuntimeTurnContext): Promise<void> {
    const runId = context.request.runId;
    const initializationController = new AbortController();
    this.#initializationControllers.set(runId, initializationController);
    this.#initializingRuns.add(runId);
    let runtimeDirectory: string | null = null;
    try {
      let authenticated: boolean;
      try {
        authenticated = await this.probeAuthentication(
          initializationController.signal,
        );
      } catch (error) {
        if (initializationController.signal.aborted) {
          throw new RunnerError("RUN_CANCELLED", "Run was cancelled", 409);
        }
        throw error;
      }
      if (!authenticated) {
        throw new RunnerError(
          "RUNTIME_AUTHENTICATION_REQUIRED",
          "Gemini CLI is not authenticated",
          401,
        );
      }
      this.throwIfInitializationCancelled(runId);
      if (context.request.budget?.maxTokens != null) {
        throw new RunnerError(
          "RUNTIME_BUDGET_UNSUPPORTED",
          "Gemini CLI cannot enforce a hard token limit before execution",
          409,
        );
      }
      if (context.request.budget?.maxCostUsd != null) {
        throw new RunnerError(
          "RUNTIME_BUDGET_UNSUPPORTED",
          "Gemini CLI cannot enforce a hard cost limit before execution",
          409,
        );
      }

      runtimeDirectory = await mkdtemp(join(tmpdir(), "slab-gemini-"));
      this.throwIfInitializationCancelled(runId);
      await access(runtimeDirectory, fsConstants.W_OK);
      const settingsFile = join(runtimeDirectory, "settings.json");
      const policyFile = join(runtimeDirectory, "policy.toml");
      const serverAliases = new Map<string, string>();
      const usedAliases = new Set<string>();
      const mcpServers: Record<string, JsonRecord> = {};
      context.request.mcpServers.forEach((server, index) => {
        const toolAccess = allowedTools(
          server,
          context.request.agent.fullAccess,
        );
        if (toolAccess.includeTools?.length === 0) return;
        const alias = safeServerAlias(index, server.name, usedAliases);
        serverAliases.set(server.name, alias);
        mcpServers[alias] = {
          httpUrl: server.url,
          headers: server.headers,
          trust: true,
          timeout: 60_000,
          ...toolAccess,
        };
      });
      const allowedAliases =
        serverAliases.size > 0
          ? [...serverAliases.values()]
          : [`slab-empty-${context.runtimeThreadId.slice(0, 36)}`];
      await writeFile(
        settingsFile,
        JSON.stringify({
          mcpServers,
          mcp: { allowed: allowedAliases },
          tools: { core: [] },
          security: {
            disableYoloMode: true,
            disableAlwaysAllow: true,
            folderTrust: { enabled: false },
          },
          telemetry: { enabled: false },
          useWriteTodos: false,
        }),
        { mode: 0o600 },
      );
      this.throwIfInitializationCancelled(runId);
      await writeFile(policyFile, buildPolicy(serverAliases.values()), {
        mode: 0o600,
      });
      this.throwIfInitializationCancelled(runId);

      const redactor = collectHeaderSecrets(
        context.request.mcpServers.map(({ headers }) => headers),
      );
      const args = [
        "--output-format",
        "stream-json",
        "--approval-mode",
        "default",
        "--admin-policy",
        policyFile,
        "--skip-trust",
        ...(context.request.runtime.model
          ? ["--model", context.request.runtime.model]
          : []),
        ...allowedAliases.flatMap((alias) => [
          "--allowed-mcp-server-names",
          alias,
        ]),
        ...(context.request.thread.runtimeThreadId
          ? ["--resume", context.runtimeThreadId]
          : ["--session-id", context.runtimeThreadId]),
        "--prompt",
        buildPrompt(context.request),
      ];
      let child: GeminiProcess;
      try {
        child = this.processFactory(this.geminiBin, args, {
          cwd: context.request.cwd ?? this.safeCwd,
          env: {
            ...process.env,
            GEMINI_CLI_HOME: this.geminiHome,
            GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile,
            GEMINI_CLI_TRUST_WORKSPACE: "true",
            NO_BROWSER: "true",
          },
        });
      } catch {
        throw new RunnerError(
          "RUNTIME_CRASHED",
          "Gemini CLI process could not start",
          502,
        );
      }
      const run: ActiveRun = {
        request: context.request,
        emit: context.emit,
        process: child,
        redactor,
        toolStarts: new Map(),
        terminalToolIds: new Set(),
        assistantText: "",
        sawResult: false,
        resultFailed: false,
        terminalError: null,
        mcpStartupFailed: false,
        cancelRequested: false,
        terminationTimer: null,
        stderr: "",
        serverAliases,
      };
      this.#runs.set(runId, run);
      this.#initializingRuns.delete(runId);
      try {
        await this.consume(run);
      } finally {
        if (run.terminationTimer) clearTimeout(run.terminationTimer);
        this.failOpenTools(run);
        this.#runs.delete(runId);
      }
    } finally {
      this.#initializingRuns.delete(runId);
      this.#initializationCancellations.delete(runId);
      this.#initializationControllers.delete(runId);
      if (runtimeDirectory) {
        await rm(runtimeDirectory, { recursive: true, force: true });
      }
    }
  }

  cancelRun(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) {
      if (this.#initializingRuns.has(runId)) {
        this.#initializationCancellations.add(runId);
        this.#initializationControllers.get(runId)?.abort();
      }
      return Promise.resolve();
    }
    if (run.cancelRequested) return Promise.resolve();
    run.cancelRequested = true;
    this.terminate(run);
    return Promise.resolve();
  }

  respondToApproval(): Promise<void> {
    return Promise.reject(
      new RunnerError(
        "INVALID_REQUEST",
        "Gemini CLI headless runs do not expose interactive approvals",
        404,
      ),
    );
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    for (const runId of this.#initializingRuns) {
      this.#initializationCancellations.add(runId);
      this.#initializationControllers.get(runId)?.abort();
    }
    await Promise.allSettled(
      [...this.#runs.keys()].map((runId) => this.cancelRun(runId)),
    );
    await Promise.allSettled([...this.#turns.values()]);
    this.#binaryAvailable = false;
  }

  contextProfile(request: AgentExecutionRequest): Record<string, unknown> {
    const prompt = buildPrompt(request);
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
      configuration: {
        runtime: this.definition.id,
        model: request.runtime.model,
        serverCount: request.mcpServers.length,
        servers: request.mcpServers.map(({ name, url, headers }) => ({
          name,
          url,
          headerNames: Object.keys(headers).sort(),
        })),
      },
    };
  }

  private async probeBinary(): Promise<void> {
    const child = this.processFactory(this.geminiBin, ["--version"], {
      cwd: this.safeCwd,
      env: { ...process.env, GEMINI_CLI_HOME: this.geminiHome },
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", () =>
        reject(
          new RunnerError(
            "RUNTIME_UNAVAILABLE",
            "Gemini CLI executable is unavailable",
            503,
          ),
        ),
      );
      child.once("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new RunnerError(
              "RUNTIME_UNAVAILABLE",
              "Gemini CLI executable is unavailable",
              503,
            ),
          );
      });
    });
  }

  private throwIfInitializationCancelled(runId: string): void {
    if (this.#initializationCancellations.has(runId)) {
      throw new RunnerError("RUN_CANCELLED", "Run was cancelled", 409);
    }
  }

  private async probeAuthentication(signal?: AbortSignal): Promise<boolean> {
    if (!signal) return this.authProbe(this.geminiHome);
    if (signal.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    return await new Promise<boolean>((resolve, reject) => {
      const abort = () =>
        reject(new DOMException("The operation was aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      this.authProbe(this.geminiHome).then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", abort);
      });
    });
  }

  private terminate(run: ActiveRun): void {
    run.process.kill("SIGTERM");
    if (run.terminationTimer) return;
    const process = run.process;
    run.terminationTimer = setTimeout(
      () => process.kill("SIGKILL"),
      TERMINATE_GRACE_MS,
    );
    run.terminationTimer.unref();
  }

  private async consume(run: ActiveRun): Promise<void> {
    let buffer = "";
    const protocol = { error: null as RunnerError | null };
    run.process.stdout.setEncoding("utf8");
    run.process.stderr.setEncoding("utf8");
    run.process.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_JSONL_LINE_BYTES) {
        protocol.error = new RunnerError(
          "RUNTIME_CRASHED",
          "Gemini CLI emitted an oversized protocol event",
          502,
        );
        this.terminate(run);
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            this.handleLine(run, line);
          } catch (error) {
            protocol.error =
              error instanceof RunnerError
                ? error
                : new RunnerError(
                    "RUNTIME_CRASHED",
                    "Gemini CLI emitted invalid structured output",
                    502,
                  );
            this.terminate(run);
            return;
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    run.process.stderr.on("data", (chunk: string) => {
      if (run.stderr.length >= MAX_STDERR_BYTES) return;
      run.stderr = `${run.stderr}${chunk}`.slice(0, MAX_STDERR_BYTES);
    });

    const exit = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        run.process.once("error", reject);
        run.process.once("close", (code, signal) => resolve({ code, signal }));
      },
    ).catch((error: unknown) => {
      throw new RunnerError(
        "RUNTIME_CRASHED",
        "Gemini CLI process could not start",
        502,
        { cause: error instanceof Error ? error.message : "process_error" },
      );
    });
    if (protocol.error) throw protocol.error;
    if (buffer.trim()) this.handleLine(run, buffer.trim());
    if (run.cancelRequested || exit.signal === "SIGTERM" || exit.signal === "SIGKILL") {
      throw new RunnerError("RUN_CANCELLED", "Run was cancelled", 409);
    }
    const safeStderr = run.redactor.text(run.stderr);
    if (!run.sawResult || exit.code !== 0 || run.resultFailed) {
      const terminalDiagnostic = [
        run.terminalError?.type ?? "",
        run.terminalError?.message ?? "",
        safeStderr,
      ].join(" ");
      const authenticationFailure =
        /auth|sign.?in|login|credential|unauthorized|token.*(?:expired|revoked)|401|403/i.test(
          terminalDiagnostic,
        );
      const terminalAuthenticationFailure =
        /auth|sign.?in|login|credential|unauthorized|token.*(?:expired|revoked)|401|403/i.test(
          `${run.terminalError?.type ?? ""} ${run.terminalError?.message ?? ""}`,
        );
      if (terminalAuthenticationFailure) {
        throw new RunnerError(
          "RUNTIME_AUTHENTICATION_REQUIRED",
          "Gemini CLI authentication is required",
          401,
        );
      }
      if (
        isThreadNotFoundMessage(terminalDiagnostic) ||
        /session.*(?:not found|does not exist|missing|unknown)/i.test(
          terminalDiagnostic,
        ) ||
        /no (?:previous )?sessions? found|invalid session (?:id|identifier)/i.test(
          terminalDiagnostic,
        )
      ) {
        throw new RunnerError(
          "THREAD_NOT_FOUND",
          "Runtime thread was not found",
          404,
        );
      }
      if (
        isMcpFailureMessage(terminalDiagnostic) ||
        /MCP issues detected/i.test(terminalDiagnostic)
      ) {
        throw new RunnerError(
          "MCP_CONNECTION_FAILED",
          "An allowed MCP server could not be reached",
          502,
        );
      }
      throw new RunnerError(
        authenticationFailure
          ? "RUNTIME_AUTHENTICATION_REQUIRED"
          : "RUNTIME_CRASHED",
        authenticationFailure
          ? "Gemini CLI authentication is required"
          : "Gemini CLI could not complete the run",
        authenticationFailure ? 401 : 502,
      );
    }
    if (
      run.serverAliases.size > 0 &&
      (run.mcpStartupFailed || /MCP issues detected/i.test(safeStderr))
    ) {
      throw new RunnerError(
        "MCP_CONNECTION_FAILED",
        "An allowed MCP server could not be reached",
        502,
      );
    }
    run.emit("assistant.completed", { message: run.assistantText });
  }

  private handleLine(run: ActiveRun, line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) {
      throw new RunnerError(
        "RUNTIME_CRASHED",
        "Gemini CLI emitted an oversized protocol event",
        502,
      );
    }
    let event: JsonRecord;
    try {
      event = record(JSON.parse(line));
    } catch {
      throw new RunnerError(
        "RUNTIME_CRASHED",
        "Gemini CLI emitted invalid structured output",
        502,
      );
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "message" && event.role === "assistant") {
      const content =
        typeof event.content === "string" ? run.redactor.text(event.content) : "";
      if (content) {
        run.assistantText += content;
        run.emit("assistant.delta", { delta: content });
      }
      return;
    }
    if (type === "tool_use") {
      this.startTool(run, event);
      return;
    }
    if (type === "tool_result") {
      this.finishTool(run, event);
      return;
    }
    if (type === "error") {
      const warningMessage =
        typeof event.message === "string"
          ? run.redactor.text(event.message)
          : "Gemini CLI reported a runtime warning.";
      const warningCode = typeof event.code === "string" ? event.code : null;
      const willRetry =
        typeof event.willRetry === "boolean"
          ? event.willRetry
          : event.will_retry === true;
      if (
        !willRetry &&
        (isMcpFailureMessage(`${warningCode ?? ""} ${warningMessage}`) ||
          /MCP issues detected/i.test(warningMessage))
      ) {
        run.mcpStartupFailed = true;
      }
      run.emit("runtime.warning", {
        message: warningMessage,
        code: warningCode,
        severity: event.severity === "error" ? "error" : "warning",
        willRetry,
        timestamp:
          typeof event.timestamp === "string"
              ? event.timestamp
              : new Date().toISOString(),
        ...(typeof event.tool_id === "string"
          ? { toolId: event.tool_id }
          : {}),
      });
      return;
    }
    if (type === "result") {
      run.sawResult = true;
      run.resultFailed = event.status !== "success";
      if (run.resultFailed) {
        const terminalError = record(event.error);
        run.terminalError = {
          type:
            typeof terminalError.type === "string"
              ? terminalError.type.slice(0, 160)
              : "ProviderError",
          message:
            typeof terminalError.message === "string"
              ? run.redactor.text(terminalError.message).slice(0, 2_048)
              : "",
        };
      }
      this.emitUsage(run, record(event.stats));
    }
  }

  private startTool(run: ActiveRun, event: JsonRecord): void {
    const toolId = typeof event.tool_id === "string" ? event.tool_id : randomUUID();
    if (run.toolStarts.has(toolId) || run.terminalToolIds.has(toolId)) return;
    const name = typeof event.tool_name === "string" ? event.tool_name : "runtime_tool";
    const target = this.toolTarget(run, name);
    const startedAt = new Date();
    const argumentsValue = event.parameters ?? {};
    const measurement = measurePayload(argumentsValue, run.redactor);
    const data: Record<string, unknown> = {
      toolId,
      runId: run.request.runId,
      kind: target ? "mcpToolCall" : "dynamicToolCall",
      name,
      server: target?.server ?? "runtime",
      tool: target?.tool ?? name,
      startedAt: startedAt.toISOString(),
      argumentsBytes: measurement.bytes,
      argumentsApproxTokens: measurement.approxTokens,
      ...(measurement.preview ? { argumentsPreview: measurement.preview } : {}),
    };
    run.toolStarts.set(toolId, {
      startedAt: startedAt.toISOString(),
      timestampMs: startedAt.getTime(),
      data,
      argumentsValue,
    });
    run.emit("tool.started", data);
  }

  private finishTool(run: ActiveRun, event: JsonRecord): void {
    const toolId = typeof event.tool_id === "string" ? event.tool_id : "";
    if (!toolId || run.terminalToolIds.has(toolId)) return;
    const start = run.toolStarts.get(toolId);
    if (!start) return;
    const completedAt = new Date();
    const failed = event.status === "error";
    const response = failed ? event.error ?? event.output ?? null : event.output ?? null;
    const measurement = measurePayload(response, run.redactor);
    run.emit(failed ? "tool.failed" : "tool.completed", {
      ...start.data,
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - start.timestampMs),
      responseBytes: measurement.bytes,
      responseApproxTokens: measurement.approxTokens,
      ...(measurement.preview ? { responsePreview: measurement.preview } : {}),
      success: !failed,
      ...(failed ? { reason: "provider_reported_failure" } : {}),
    });
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

  private emitUsage(run: ActiveRun, stats: JsonRecord): void {
    const inputTokens = finiteNumber(stats.input_tokens ?? stats.input);
    const cachedInputTokens = finiteNumber(
      stats.cached_input_tokens ?? stats.cached,
    );
    const outputTokens = finiteNumber(stats.output_tokens);
    const totalTokens =
      finiteNumber(stats.total_tokens) || inputTokens + outputTokens;
    run.emit("usage.updated", {
      callIndex: 1,
      usageScope: "run_aggregate",
      inputTokens,
      cachedInputTokens,
      cacheCreationInputTokens: 0,
      uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
      outputTokens,
      reasoningOutputTokens: 0,
      totalTokens,
      durationMs: finiteNumber(stats.duration_ms),
      providerToolCalls: finiteNumber(stats.tool_calls),
    });
  }

  private toolTarget(
    run: ActiveRun,
    name: string,
  ): { server: string; tool: string } | null {
    for (const [server, alias] of run.serverAliases) {
      const prefixes = [`mcp_${alias}_`, `mcp__${alias}__`, `${alias}__`];
      const prefix = prefixes.find((candidate) => name.startsWith(candidate));
      if (prefix) return { server, tool: name.slice(prefix.length) };
      const configured = run.request.mcpServers.find(
        (candidate) => candidate.name === server,
      );
      if (configured && name in (configured.approval?.tools ?? {})) {
        return { server, tool: name };
      }
    }
    if (run.request.mcpServers.length === 1) {
      return { server: run.request.mcpServers[0]!.name, tool: name };
    }
    return null;
  }
}
