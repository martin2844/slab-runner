import {
  runtimeAdapterEventTypes,
  unavailableRuntimeHealth,
  type RuntimeAdapter,
  type RuntimeEventSink,
  type RuntimeHealth,
  type RuntimeSummary,
} from "./adapter.js";
import { normalizeRuntimeError, publicError, RunnerError } from "./errors.js";
import {
  DEFAULT_WALL_CLOCK_SECONDS,
  type AgentExecutionRequest,
  type NormalizedEventType,
  type RunnerEvent,
} from "./protocol.js";
import type { Logger } from "../lib/logger.js";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { effectiveMcpToolMode } from "./mcp-policy.js";
import type { ActivityLease, RuntimeActivityGate } from "./activity-gate.js";

export type RunStatus =
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunWorkspaceLease {
  workspace: { id: string; repoPath: string; handoffPath: string; branch: string };
  release(): void;
}

/** Resolves and locks a code-profile workspace for the duration of a run. */
export interface RunWorkspaceProvider {
  acquireForRun(
    workspaceId: string,
    runId: string,
    cancel: () => Promise<unknown>,
  ): RunWorkspaceLease;
}

export interface RunManagerOptions {
  /** Concurrent active runs; `null`/unset means unlimited. */
  maxActiveRuns?: number | null;
  /** Present only in the code profile. */
  workspaces?: RunWorkspaceProvider | null;
  /** After a wall-clock cancel, how long to wait before forcing the terminal event. */
  timeLimitGraceMs?: number;
}

interface ManagedRun {
  runId: string;
  request: AgentExecutionRequest | null;
  status: RunStatus;
  nextEventId: number;
  events: RunnerEvent[];
  listeners: Set<(event: RunnerEvent) => void>;
  cleanupTimer: NodeJS.Timeout | null;
  cancelRequested: boolean;
  pendingApprovalIds: Set<string>;
  activityLease: ActivityLease | null;
  workspaceLease?: RunWorkspaceLease | null;
  wallClockTimer?: NodeJS.Timeout | null;
  forceTerminalTimer?: NodeJS.Timeout | null;
  timeLimitExceeded?: boolean;
  docsApproval?: {
    leader: string;
    pending: Set<string>;
    decision?: "approve" | "deny";
    resolving?: Promise<void>;
  };
  approvalFailure?: Error;
}

interface RuntimeHealthProbe {
  promise: Promise<RuntimeHealth>;
  controller: AbortController;
}

export interface EventStreamSnapshot {
  events: RunnerEvent[];
  terminal: boolean;
  unsubscribe(): void;
}

type JournalEntry =
  | { type: "accepted"; runId: string; timestamp: string }
  | { type: "expired"; runId: string; timestamp: string }
  | { type: "event"; event: RunnerEvent };

