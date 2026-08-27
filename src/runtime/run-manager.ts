import {
  runtimeAdapterEventTypes,
  unavailableRuntimeHealth,
  type RuntimeAdapter,
  type RuntimeEventSink,
  type RuntimeHealth,
  type RuntimeSummary,
} from "./adapter.js";
import { normalizeRuntimeError, publicError, RunnerError } from "./errors.js";
import type {
  AgentExecutionRequest,
  NormalizedEventType,
  RunnerEvent,
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
import type { ActivityLease, RuntimeActivityGate } from "./activity-gate.js";

export type RunStatus =
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

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

  constructor(
    adapters: ReadonlyMap<string, RuntimeAdapter>,
    private readonly logger: Logger,
    private readonly retentionMs = 15 * 60 * 1_000,
    private readonly journalFile?: string,
    private readonly healthTimeoutMs = 5_000,
    runtimeActivityGates: ReadonlyMap<string, RuntimeActivityGate> = new Map(),
  ) {
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
    this.requireAdapter(request.runtime.type);
    const activityLease = this.runtimeActivityGates
      .get(request.runtime.type)
      ?.beginRun() ?? null;
    try {
      if (!this.#restartableRunIds.delete(request.runId)) {
        this.recordRunIdentity(request.runId);
      }
      const run: ManagedRun = {
        runId: request.runId,
        request,
        status: "running",
        nextEventId: 1,
        events: [],
        listeners: new Set(),
        cleanupTimer: null,
        cancelRequested: false,
        pendingApprovalIds: new Set(),
        activityLease,
      };
      this.#runs.set(request.runId, run);
      void this.execute(run);
      return { runId: request.runId, status: "running" };
    } catch (error) {
      activityLease?.release();
      throw error;
    }
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
    await this.requireAdapter(request.runtime.type).respondToApproval(
      runId,
      approvalId,
      decision,
    );
    return { runId, approvalId, decision };
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
      if (isNewThread) {
        this.emit(run, "thread.created", { runtimeThreadId });
      }
      if (run.cancelRequested) {
        run.status = "cancelled";
        this.emit(run, "run.cancelled", {
          error: publicError(
            new RunnerError("RUN_CANCELLED", "Run was cancelled", 409),
          ),
        });
        this.logger.info("run cancelled", { runId: request.runId });
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
        } else if (
          type === "approval.resolved" &&
          typeof data.approvalId === "string"
        ) {
          run.pendingApprovalIds.delete(data.approvalId);
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
      if (adapterProtocolViolation) {
        throw new RunnerError(
          "UNKNOWN_RUNTIME_ERROR",
          "Runtime adapter violated the normalized event protocol",
          502,
        );
      }
      if (run.cancelRequested) {
        run.status = "cancelled";
        this.emit(run, "run.cancelled", {
          error: publicError(
            new RunnerError("RUN_CANCELLED", "Run was cancelled", 409),
          ),
        });
        this.logger.info("run cancelled", { runId: request.runId });
        return;
      }
      run.status = "completed";
      this.emit(run, "run.completed", { runtimeThreadId });
      this.logger.info("run completed", { runId: request.runId });
    } catch (error) {
      const normalized =
        error instanceof RunnerError ? error : normalizeRuntimeError(error);
      if (normalized.code === "RUN_CANCELLED") {
        run.status = "cancelled";
        this.emit(run, "run.cancelled", {
          error: publicError(normalized),
        });
        this.logger.info("run cancelled", { runId: request.runId });
      } else {
        run.status = "failed";
        this.emit(run, "run.failed", { error: publicError(normalized) });
        this.logger.error("run failed", {
          runId: request.runId,
          code: normalized.code,
        });
      }
    } finally {
      run.activityLease?.release();
      run.activityLease = null;
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
    probe.promise = probe.promise
      .finally(() => {
        if (this.#healthChecks.get(runtimeId) === probe) {
          this.#healthChecks.delete(runtimeId);
        }
      });
    this.#healthChecks.set(runtimeId, probe);
    return probe;
  }
}
