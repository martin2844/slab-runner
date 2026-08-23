import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SilentLogger } from "../src/lib/logger.js";
import type {
  RuntimeAdapter,
  RuntimeHealth,
  RuntimeTurnContext,
} from "../src/runtime/adapter.js";
import { RunnerError } from "../src/runtime/errors.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { executionRequest } from "./helpers/fixtures.js";

class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly id = "codex";
  available = true;
  threadStart: () => Promise<string> = () => Promise.resolve("thread-created");
  turn: (context: RuntimeTurnContext) => Promise<void> = (context) => {
    context.emit("assistant.delta", { delta: "Hello" });
    context.emit("assistant.completed", { message: "Hello" });
    return Promise.resolve();
  };
  cancelled: string[] = [];
  approvals: Array<{
    runId: string;
    approvalId: string;
    decision: "approve" | "deny";
  }> = [];

  start(): Promise<void> {
    return Promise.resolve();
  }

  health(): Promise<RuntimeHealth> {
    return Promise.resolve({ id: this.id, available: this.available });
  }

  contextProfile() {
    return { runtime: "codex", initialUserInput: { approxTokens: 4 } };
  }

  startThread(): Promise<string> {
    return this.threadStart();
  }

  resumeThread(): Promise<string> {
    return Promise.resolve("thread-existing");
  }

  runTurn(context: RuntimeTurnContext): Promise<void> {
    return this.turn(context);
  }

  cancelRun(runId: string): Promise<void> {
    this.cancelled.push(runId);
    return Promise.resolve();
  }

  respondToApproval(
    runId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<void> {
    this.approvals.push({ runId, approvalId, decision });
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function managerWith(adapter = new FakeRuntimeAdapter()) {
  return {
    adapter,
    manager: new RunManager(
      new Map<string, RuntimeAdapter>([[adapter.id, adapter]]),
      new SilentLogger(),
      60_000,
    ),
  };
}

describe("RunManager", () => {
  it("persists run identities and refuses re-execution after in-memory history expires", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slab-runner-journal-"));
    const journal = join(directory, "runs.jsonl");
    try {
      const firstAdapter = new FakeRuntimeAdapter();
      const first = new RunManager(
        new Map([[firstAdapter.id, firstAdapter]]),
        new SilentLogger(),
        50,
        journal,
      );
      first.create(executionRequest({ runId: "durable-run" }));
      await vi.waitFor(() =>
        expect(first.status("durable-run")).toBe("completed"),
      );
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(first.status("durable-run")).toBeNull();
      const compacted = readFileSync(journal, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; runId: string });
      expect(compacted).toEqual([
        expect.objectContaining({ type: "expired", runId: "durable-run" }),
      ]);

      const restartedAdapter = new FakeRuntimeAdapter();
      const restarted = new RunManager(
        new Map([[restartedAdapter.id, restartedAdapter]]),
        new SilentLogger(),
        50,
        journal,
      );
      expect(() =>
        restarted.create(executionRequest({ runId: "durable-run" })),
      ).toThrowError(
        expect.objectContaining({
          code: "RUN_HISTORY_EXPIRED",
          httpStatus: 410,
        }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays a durable terminal outcome after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slab-runner-journal-"));
    const journal = join(directory, "runs.jsonl");
    try {
      const firstAdapter = new FakeRuntimeAdapter();
      const first = new RunManager(
        new Map([[firstAdapter.id, firstAdapter]]),
        new SilentLogger(),
        60_000,
        journal,
      );
      first.create(executionRequest({ runId: "durable-terminal" }));
      await vi.waitFor(() =>
        expect(first.status("durable-terminal")).toBe("completed"),
      );

      const restarted = new RunManager(
        new Map([[firstAdapter.id, firstAdapter]]),
        new SilentLogger(),
        60_000,
        journal,
      );
      expect(restarted.status("durable-terminal")).toBe("completed");
      expect(
        restarted.openEventStream("durable-terminal", 0, () => {}).events.at(-1)
          ?.type,
      ).toBe("run.completed");
      expect(() =>
        restarted.create(executionRequest({ runId: "durable-terminal" })),
      ).toThrowError(expect.objectContaining({ code: "RUN_ALREADY_EXISTS" }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restarts an accepted intent only when no execution event was durable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slab-runner-journal-"));
    const journal = join(directory, "runs.jsonl");
    try {
      writeFileSync(
        journal,
        `${JSON.stringify({
          type: "accepted",
          runId: "accepted-only",
          timestamp: new Date().toISOString(),
        })}\n`,
      );
      const adapter = new FakeRuntimeAdapter();
      const manager = new RunManager(
        new Map([[adapter.id, adapter]]),
        new SilentLogger(),
        60_000,
        journal,
      );
      expect(manager.wasSeen("accepted-only")).toBe(false);
      manager.create(executionRequest({ runId: "accepted-only" }));
      await vi.waitFor(() =>
        expect(manager.status("accepted-only")).toBe("completed"),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("truncates a torn journal tail before appending new durable events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slab-runner-journal-"));
    const journal = join(directory, "runs.jsonl");
    try {
      writeFileSync(
        journal,
        `${JSON.stringify({
          type: "expired",
          runId: "expired-before-torn-tail",
          timestamp: new Date().toISOString(),
        })}\n{"type":"event","event":`,
      );
      const adapter = new FakeRuntimeAdapter();
      const recovered = new RunManager(
        new Map([[adapter.id, adapter]]),
        new SilentLogger(),
        60_000,
        journal,
      );
      recovered.create(executionRequest({ runId: "after-torn-tail" }));
      await vi.waitFor(() =>
        expect(recovered.status("after-torn-tail")).toBe("completed"),
      );
      expect(() =>
        readFileSync(journal, "utf8")
          .trim()
          .split("\n")
          .forEach((line) => {
            JSON.parse(line);
          }),
      ).not.toThrow();

      const restarted = new RunManager(
        new Map([[adapter.id, adapter]]),
        new SilentLogger(),
        60_000,
        journal,
      );
      expect(restarted.status("after-torn-tail")).toBe("completed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats a complete JSON record without its newline as uncommitted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slab-runner-journal-"));
    const journal = join(directory, "runs.jsonl");
    try {
      writeFileSync(
        journal,
        JSON.stringify({
          type: "accepted",
          runId: "unframed-accepted-intent",
          timestamp: new Date().toISOString(),
        }),
      );
      const adapter = new FakeRuntimeAdapter();
      const recovered = new RunManager(
        new Map([[adapter.id, adapter]]),
        new SilentLogger(),
        60_000,
        journal,
      );
      expect(recovered.wasSeen("unframed-accepted-intent")).toBe(false);
      recovered.create(executionRequest({ runId: "after-unframed-record" }));
      await vi.waitFor(() =>
        expect(recovered.status("after-unframed-record")).toBe("completed"),
      );

      const restarted = new RunManager(
        new Map([[adapter.id, adapter]]),
        new SilentLogger(),
        60_000,
        journal,
      );
      expect(restarted.status("after-unframed-record")).toBe("completed");
      expect(restarted.wasSeen("unframed-accepted-intent")).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("terminalizes an execution interrupted after its durable start event", () => {
    const directory = mkdtempSync(join(tmpdir(), "slab-runner-journal-"));
    const journal = join(directory, "runs.jsonl");
    const runId = "interrupted-run";
    try {
      writeFileSync(
        journal,
        [
          {
            type: "accepted",
            runId,
            timestamp: new Date().toISOString(),
          },
          {
            type: "event",
            event: {
              id: 1,
              type: "run.started",
              runId,
              timestamp: new Date().toISOString(),
              data: {},
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const adapter = new FakeRuntimeAdapter();
      const manager = new RunManager(
        new Map([[adapter.id, adapter]]),
        new SilentLogger(),
        60_000,
        journal,
      );
      expect(manager.status(runId)).toBe("failed");
      const failure = manager.openEventStream(runId, 1, () => {}).events[0];
      expect(failure).toBeDefined();
      if (!failure) throw new Error("missing synthetic terminal event");
      expect(failure.type).toBe("run.failed");
      expect(failure.data).toEqual({
        error: {
          code: "RUN_INTERRUPTED",
          message:
            "Runner restarted before the execution reached a terminal state",
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("emits a complete normalized lifecycle and replays it", async () => {
    const { manager } = managerWith();
    expect(manager.create(executionRequest())).toEqual({
      runId: "run-1",
      status: "running",
    });
    await vi.waitFor(() => expect(manager.status("run-1")).toBe("completed"));

    const stream = manager.openEventStream("run-1", 0, () => {});
    expect(stream.terminal).toBe(true);
    expect(stream.events.map(({ type }) => type)).toEqual([
      "run.started",
      "context.bootstrap",
      "thread.created",
      "assistant.delta",
      "assistant.completed",
      "run.completed",
    ]);
    expect(stream.events.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("retains a complete replay window beyond two thousand events", async () => {
    const { adapter, manager } = managerWith();
    adapter.turn = (context) => {
      for (let index = 0; index < 2_100; index += 1) {
        context.emit("assistant.delta", { delta: String(index % 10) });
      }
      context.emit("assistant.completed", { message: "complete" });
      return Promise.resolve();
    };
    manager.create(executionRequest({ runId: "large-event-run" }));
    await vi.waitFor(() =>
      expect(manager.status("large-event-run")).toBe("completed"),
    );
    const events = manager.openEventStream(
      "large-event-run",
      0,
      () => {},
    ).events;
    expect(events.length).toBeGreaterThan(2_000);
    expect(events.map(({ id }) => id)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("restores more than two thousand durable events without a cursor gap", () => {
    const directory = mkdtempSync(join(tmpdir(), "slab-runner-large-journal-"));
    const journal = join(directory, "runs.jsonl");
    const runId = "large-restored-run";
    try {
      const timestamp = new Date().toISOString();
      const entries = [
        { type: "accepted", runId, timestamp },
        ...Array.from({ length: 2_100 }, (_, index) => ({
          type: "event",
          event: {
            id: index + 1,
            type: "assistant.delta",
            runId,
            timestamp,
            data: { delta: "x" },
          },
        })),
        {
          type: "event",
          event: {
            id: 2_101,
            type: "run.completed",
            runId,
            timestamp,
            data: { runtimeThreadId: "thread" },
          },
        },
      ];
      writeFileSync(
        journal,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      const adapter = new FakeRuntimeAdapter();
      const manager = new RunManager(
        new Map([[adapter.id, adapter]]),
        new SilentLogger(),
        60_000,
        journal,
      );
      const events = manager.openEventStream(runId, 0, () => {}).events;
      expect(events).toHaveLength(2_101);
      expect(events[0]?.id).toBe(1);
      expect(events.at(-1)?.id).toBe(2_101);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resumes a mapped thread without emitting thread.created", async () => {
    const { manager } = managerWith();
    manager.create(
      executionRequest({ thread: { runtimeThreadId: "thread-existing" } }),
    );
    await vi.waitFor(() => expect(manager.status("run-1")).toBe("completed"));
    const types = manager
      .openEventStream("run-1", 0, () => {})
      .events.map(({ type }) => type);
    expect(types).not.toContain("thread.created");
  });

  it("creates distinct runtime threads for consecutive fresh runs", async () => {
    const { adapter, manager } = managerWith();
    let threadIndex = 0;
    adapter.threadStart = () =>
      Promise.resolve(`thread-fresh-${(threadIndex += 1)}`);

    manager.create(executionRequest({ runId: "run-fresh-1" }));
    manager.create(executionRequest({ runId: "run-fresh-2" }));
    await vi.waitFor(() =>
      expect(manager.status("run-fresh-2")).toBe("completed"),
    );

    const createdIds = ["run-fresh-1", "run-fresh-2"].map(
      (runId) =>
        manager
          .openEventStream(runId, 0, () => {})
          .events.find(({ type }) => type === "thread.created")?.data
          .runtimeThreadId,
    );
    expect(createdIds).toEqual(["thread-fresh-1", "thread-fresh-2"]);
  });

  it("normalizes runtime failures without returning a stack", async () => {
    const { adapter, manager } = managerWith();
    adapter.turn = () =>
      Promise.reject(
        new Error("upstream failed with private internal details"),
      );
    manager.create(executionRequest());
    await vi.waitFor(() => expect(manager.status("run-1")).toBe("failed"));
    const failed = manager
      .openEventStream("run-1", 0, () => {})
      .events.find(({ type }) => type === "run.failed");
    expect(failed?.data).toEqual({
      error: {
        code: "UNKNOWN_RUNTIME_ERROR",
        message: "The runtime could not complete the run",
      },
    });
    expect(JSON.stringify(failed)).not.toContain("private internal details");
    expect(JSON.stringify(failed)).not.toContain("stack");
  });

  it("cancels a run before its thread is ready", async () => {
    const { adapter, manager } = managerWith();
    let releaseThread!: (threadId: string) => void;
    adapter.threadStart = () =>
      new Promise((resolve) => {
        releaseThread = resolve;
      });
    adapter.cancelRun = () =>
      Promise.reject(
        new RunnerError("RUN_NOT_FOUND", "Active run was not found", 404),
      );
    manager.create(executionRequest());
    await manager.cancel("run-1");
    releaseThread("thread-created");

    await vi.waitFor(() => expect(manager.status("run-1")).toBe("cancelled"));
    expect(
      manager
        .openEventStream("run-1", 0, () => {})
        .events.map(({ type }) => type),
    ).toEqual([
      "run.started",
      "context.bootstrap",
      "thread.created",
      "run.cancelled",
    ]);
  });

  it("tracks approval waiting state and forwards the decision", async () => {
    const { adapter, manager } = managerWith();
    let completeTurn!: () => void;
    let context!: RuntimeTurnContext;
    adapter.turn = (value) => {
      context = value;
      return new Promise((resolve) => {
        completeTurn = resolve;
      });
    };
    manager.create(executionRequest());
    await vi.waitFor(() => expect(context).toBeDefined());
    context.emit("approval.required", { approvalId: "approval-1" });
    expect(manager.status("run-1")).toBe("waiting_approval");

    await manager.respondToApproval("run-1", "approval-1", "approve");
    context.emit("approval.resolved", {
      approvalId: "approval-1",
      decision: "approve",
    });
    expect(manager.status("run-1")).toBe("running");
    expect(adapter.approvals).toEqual([
      { runId: "run-1", approvalId: "approval-1", decision: "approve" },
    ]);
    completeTurn();
    await vi.waitFor(() => expect(manager.status("run-1")).toBe("completed"));
  });
});
