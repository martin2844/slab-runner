import { describe, expect, it, vi } from "vitest";
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