const TERMINAL_TYPES = new Set<NormalizedEventType>([
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const RUNTIME_ADAPTER_EVENT_TYPES = new Set<string>(runtimeAdapterEventTypes);

export class RunManager {
  readonly #runs = new Map<string, ManagedRun>();
  readonly #seenRunIds = new Set<string>();
  readonly #restartableRunIds = new Set<string>();
  readonly #healthChecks = new Map<string, RuntimeHealthProbe>();
  private readonly adapters: ReadonlyMap<string, RuntimeAdapter>;
  private readonly runtimeActivityGates: ReadonlyMap<
    string,
    RuntimeActivityGate
  >;
  private readonly maxActiveRuns: number | null;
  private readonly workspaces: RunWorkspaceProvider | null;
  private readonly timeLimitGraceMs: number;

  constructor(
    adapters: ReadonlyMap<string, RuntimeAdapter>,
    private readonly logger: Logger,
    private readonly retentionMs = 15 * 60 * 1_000,
    private readonly journalFile?: string,
    private readonly healthTimeoutMs = 5_000,
    runtimeActivityGates: ReadonlyMap<string, RuntimeActivityGate> = new Map(),
    options: RunManagerOptions = {},
  ) {
    this.maxActiveRuns = options.maxActiveRuns ?? null;
    this.workspaces = options.workspaces ?? null;
    this.timeLimitGraceMs = options.timeLimitGraceMs ?? 30_000;
    for (const [runtimeId, adapter] of adapters) {
      if (runtimeId !== adapter.definition.id) {
        throw new Error(
          `Runtime registry key ${runtimeId} does not match adapter ${adapter.definition.id}.`,
        );
      }
    }
    this.adapters = new Map(adapters);
    this.runtimeActivityGates = new Map(runtimeActivityGates);
    if (journalFile && existsSync(journalFile)) {
      const histories = new Map<string, RunnerEvent[]>();
      let journalBuffer = readFileSync(journalFile);
      if (
        journalBuffer.length > 0 &&
        journalBuffer[journalBuffer.length - 1] !== 0x0a
      ) {
        const validLength = journalBuffer.lastIndexOf(0x0a) + 1;
        const journal = openSync(journalFile, constants.O_WRONLY);
        try {
          ftruncateSync(journal, validLength);
          fsyncSync(journal);
        } finally {
          closeSync(journal);
        }
        journalBuffer = journalBuffer.subarray(0, validLength);
      }
      const journalContents = journalBuffer.toString("utf8");
      const lines = journalContents.split("\n");
      for (const line of lines) {
        if (!line) continue;
        const entry = JSON.parse(line) as Partial<JournalEntry> & {
          runId?: unknown;
        };
        if (entry.type === "expired") {
          if (typeof entry.runId !== "string" || !entry.runId) {
            throw new Error("Runner journal contains an invalid tombstone.");
          }
          this.#seenRunIds.add(entry.runId);
          histories.delete(entry.runId);
          continue;
        }
        if (entry.type === "event") {
          const event = entry.event;
          if (
            !event ||
            typeof event.runId !== "string" ||
            typeof event.id !== "number" ||
            typeof event.type !== "string"
          ) {
            throw new Error("Runner journal contains an invalid event.");
          }
          const events = histories.get(event.runId) ?? [];
          events.push(event);
          histories.set(event.runId, events);
          this.#seenRunIds.add(event.runId);
          continue;
        }
        if (typeof entry.runId !== "string" || !entry.runId) {
          throw new Error("Runner journal contains an invalid run identifier.");
        }
        this.#seenRunIds.add(entry.runId);
        if (!histories.has(entry.runId)) histories.set(entry.runId, []);
      }
      for (const [runId, persistedEvents] of histories) {
        if (persistedEvents.length === 0) {
          this.#restartableRunIds.add(runId);
          continue;
        }
        const events = [...persistedEvents].sort((a, b) => a.id - b.id);
        const terminal = events.findLast((event) =>
          TERMINAL_TYPES.has(event.type),
        );
        if (
          terminal &&
          Date.now() - Date.parse(terminal.timestamp) >= this.retentionMs
        ) {
          continue;
        }
        const status: RunStatus = terminal
          ? terminal.type === "run.completed"
            ? "completed"
            : terminal.type === "run.cancelled"
              ? "cancelled"
              : "failed"
          : "failed";
        const run: ManagedRun = {
          runId,
          request: null,
          status,
          nextEventId: Math.max(...events.map(({ id }) => id)) + 1,
          events,
          listeners: new Set(),
          cleanupTimer: null,
          cancelRequested: false,
          pendingApprovalIds: new Set(),
          activityLease: null,
        };
        this.#runs.set(runId, run);
        if (!terminal) {
          this.emit(run, "run.failed", {
            error: publicError(
              new RunnerError(
                "RUN_INTERRUPTED",
                "Runner restarted before the execution reached a terminal state",
                500,
              ),
            ),
          });
        }
        this.scheduleCleanup(run);
      }
    }
  }

  create(request: AgentExecutionRequest): { runId: string; status: "running" } {
    if (this.#runs.has(request.runId)) {
      throw new RunnerError(
        "RUN_ALREADY_EXISTS",
        "A run with this identifier already exists",
        409,
      );
    }
    if (
      this.#seenRunIds.has(request.runId) &&
      !this.#restartableRunIds.has(request.runId)
    ) {
      throw new RunnerError(
        "RUN_HISTORY_EXPIRED",
        "Run history is no longer available; refusing to execute the same run again",
        410,
      );
    }
    if (request.workspace) this.validateWorkspaceRequest(request);
    else if (this.workspaces) {
      // In the code profile every run must hold a workspace lock; a plain
      // `cwd` run could otherwise touch a workspace that a publish is using.
      throw new RunnerError(
        "WORKSPACE_REQUIRED",
        "Runs on the code profile must specify a workspace",
        400,
      );
    }
    this.requireAdapter(request.runtime.type);
    if (
      this.maxActiveRuns !== null &&
      this.activeRunCount() >= this.maxActiveRuns
    ) {
      throw new RunnerError(
        "RUNNER_AT_CAPACITY",
        "The runner is at its concurrent run limit; retry later",
        429,
      );
    }
    const workspaceLease =
      request.workspace && this.workspaces
        ? this.workspaces.acquireForRun(request.workspace.id, request.runId, () =>
            this.cancel(request.runId),
          )
        : null;
    let activityLease: ActivityLease | null = null;
    try {
      activityLease =
        this.runtimeActivityGates.get(request.runtime.type)?.beginRun() ?? null;
      if (!this.#restartableRunIds.delete(request.runId)) {
        this.recordRunIdentity(request.runId);
      }
      const run: ManagedRun = {
        runId: request.runId,
        request: workspaceLease
          ? { ...request, workspace: workspaceLease.workspace }
          : request,
        status: "running",
        nextEventId: 1,
        events: [],
        listeners: new Set(),
        cleanupTimer: null,
        cancelRequested: false,
        pendingApprovalIds: new Set(),
        activityLease,
        workspaceLease,
      };
      this.#runs.set(request.runId, run);
      const wallClockSeconds =
        request.limits?.wallClockSeconds ??
        (request.workspace ? DEFAULT_WALL_CLOCK_SECONDS : null);
      if (wallClockSeconds) {
        run.wallClockTimer = setTimeout(
          () => void this.expire(run, wallClockSeconds),
          wallClockSeconds * 1_000,
        );
        run.wallClockTimer.unref();
      }
      void this.execute(run);
      return { runId: request.runId, status: "running" };
    } catch (error) {
      activityLease?.release();
      workspaceLease?.release();
      throw error;
    }
  }

  private validateWorkspaceRequest(request: AgentExecutionRequest): void {
    if (!this.workspaces) {
      throw new RunnerError(
        "PROFILE_NOT_ENABLED",
        "Workspace runs require RUNNER_PROFILE=code",
        400,
      );
    }
    if (request.cwd !== null) {
      throw new RunnerError(
        "INVALID_REQUEST",
        "cwd must be null when a workspace is supplied",
        400,
      );
    }
    if (request.runtime.type !== "codex") {
      throw new RunnerError(
        "RUNTIME_UNSUPPORTED_FOR_PROFILE",
        "Only the codex runtime supports workspace runs",
        400,
      );
    }
  }

  private activeRunCount(): number {
    let count = 0;
    for (const run of this.#runs.values()) {
      if (run.request && !TERMINAL_STATUSES.has(run.status)) count++;
    }
    return count;
  }

  private async expire(run: ManagedRun, seconds: number): Promise<void> {
    if (TERMINAL_STATUSES.has(run.status)) return;
    run.timeLimitExceeded = true;
    this.logger.warn("run wall-clock limit reached", {
      runId: run.runId,
      wallClockSeconds: seconds,
    });
    run.forceTerminalTimer = setTimeout(() => {
      if (TERMINAL_STATUSES.has(run.status)) return;
      this.finishCancelled(run);
      this.releaseResources(run);
      this.scheduleCleanup(run);
    }, this.timeLimitGraceMs);
    run.forceTerminalTimer.unref();
    try {
      await this.cancel(run.runId);
    } catch {
      this.logger.error("wall-clock cancellation failed", { runId: run.runId });
    }
  }

  private hasTerminalEvent(run: ManagedRun): boolean {
    return run.events.some((event) => TERMINAL_TYPES.has(event.type));
  }

  /** Emits the terminal event for a cancelled run (or a time-limited one). */
  private finishCancelled(run: ManagedRun, error?: RunnerError): void {
    if (this.hasTerminalEvent(run)) return;
    if (run.timeLimitExceeded) {
      run.status = "failed";
      this.emit(run, "run.failed", {
        error: publicError(
          new RunnerError(
            "RUN_TIME_LIMIT",
            "Run exceeded its wall-clock time limit",
            408,
          ),
        ),
      });
      this.logger.error("run failed", { runId: run.runId, code: "RUN_TIME_LIMIT" });
      return;
    }
    run.status = "cancelled";
    this.emit(run, "run.cancelled", {
      error: publicError(
        error ?? new RunnerError("RUN_CANCELLED", "Run was cancelled", 409),
      ),
    });
    this.logger.info("run cancelled", { runId: run.runId });
  }

  private releaseResources(run: ManagedRun): void {
    if (run.wallClockTimer) clearTimeout(run.wallClockTimer);
    run.wallClockTimer = null;
    if (TERMINAL_STATUSES.has(run.status) && run.forceTerminalTimer) {
      clearTimeout(run.forceTerminalTimer);
      run.forceTerminalTimer = null;
    }
    run.activityLease?.release();
    run.activityLease = null;
    run.workspaceLease?.release();
    run.workspaceLease = null;
  }

  has(runId: string): boolean {
    return this.#runs.has(runId);
  }

  wasSeen(runId: string): boolean {
    return this.#seenRunIds.has(runId) && !this.#restartableRunIds.has(runId);
  }

  status(runId: string): RunStatus | null {
    return this.#runs.get(runId)?.status ?? null;
  }

  async runtimes(): Promise<RuntimeSummary[]> {
    return Promise.all(
      [...this.adapters.values()].map(async (adapter) => {
        let timeout: NodeJS.Timeout | undefined;
        const probe = this.runtimeHealth(adapter);
        const health = await Promise.race([
          probe.promise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              if (this.#healthChecks.get(adapter.definition.id) === probe) {
                this.#healthChecks.delete(adapter.definition.id);
              }
              probe.controller.abort();
              reject(new Error("Runtime health check timed out."));
            }, this.healthTimeoutMs);
          }),
        ])
          .catch(() => unavailableRuntimeHealth())
          .finally(() => {
            if (timeout) clearTimeout(timeout);
          });
        return { ...health, ...adapter.definition };
      }),
    );
  }

  openEventStream(
    runId: string,
    afterEventId: number,
    listener: (event: RunnerEvent) => void,
  ): EventStreamSnapshot {
    const run = this.requireRun(runId);
    run.listeners.add(listener);
    const terminal = TERMINAL_STATUSES.has(run.status);
    if (terminal) run.listeners.delete(listener);
    return {
      events: run.events.filter(({ id }) => id > afterEventId),
      terminal,
      unsubscribe: () => run.listeners.delete(listener),
    };
  }

  async cancel(runId: string): Promise<{ runId: string; status: RunStatus }> {
    const run = this.requireRun(runId);
    if (TERMINAL_STATUSES.has(run.status)) {
      return { runId, status: run.status };
    }
    run.cancelRequested = true;
    run.status = "cancelling";
    const request = run.request;
    if (!request) {
      throw new RunnerError(
        "RUN_HISTORY_EXPIRED",
        "The live execution request is no longer available",
        410,
      );
    }
    const adapter = this.requireAdapter(request.runtime.type);
    try {
      await adapter.cancelRun(runId);
    } catch (error) {
      if (error instanceof RunnerError && error.code === "RUN_NOT_FOUND") {
        return { runId, status: run.status };
      }
      throw error;
    }
    return { runId, status: run.status };
  }

  async respondToApproval(
    runId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<{ runId: string; approvalId: string; decision: string }> {
    const run = this.requireRun(runId);
    if (TERMINAL_STATUSES.has(run.status)) {
      throw new RunnerError(
        "APPROVAL_FAILED",
        "The run is no longer active",
        409,
      );
    }
    const request = run.request;
    if (!request) {
      throw new RunnerError(
        "RUN_HISTORY_EXPIRED",
        "The live execution request is no longer available",
        410,
      );
    }
    const docs = run.docsApproval;
    if (docs?.leader === approvalId) {
      if (docs.decision && docs.decision !== decision)
        throw new RunnerError(
          "APPROVAL_FAILED",
          "Docs permission was already decided for this run",
          409,
        );
      docs.decision = decision;
      await this.resolveDocsApprovals(run);
      return { runId, approvalId, decision };
    }
    if (docs?.pending.has(approvalId))
      throw new RunnerError(
        "APPROVAL_FAILED",
        "Resolve the run's Docs permission request",
        409,
      );
    await this.requireAdapter(request.runtime.type).respondToApproval(
      runId,
      approvalId,
      decision,
    );
    return { runId, approvalId, decision };
  }

  private isDocsRunApproval(run: ManagedRun, data: Record<string, unknown>) {
    const request = run.request;
    const server = request?.mcpServers.find(
      (server) => server.name === "docs" && server.docsRunApproval,
    );
    return (
      !!request &&
      !!server &&
      data.server === "docs" &&
      typeof data.tool === "string" &&
      ["create_doc", "update_doc", "archive_doc"].includes(data.tool) &&
      effectiveMcpToolMode(server, data.tool, request.agent.fullAccess) ===
        "prompt"
    );
  }

  private resolveDocsApprovals(run: ManagedRun): Promise<void> {
    const docs = run.docsApproval;
    if (!docs?.decision || !run.request) return Promise.resolve();
    if (docs.resolving) return docs.resolving;
    const adapter = this.requireAdapter(run.request.runtime.type);
    const decision = docs.decision;
    docs.resolving = (async () => {
      for (const id of docs.pending) {
        if (run.cancelRequested || TERMINAL_STATUSES.has(run.status)) break;
        try {
          await adapter.respondToApproval(run.runId, id, decision);
          docs.pending.delete(id);
        } catch (error) {
          // An adapter may cancel a pending request while the owner is deciding.
          if (!docs.pending.has(id)) continue;
          run.approvalFailure =
            error instanceof Error ? error : new Error("Docs approval failed");
          await adapter.cancelRun(run.runId);
          throw run.approvalFailure;
        }
      }
    })().then(
      () => {
        delete docs.resolving;
        // A follow-up tool can arrive in the microtask between draining the
        // pending set and releasing this promise. Resolve it under the same grant.
        if (
          docs.pending.size &&
          !run.approvalFailure &&
          !run.cancelRequested &&
          !TERMINAL_STATUSES.has(run.status)
        )
          return this.resolveDocsApprovals(run);
      },
      (error: unknown) => {
        delete docs.resolving;
        throw error;
      },
    );
    return docs.resolving;
  }

  private async execute(run: ManagedRun): Promise<void> {
    const request = run.request;
    if (!request) return;
    const adapter = this.requireAdapter(request.runtime.type);
    this.logger.info("run started", {
      runId: request.runId,
      runtime: request.runtime.type,
      agentId: request.agent.id,
    });
    this.emit(run, "run.started", {
      runtime: request.runtime.type,
      runtimeDefinition: adapter.definition,
      agentId: request.agent.id,
    });
    try {
      if (adapter.contextProfile) {
        this.emit(run, "context.bootstrap", adapter.contextProfile(request));
      }
      const isNewThread = request.thread.runtimeThreadId === null;
      const runtimeThreadId = isNewThread
        ? await adapter.startThread(request)
        : await adapter.resumeThread(request);
      if (isNewThread || runtimeThreadId !== request.thread.runtimeThreadId) {
        this.emit(run, "thread.created", {
          runtimeThreadId,
          ...(isNewThread
            ? {}
            : {
                previousRuntimeThreadId: request.thread.runtimeThreadId,
                continuity: "resumed",
              }),
        });
      }
      if (run.cancelRequested) {
        this.finishCancelled(run);
        return;
      }
      let adapterProtocolViolation = false;
      let adapterEventsOpen = true;
      const sink: RuntimeEventSink = (type, data = {}) => {
        if (!adapterEventsOpen || TERMINAL_STATUSES.has(run.status)) return;
        if (!RUNTIME_ADAPTER_EVENT_TYPES.has(type)) {
          adapterProtocolViolation = true;
          adapterEventsOpen = false;
          return;
        }
        if (
          type === "approval.required" &&
          typeof data.approvalId === "string"
        ) {
          run.pendingApprovalIds.add(data.approvalId);
          run.status = "waiting_approval";
          if (this.isDocsRunApproval(run, data)) {
            const first = !run.docsApproval;
            run.docsApproval ??= {
              leader: data.approvalId,
              pending: new Set(),
            };
            run.docsApproval.pending.add(data.approvalId);
            if (run.docsApproval.decision) {
              void this.resolveDocsApprovals(run).catch((error) =>
                this.logger.error("Docs approval resolution failed", {
                  runId: run.runId,
                  error: String(error),
                }),
              );
              return;
            }
            if (!first) return;
            data = { ...data, approvalScope: "docs_run" };
          }
        } else if (
          type === "approval.resolved" &&
          typeof data.approvalId === "string"
        ) {
          run.pendingApprovalIds.delete(data.approvalId);
          run.docsApproval?.pending.delete(data.approvalId);
          if (
            run.pendingApprovalIds.size === 0 &&
            run.status === "waiting_approval"
          ) {
            run.status = "running";
          }
        }
        this.emit(run, type, data);
      };
      try {
        await adapter.runTurn({ request, runtimeThreadId, emit: sink });
      } finally {
        adapterEventsOpen = false;
      }
      if (run.approvalFailure) throw run.approvalFailure;
      if (adapterProtocolViolation) {
        throw new RunnerError(
          "UNKNOWN_RUNTIME_ERROR",
          "Runtime adapter violated the normalized event protocol",
          502,
        );
      }
      if (run.cancelRequested) {
        this.finishCancelled(run);
        return;
      }
      if (this.hasTerminalEvent(run)) return;
      run.status = "completed";
      this.emit(run, "run.completed", { runtimeThreadId });
      this.logger.info("run completed", { runId: request.runId });
    } catch (error) {
      const normalized =
        error instanceof RunnerError ? error : normalizeRuntimeError(error);
      if (this.hasTerminalEvent(run)) {
        // A forced wall-clock termination already ended this run.
      } else if (normalized.code === "RUN_CANCELLED" || run.timeLimitExceeded) {
        this.finishCancelled(run, normalized);
      } else {
        run.status = "failed";
        this.emit(run, "run.failed", { error: publicError(normalized) });
        this.logger.error("run failed", {
          runId: request.runId,
          code: normalized.code,
        });
      }
    } finally {
      this.releaseResources(run);
      this.scheduleCleanup(run);
    }
  }

  private emit(
    run: ManagedRun,
    type: NormalizedEventType,
    data: Record<string, unknown>,
  ): void {
    if (run.events.some((event) => TERMINAL_TYPES.has(event.type))) return;
    const event: RunnerEvent = {
      id: run.nextEventId++,
      type,
      runId: run.runId,
      timestamp: new Date().toISOString(),
      data,
    };
    this.recordEvent(event);
    run.events.push(event);
    for (const listener of run.listeners) listener(event);
    if (TERMINAL_TYPES.has(type)) run.listeners.clear();
  }

  private scheduleCleanup(run: ManagedRun): void {
    if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
    run.cleanupTimer = setTimeout(() => {
      if (this.#runs.get(run.runId) === run) {
        this.#runs.delete(run.runId);
        try {
          this.compactJournal();
        } catch {
          this.logger.error("runner journal compaction failed", {
            runId: run.runId,
          });
        }
      }
    }, this.retentionMs);
    run.cleanupTimer.unref();
  }

  private requireRun(runId: string): ManagedRun {
    const run = this.#runs.get(runId);
    if (!run) {
      throw new RunnerError("RUN_NOT_FOUND", "Run was not found", 404);
    }
    return run;
  }

  private recordRunIdentity(runId: string): void {
    this.appendJournalEntry({
      type: "accepted",
      runId,
      timestamp: new Date().toISOString(),
    });
    this.#seenRunIds.add(runId);
  }

  private recordEvent(event: RunnerEvent): void {
    this.appendJournalEntry({ type: "event", event });
  }

  private appendJournalEntry(entry: JournalEntry): void {
    if (!this.journalFile) return;
    const journalDirectory = dirname(this.journalFile);
    mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
    const existed = existsSync(this.journalFile);
    const journal = openSync(
      this.journalFile,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
      0o600,
    );
    try {
      chmodSync(this.journalFile, 0o600);
      this.writeAll(journal, `${JSON.stringify(entry)}\n`);
      fsyncSync(journal);
    } finally {
      closeSync(journal);
    }
    if (!existed) {
      const directory = openSync(journalDirectory, constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  }

  private compactJournal(): void {
    if (!this.journalFile) return;
    const entries: JournalEntry[] = [];
    const timestamp = new Date().toISOString();
    for (const runId of this.#seenRunIds) {
      const run = this.#runs.get(runId);
      if (run) {
        entries.push({ type: "accepted", runId, timestamp });
        entries.push(
          ...run.events.map((event) => ({ type: "event" as const, event })),
        );
      } else if (this.#restartableRunIds.has(runId)) {
        entries.push({ type: "accepted", runId, timestamp });
      } else {
        entries.push({ type: "expired", runId, timestamp });
      }
    }
    const journalDirectory = dirname(this.journalFile);
    mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${this.journalFile}.compact.${process.pid}.${Date.now()}`;
    const output = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      for (const entry of entries) {
        this.writeAll(output, `${JSON.stringify(entry)}\n`);
      }
      fsyncSync(output);
    } catch (error) {
      closeSync(output);
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    closeSync(output);
    renameSync(temporary, this.journalFile);
    const directory = openSync(journalDirectory, constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }

  private writeAll(file: number, value: string): void {
    const content = Buffer.from(value, "utf8");
    let offset = 0;
    while (offset < content.length) {
      offset += writeSync(file, content, offset, content.length - offset);
    }
  }

  private requireAdapter(runtime: string): RuntimeAdapter {
    const adapter = this.adapters.get(runtime);
    if (!adapter) {
      throw new RunnerError(
        "RUNTIME_UNAVAILABLE",
        "Requested runtime is unavailable",
        503,
      );
    }
    return adapter;
  }

  private runtimeHealth(adapter: RuntimeAdapter): RuntimeHealthProbe {
    const runtimeId = adapter.definition.id;
    const existing = this.#healthChecks.get(runtimeId);
    if (existing) return existing;

    const controller = new AbortController();
    const probe: RuntimeHealthProbe = {
      controller,
      promise: Promise.resolve().then(() => adapter.health(controller.signal)),
    };
    probe.promise = probe.promise.finally(() => {
      if (this.#healthChecks.get(runtimeId) === probe) {
        this.#healthChecks.delete(runtimeId);
      }
    });
    this.#healthChecks.set(runtimeId, probe);
    return probe;
  }
}
