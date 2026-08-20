import type { RuntimeAdapter, RuntimeEventSink } from "./adapter.js";
import { normalizeRuntimeError, publicError, RunnerError } from "./errors.js";
import type {
  AgentExecutionRequest,
  NormalizedEventType,
  RunnerEvent,
} from "./protocol.js";
import type { Logger } from "../lib/logger.js";

export type RunStatus =
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

interface ManagedRun {
  request: AgentExecutionRequest;
  status: RunStatus;
  nextEventId: number;
  events: RunnerEvent[];
  listeners: Set<(event: RunnerEvent) => void>;
  cleanupTimer: NodeJS.Timeout | null;
  cancelRequested: boolean;
  pendingApprovalIds: Set<string>;
}

export interface EventStreamSnapshot {
  events: RunnerEvent[];
  terminal: boolean;
  unsubscribe(): void;
}

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

export class RunManager {
  readonly #runs = new Map<string, ManagedRun>();

  constructor(
    private readonly adapters: Map<string, RuntimeAdapter>,
    private readonly logger: Logger,
    private readonly retentionMs = 15 * 60 * 1_000,
  ) {}

  create(request: AgentExecutionRequest): { runId: string; status: "running" } {
    if (this.#runs.has(request.runId)) {
      throw new RunnerError(
        "RUN_ALREADY_EXISTS",
        "A run with this identifier already exists",
        409,
      );
    }
    const run: ManagedRun = {
      request,
      status: "running",
      nextEventId: 1,
      events: [],
      listeners: new Set(),
      cleanupTimer: null,
      cancelRequested: false,
      pendingApprovalIds: new Set(),
    };
    this.#runs.set(request.runId, run);
    void this.execute(run);
    return { runId: request.runId, status: "running" };
  }

  has(runId: string): boolean {
    return this.#runs.has(runId);
  }

  status(runId: string): RunStatus | null {
    return this.#runs.get(runId)?.status ?? null;
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
    const adapter = this.requireAdapter(run.request.runtime.type);
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
    await this.requireAdapter(run.request.runtime.type).respondToApproval(
      runId,
      approvalId,
      decision,
    );
    return { runId, approvalId, decision };
  }

  private async execute(run: ManagedRun): Promise<void> {
    const { request } = run;
    const adapter = this.requireAdapter(request.runtime.type);
    this.logger.info("run started", {
      runId: request.runId,
      runtime: request.runtime.type,
      agentId: request.agent.id,
    });
    this.emit(run, "run.started", {
      runtime: request.runtime.type,
      agentId: request.agent.id,
    });
    if (adapter.contextProfile) {
      this.emit(run, "context.bootstrap", adapter.contextProfile(request));
    }
    try {
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
      const sink: RuntimeEventSink = (type, data = {}) => {
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
      await adapter.runTurn({ request, runtimeThreadId, emit: sink });
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
      runId: run.request.runId,
      timestamp: new Date().toISOString(),
      data,
    };
    run.events.push(event);
    if (run.events.length > 2_000) run.events.shift();
    for (const listener of run.listeners) listener(event);
    if (TERMINAL_TYPES.has(type)) run.listeners.clear();
  }

  private scheduleCleanup(run: ManagedRun): void {
    if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
    run.cleanupTimer = setTimeout(() => {
      if (this.#runs.get(run.request.runId) === run) {
        this.#runs.delete(run.request.runId);
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
}
