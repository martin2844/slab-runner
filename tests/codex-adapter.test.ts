import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapters/codex-adapter.js";
import type { RunnerEvent } from "../src/runtime/protocol.js";
import { executionRequest } from "./helpers/fixtures.js";
import { FakeAppServerConnection } from "./helpers/fake-connection.js";

type CapturedEvent = Pick<RunnerEvent, "type" | "data">;

async function activeTurn() {
  const connection = new FakeAppServerConnection();
  const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");
  const events: CapturedEvent[] = [];
  const request = executionRequest();
  const completion = adapter.runTurn({
    request,
    runtimeThreadId: "thread-1",
    emit: (type, data = {}) => events.push({ type, data }),
  });
  await vi.waitFor(() => {
    expect(connection.requests.some(({ method }) => method === "turn/start")).toBe(
      true,
    );
  });
  return { adapter, connection, events, completion };
}

describe("CodexAdapter", () => {
  it("creates a thread with isolated cwd, agent instructions, and allowed MCP servers", async () => {
    const connection = new FakeAppServerConnection();
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");

    await expect(adapter.startThread(executionRequest())).resolves.toBe("thread-1");
    const call = connection.requests.find(({ method }) => method === "thread/start");

    expect(call?.params).toMatchObject({
      cwd: "/tmp/safe-runner-cwd",
      approvalPolicy: "on-request",
      sandbox: "read-only",
      serviceName: "slab_runner",
      config: {
        mcp_servers: {
          work: {
            url: "http://127.0.0.1:6969/mcp",
            http_headers: { Authorization: "Bearer work-secret" },
            required: true,
          },
          docs: {
            url: "http://127.0.0.1:6980/mcp",
            http_headers: { Authorization: "Bearer docs-secret" },
            required: true,
          },
        },
      },
    });
    expect(JSON.stringify(call?.params)).toContain("You are the Slab agent named COO");
  });

  it("resumes the supplied runtime thread", async () => {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = (method) =>
      Promise.resolve(
        method === "thread/resume" ? { thread: { id: "existing-thread" } } : {},
      );
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");

    await expect(
      adapter.resumeThread(
        executionRequest({ thread: { runtimeThreadId: "existing-thread" } }),
      ),
    ).resolves.toBe("existing-thread");
    expect(connection.requests[0]).toMatchObject({
      method: "thread/resume",
      params: { threadId: "existing-thread" },
    });
    expect(connection.requests[0]?.params).not.toHaveProperty("excludeTurns");
  });

  it("normalizes assistant, tool, usage, and completion events", async () => {
    const { connection, events, completion } = await activeTurn();

    connection.serverNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "Hello Bearer work-secret",
      },
    });
    connection.serverNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "tool-1",
          server: "work",
          tool: "list_issues",
          status: "inProgress",
        },
      },
    });
    connection.serverNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "tool-1",
          server: "work",
          tool: "list_issues",
          status: "completed",
          durationMs: 20,
        },
      },
    });
    connection.serverNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: { total: { totalTokens: 12 } },
      },
    });
    connection.serverNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "message-1",
          text: "Hello",
          phase: "final_answer",
        },
      },
    });
    connection.serverNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    await expect(completion).resolves.toBeUndefined();
    expect(events.map(({ type }) => type)).toEqual([
      "assistant.delta",
      "tool.started",
      "tool.completed",
      "usage.updated",
      "assistant.completed",
    ]);
    expect(JSON.stringify(events)).not.toContain("work-secret");
    expect(events[1]?.data).toMatchObject({
      toolId: "tool-1",
      kind: "mcpToolCall",
      name: "work.list_issues",
    });
    expect(events[3]?.data).toMatchObject({
      total: { totalTokens: 12 },
    });
  });

  it("keeps approval state in memory and maps approve to Codex accept", async () => {
    const { adapter, connection, events, completion } = await activeTurn();
    connection.serverRequest({
      id: 44,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        command: "curl -H 'Authorization: Bearer work-secret' example.test",
      },
    });
    const required = events.find(({ type }) => type === "approval.required");
    const approvalId = required?.data.approvalId;
    expect(approvalId).toEqual(expect.any(String));
    expect(JSON.stringify(required)).not.toContain("work-secret");

    await adapter.respondToApproval(
      "run-1",
      String(approvalId),
      "approve",
    );
    expect(connection.responses).toEqual([
      { id: 44, result: { decision: "accept" } },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "approval.resolved",
      data: { approvalId, decision: "approve" },
    });

    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await completion;
  });

  it("interrupts cancellation and reports a normalized cancellation", async () => {
    const { adapter, connection, completion } = await activeTurn();
    await adapter.cancelRun("run-1");
    expect(connection.requests.at(-1)).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "interrupted" } },
    });
    await expect(completion).rejects.toMatchObject({ code: "RUN_CANCELLED" });
  });

  it("fails active runs when app-server crashes", async () => {
    const { connection, completion } = await activeTurn();
    connection.crash();
    await expect(completion).rejects.toMatchObject({ code: "RUNTIME_CRASHED" });
  });
});
