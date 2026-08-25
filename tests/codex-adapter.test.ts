import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapters/codex-adapter.js";
import type { RunnerEvent } from "../src/runtime/protocol.js";
import { executionRequest } from "./helpers/fixtures.js";
import { FakeAppServerConnection } from "./helpers/fake-connection.js";

type CapturedEvent = Pick<RunnerEvent, "type" | "data">;

async function activeTurn(request = executionRequest()) {
  const connection = new FakeAppServerConnection();
  const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");
  const events: CapturedEvent[] = [];
  const completion = adapter.runTurn({
    request,
    runtimeThreadId: "thread-1",
    emit: (type, data = {}) => events.push({ type, data }),
  });
  await vi.waitFor(() => {
    expect(
      connection.requests.some(({ method }) => method === "turn/start"),
    ).toBe(true);
  });
  return { adapter, connection, events, completion };
}

describe("CodexAdapter", () => {
  it("reports Codex unavailable before the app-server is ready", async () => {
    const connection = new FakeAppServerConnection();
    connection.ready = false;
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");

    await expect(adapter.health()).resolves.toMatchObject({
      available: false,
      status: "unavailable",
      reasonCode: "not_started",
      authentication: { status: "unknown", mode: null },
    });
    expect(connection.requests).toEqual([]);
  });

  it("reports Codex unavailable when app-server has no authenticated account", async () => {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = (method, params) => {
      expect(method).toBe("account/read");
      expect(params).toEqual({ refreshToken: false });
      return Promise.resolve({ account: null, requiresOpenaiAuth: true });
    };
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");

    await expect(adapter.health()).resolves.toMatchObject({
      available: false,
      status: "authentication_required",
      reasonCode: "authentication_required",
      authentication: { status: "required", mode: null },
    });
  });

  it("reports Codex available when app-server has an authenticated account", async () => {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = () =>
      Promise.resolve({
        account: { type: "chatgpt", email: "operator@example.com" },
        requiresOpenaiAuth: true,
      });
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");

    await expect(adapter.health()).resolves.toMatchObject({
      available: true,
      status: "available",
      reasonCode: "ready",
      authentication: { status: "authenticated", mode: "chatgpt" },
    });
  });

  it.each([
    ["chatgpt", "chatgpt"],
    ["apiKey", "api_key"],
    ["amazonBedrock", "cloud_provider"],
  ] as const)(
    "maps the Codex %s account to the normalized %s auth mode",
    async (accountType, mode) => {
      const connection = new FakeAppServerConnection();
      connection.requestHandler = () =>
        Promise.resolve({ account: { type: accountType } });
      const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");

      await expect(adapter.health()).resolves.toMatchObject({
        available: true,
        authentication: { status: "authenticated", mode },
      });
    },
  );

  it("fails health closed for an unknown Codex account type", async () => {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = () =>
      Promise.resolve({ account: { type: "future-provider" } });
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");

    await expect(adapter.health()).resolves.toMatchObject({
      available: false,
      status: "unavailable",
      reasonCode: "health_check_failed",
      authentication: { status: "unknown", mode: null },
    });
  });

  it("reports Codex unavailable when account inspection fails or is malformed", async () => {
    const connection = new FakeAppServerConnection();
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");

    connection.requestHandler = () => Promise.reject(new Error("rpc failed"));
    await expect(adapter.health()).resolves.toMatchObject({
      available: false,
      status: "unavailable",
      reasonCode: "health_check_failed",
    });

    connection.requestHandler = () => Promise.resolve({});
    await expect(adapter.health()).resolves.toMatchObject({
      available: false,
      status: "unavailable",
      reasonCode: "health_check_failed",
    });
  });

  it("creates a thread with isolated cwd, agent instructions, and allowed MCP servers", async () => {
    const connection = new FakeAppServerConnection();
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");

    await expect(adapter.startThread(executionRequest())).resolves.toBe(
      "thread-1",
    );
    const call = connection.requests.find(
      ({ method }) => method === "thread/start",
    );

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
            default_tools_approval_mode: "prompt",
            tools: {
              list_projects: { approval_mode: "approve" },
              list_issues: { approval_mode: "approve" },
            },
          },
          docs: {
            url: "http://127.0.0.1:6980/mcp",
            http_headers: { Authorization: "Bearer docs-secret" },
            required: true,
            default_tools_approval_mode: "prompt",
            tools: {
              list_docs: { approval_mode: "approve" },
              get_doc: { approval_mode: "approve" },
            },
          },
        },
      },
    });
    expect(JSON.stringify(call?.params)).toContain(
      "You are the Slab agent named COO",
    );
    expect(JSON.stringify(call?.params)).not.toContain('"create_issue"');
    expect(JSON.stringify(call?.params)).not.toContain('"create_doc"');
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

  it("configures all Work and Docs tools as approved for a full-access agent", async () => {
    const connection = new FakeAppServerConnection();
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");
    const request = executionRequest();
    request.agent.fullAccess = true;

    await adapter.startThread(request);
    const call = connection.requests.find(
      ({ method }) => method === "thread/start",
    );

    expect(call?.params).toMatchObject({
      config: {
        mcp_servers: {
          work: { default_tools_approval_mode: "approve" },
          docs: { default_tools_approval_mode: "approve" },
        },
      },
    });
    expect(JSON.stringify(call?.params)).not.toContain(
      '"approval_mode":"prompt"',
    );
  });

  it("keeps Email send behind approval even for a full-access agent", async () => {
    const request = executionRequest({
      mcpServers: [
        {
          name: "email",
          url: "http://127.0.0.1:6981/mcp",
          headers: { Authorization: "Bearer scoped-email-token" },
          approval: {
            defaultMode: "approve",
            tools: { email_send: "prompt", email_reply: "prompt" },
          },
        },
      ],
    });
    request.agent.fullAccess = true;
    const connection = new FakeAppServerConnection();
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");

    await adapter.startThread(request);
    const call = connection.requests.find(
      ({ method }) => method === "thread/start",
    );
    expect(call?.params).toMatchObject({
      config: {
        mcp_servers: {
          email: {
            default_tools_approval_mode: "approve",
            tools: {
              email_send: { approval_mode: "prompt" },
              email_reply: { approval_mode: "prompt" },
            },
          },
        },
      },
    });
  });

  it("does not auto-approve an explicitly prompted Email send", async () => {
    const request = executionRequest({
      mcpServers: [
        {
          name: "email",
          url: "http://127.0.0.1:6981/mcp",
          headers: { Authorization: "Bearer scoped-email-token" },
          approval: {
            defaultMode: "approve",
            tools: { email_send: "prompt" },
          },
        },
      ],
    });
    request.agent.fullAccess = true;
    const { connection, events, completion } = await activeTurn(request);
    connection.serverRequest({
      id: 191,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "email",
        message: 'Allow the email MCP server to run tool "email_send"?',
      },
    });

    expect(connection.responses).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "approval.required",
      data: { server: "email" },
    });
    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await completion;
  });

  it("includes the pending Email payload in the approval event", async () => {
    const request = executionRequest({
      mcpServers: [
        {
          name: "email",
          url: "http://127.0.0.1:6981/mcp",
          headers: { Authorization: "Bearer scoped-email-token" },
          approval: {
            defaultMode: "approve",
            tools: { email_send: "prompt" },
          },
        },
      ],
    });
    const { connection, events, completion } = await activeTurn(request);
    connection.serverNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "email-call-1",
          type: "mcpToolCall",
          server: "email",
          tool: "email_send",
          arguments: {
            accountId: "account-1",
            expectedFrom: "clara@clasific.ar",
            to: ["buyer@example.com"],
            subject: "Follow-up",
            text: "Hello",
            idempotencyKey: "email-once",
          },
        },
      },
    });
    connection.serverRequest({
      id: 192,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "email",
        message: 'Allow the email MCP server to run tool "email_send"?',
      },
    });

    expect(events.at(-1)).toMatchObject({
      type: "approval.required",
      data: {
        server: "email",
        tool: "email_send",
        toolId: "email-call-1",
        toolArguments: {
          accountId: "account-1",
          expectedFrom: "clara@clasific.ar",
          to: ["buyer@example.com"],
          subject: "Follow-up",
          text: "Hello",
        },
      },
    });

    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await completion;
  });

  it("fails closed when an Email approval cannot be correlated uniquely", async () => {
    const request = executionRequest({
      mcpServers: [
        {
          name: "email",
          url: "http://127.0.0.1:6981/mcp",
          headers: { Authorization: "Bearer scoped-email-token" },
          approval: {
            defaultMode: "approve",
            tools: { email_send: "prompt" },
          },
        },
      ],
    });
    const { connection, events, completion } = await activeTurn(request);
    for (const [id, recipient] of [
      ["email-call-a", "a@example.com"],
      ["email-call-b", "b@example.com"],
    ]) {
      connection.serverNotification({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id,
            type: "mcpToolCall",
            server: "email",
            tool: "email_send",
            arguments: {
              expectedFrom: "clara@clasific.ar",
              to: [recipient],
              subject: "Follow-up",
              text: "Hello",
            },
          },
        },
      });
    }
    connection.serverRequest({
      id: 193,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "email",
        message: 'Allow the email MCP server to run tool "email_send"?',
      },
    });

    const required = events.at(-1);
    expect(required).toMatchObject({
      type: "approval.required",
      data: { server: "email" },
    });
    expect(required?.data).not.toHaveProperty("toolArguments");
    expect(required?.data).not.toHaveProperty("toolId");

    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await completion;
  });

  it("does not persist full approval arguments for non-Email MCP tools", async () => {
    const { connection, events, completion } = await activeTurn();
    connection.serverNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "work-call-1",
          type: "mcpToolCall",
          server: "work",
          tool: "create_issue",
          arguments: { description: "private work payload" },
        },
      },
    });
    connection.serverRequest({
      id: 194,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "work",
        message: 'Allow the work MCP server to run tool "create_issue"?',
      },
    });

    const required = events.at(-1);
    expect(required?.data).not.toHaveProperty("toolArguments");
    expect(JSON.stringify(required)).not.toContain("private work payload");

    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await completion;
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
          arguments: { project_key: "COO", api_key: "work-secret" },
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
          arguments: { project_key: "COO", api_key: "work-secret" },
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ issues: [{ key: "COO-4" }] }),
              },
            ],
            structuredContent: null,
            _meta: null,
          },
          error: null,
          durationMs: 20,
        },
      },
    });
    connection.serverNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 12,
            inputTokens: 10,
            cachedInputTokens: 6,
            outputTokens: 2,
            reasoningOutputTokens: 1,
          },
          last: {
            totalTokens: 12,
            inputTokens: 10,
            cachedInputTokens: 6,
            outputTokens: 2,
            reasoningOutputTokens: 1,
          },
          modelContextWindow: 128_000,
        },
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
      server: "work",
      tool: "list_issues",
    });
    expect(typeof events[1]?.data.argumentsBytes).toBe("number");
    expect(typeof events[1]?.data.argumentsApproxTokens).toBe("number");
    expect(events[2]?.data).toMatchObject({
      toolId: "tool-1",
      success: true,
      durationMs: 20,
    });
    expect(typeof events[2]?.data.responseBytes).toBe("number");
    expect(typeof events[2]?.data.responseApproxTokens).toBe("number");
    expect(String(events[2]?.data.responsePreview)).toContain("COO-4");
    expect(events[2]?.data).not.toHaveProperty("debugResponsePayload");
    expect(events[3]?.data).toMatchObject({
      total: { totalTokens: 12 },
      callIndex: 1,
      inputTokens: 10,
      cachedInputTokens: 6,
      uncachedInputTokens: 4,
      outputTokens: 2,
      reasoningOutputTokens: 1,
      modelContextWindow: 128_000,
    });
  });

  it("treats status-less Codex read tools as successful when they complete", async () => {
    const { connection, events, completion } = await activeTurn();
    for (const item of [
      {
        type: "webSearch",
        id: "search-1",
        query: "Slab runtime adapter",
        action: null,
        results: [],
      },
      {
        type: "imageView",
        id: "image-1",
        path: "/tmp/screenshot.png",
      },
      {
        type: "sleep",
        id: "sleep-1",
        durationMs: 250,
      },
    ]) {
      connection.serverNotification({
        method: "item/started",
        params: { threadId: "thread-1", turnId: "turn-1", item },
      });
      connection.serverNotification({
        method: "item/completed",
        params: { threadId: "thread-1", turnId: "turn-1", item },
      });
    }
    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });

    await completion;
    expect(
      events
        .filter(({ type }) => type === "tool.completed")
        .map(({ data }) => [data.toolId, data.success]),
    ).toEqual([
      ["search-1", true],
      ["image-1", true],
      ["sleep-1", true],
    ]);
    expect(
      events.find(
        ({ type, data }) =>
          type === "tool.started" && data.toolId === "sleep-1",
      ),
    ).toMatchObject({
      data: {
        name: "clock.sleep",
        tool: "clock.sleep",
        argumentsPreview: '{"durationMs":250}',
      },
    });
    expect(events.some(({ type }) => type === "tool.failed")).toBe(false);
  });

  it("uses the native image-generation failure field for terminal status", async () => {
    const { connection, events, completion } = await activeTurn();
    connection.serverNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "imageGeneration",
          id: "image-generation-1",
          status: "failed",
          revisedPrompt: null,
          result: "",
          failure: { message: "generation failed" },
        },
      },
    });
    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });

    await completion;
    expect(events.find(({ type }) => type === "tool.failed")).toMatchObject({
      type: "tool.failed",
      data: {
        toolId: "image-generation-1",
        success: false,
        reason: "provider_reported_failure",
      },
    });
  });

  it("fails a started tool when the turn ends without a terminal item", async () => {
    const { connection, events, completion } = await activeTurn();
    connection.serverNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "open-tool",
          server: "work",
          tool: "get_issue",
          status: "inProgress",
          arguments: { key: "COO-8" },
        },
      },
    });
    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });

    await completion;
    expect(events.map(({ type }) => type)).toEqual([
      "tool.started",
      "tool.failed",
    ]);
    expect(events[1]?.data).toMatchObject({
      toolId: "open-tool",
      runId: "run-1",
      server: "work",
      tool: "get_issue",
      kind: "mcpToolCall",
      status: "failed",
      success: false,
      reason: "terminal_event_missing",
    });
    expect(events[1]?.data).toHaveProperty("startedAt");
    expect(events[1]?.data).toHaveProperty("completedAt");
    expect(typeof events[1]?.data.durationMs).toBe("number");
    expect(events[1]?.data).not.toHaveProperty("responsePreview");
  });

  it("does not emit a duplicate failure after normal tool completion", async () => {
    const { connection, events, completion } = await activeTurn();
    const item = {
      type: "mcpToolCall",
      id: "closed-tool",
      server: "docs",
      tool: "get_doc",
      status: "inProgress",
      arguments: { id: "doc-1" },
    };
    connection.serverNotification({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item },
    });
    connection.serverNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { ...item, status: "completed", result: { content: [] } },
      },
    });
    connection.serverNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { ...item, status: "completed", result: { content: [] } },
      },
    });
    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });

    await completion;
    expect(events.filter(({ type }) => type === "tool.completed")).toHaveLength(
      1,
    );
    expect(events.filter(({ type }) => type === "tool.failed")).toHaveLength(0);
  });

  it("terminalizes every open tool when a turn ends", async () => {
    const { connection, events, completion } = await activeTurn();
    for (const id of ["open-1", "open-2", "open-3"]) {
      connection.serverNotification({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id,
            server: "docs",
            tool: "search_docs",
            arguments: { query: id },
          },
        },
      });
    }
    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });

    await completion;
    const failures = events.filter(({ type }) => type === "tool.failed");
    expect(failures).toHaveLength(3);
    expect(failures.map(({ data }) => data.toolId)).toEqual([
      "open-1",
      "open-2",
      "open-3",
    ]);
  });

  it("publishes sanitized runtime warnings without failing recovered turns", async () => {
    const { connection, events, completion } = await activeTurn();
    connection.serverNotification({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-warning",
        willRetry: true,
        error: {
          message: "MCP call interrupted with Bearer work-secret",
          code: "MCP_INTERRUPTED",
          type: "transport",
        },
      },
    });
    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });

    await expect(completion).resolves.toBeUndefined();
    const warning = events.find(({ type }) => type === "runtime.warning");
    expect(warning?.data).toMatchObject({
      code: "MCP_INTERRUPTED",
      type: "transport",
      willRetry: true,
      itemId: "tool-warning",
    });
    expect(String(warning?.data.message)).toContain("[REDACTED]");
    expect(JSON.stringify(warning)).not.toContain("work-secret");
  });

  it("emits compact search query and result metadata for retrieval debugging", async () => {
    const { connection, events, completion } = await activeTurn();
    connection.serverNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "search-1",
          server: "docs",
          tool: "search_docs",
          status: "completed",
          arguments: { query: "Autocorp pricing" },
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  data: [
                    {
                      id: "doc-1",
                      slug: "pricing",
                      title: "Pricing",
                      body: "large body must not be copied",
                      score: 3.2,
                    },
                  ],
                }),
              },
            ],
          },
        },
      },
    });
    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await completion;

    const completed = events.find(({ type }) => type === "tool.completed");
    expect(completed?.data).toMatchObject({
      searchQuery: "Autocorp pricing",
      searchResultCount: 1,
      searchResults: [
        { id: "doc-1", slug: "pricing", title: "Pricing", score: 3.2 },
      ],
    });
    expect(JSON.stringify(completed?.data.searchResults)).not.toContain(
      "large body",
    );
  });

  it("can opt into full sanitized tool payload capture for local debugging", async () => {
    vi.stubEnv("RUNNER_OBSERVABILITY_FULL_PAYLOADS", "true");
    try {
      const { connection, events, completion } = await activeTurn();
      connection.serverNotification({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "tool-debug",
            server: "docs",
            tool: "get_doc",
            status: "completed",
            arguments: { apiKey: "unknown-secret", id: "doc-1" },
            result: {
              content: [{ type: "text", text: "Bearer docs-secret" }],
            },
            error: null,
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
      await completion;

      const debugEvent = events.find(({ type }) => type === "tool.completed");
      expect(debugEvent?.data).toHaveProperty("debugArgumentsPayload");
      expect(debugEvent?.data).toHaveProperty("debugResponsePayload");
      expect(JSON.stringify(debugEvent)).not.toContain("unknown-secret");
      expect(JSON.stringify(debugEvent)).not.toContain("docs-secret");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("captures redacted shell commands and aggregate output metrics", async () => {
    const { connection, events, completion } = await activeTurn();
    connection.serverNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "shell-1",
          command: "curl -H 'Authorization: Bearer work-secret' example.test",
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
          type: "commandExecution",
          id: "shell-1",
          command: "curl -H 'Authorization: Bearer work-secret' example.test",
          aggregatedOutput: "request failed with work-secret",
          status: "failed",
          exitCode: 1,
          durationMs: 35,
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

    await completion;
    const failedEvent = events.find(({ type }) => type === "tool.failed");
    expect(failedEvent?.data).toMatchObject({
      server: "runtime",
      tool: "shell",
      exitCode: 1,
      success: false,
      reason: "provider_reported_failure",
      streamBreakdownAvailable: false,
      stdoutBytes: null,
      stderrBytes: null,
    });
    expect(String(failedEvent?.data.command)).toContain("[REDACTED]");
    expect(typeof failedEvent?.data.outputBytes).toBe("number");
    expect(typeof failedEvent?.data.outputApproxTokens).toBe("number");
    expect(JSON.stringify(failedEvent)).not.toContain("work-secret");
  });

  it("reports only controlled bootstrap sizes without prompt contents or secrets", () => {
    const connection = new FakeAppServerConnection();
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");
    const profile = adapter.contextProfile(
      executionRequest({
        context: [{ role: "user", body: "Earlier request" }],
      }),
    );

    expect(profile).toMatchObject({
      runtime: "codex",
      estimator: "characters_divided_by_4",
      rehydratedConversationContextApprox: { messageCount: 1 },
      mcpConfiguration: { serverCount: 2 },
    });
    const developerInstructions = profile.developerInstructionsTotal as Record<
      string,
      unknown
    >;
    const turnInput = profile.turnInputTotal as Record<string, unknown>;
    expect(typeof developerInstructions.bytes).toBe("number");
    expect(typeof developerInstructions.approxTokens).toBe("number");
    expect(typeof turnInput.bytes).toBe("number");
    expect(typeof turnInput.approxTokens).toBe("number");
    expect(JSON.stringify(profile)).not.toContain("work-secret");
    expect(JSON.stringify(profile)).not.toContain("Classify the new requests");
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

    await adapter.respondToApproval("run-1", String(approvalId), "approve");
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

  it("auto-approves allowlisted read-only MCP tools", async () => {
    const { connection, events, completion } = await activeTurn();
    connection.serverRequest({
      id: 45,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "slab",
        message: 'Allow the slab MCP server to run tool "list_projects"?',
      },
    });

    expect(connection.responses).toEqual([
      {
        id: 45,
        result: { action: "accept", content: null, _meta: null },
      },
    ]);
    expect(events).toContainEqual({
      type: "approval.resolved",
      data: {
        decision: "auto",
        kind: "mcp_elicitation",
        server: "slab",
        tool: "list_projects",
      },
    });
    expect(events.some(({ type }) => type === "approval.required")).toBe(false);

    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await completion;
  });

  it("auto-approves the restricted PostHog analytics tools", async () => {
    const { connection, events, completion } = await activeTurn();
    connection.serverRequest({
      id: 145,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "posthog",
        message: 'Allow the posthog MCP server to run tool "query_analytics"?',
      },
    });

    expect(connection.responses).toEqual([
      {
        id: 145,
        result: { action: "accept", content: null, _meta: null },
      },
    ]);
    expect(events.some(({ type }) => type === "approval.required")).toBe(false);

    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await completion;
  });

  it("auto-approves dynamic MCP tools when the server policy allows them", async () => {
    const request = executionRequest();
    request.mcpServers.push({
      name: "custom_http_agent_metrics_api",
      url: "https://agents.example.test/api/integrations/metrics/mcp",
      headers: {},
      approval: { defaultMode: "approve", tools: {} },
    });
    const { connection, events, completion } = await activeTurn(request);
    connection.serverRequest({
      id: 146,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "custom_http_agent_metrics_api",
        message:
          'Allow the custom HTTP MCP server to run tool "agent_metrics_api__get_metrics_api_usage_users"?',
      },
    });

    expect(connection.responses).toEqual([
      {
        id: 146,
        result: { action: "accept", content: null, _meta: null },
      },
    ]);
    expect(events).toContainEqual({
      type: "approval.resolved",
      data: {
        decision: "auto",
        kind: "mcp_elicitation",
        server: "custom_http_agent_metrics_api",
        tool: "agent_metrics_api__get_metrics_api_usage_users",
      },
    });
    expect(events.some(({ type }) => type === "approval.required")).toBe(false);

    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await completion;
  });

  it("keeps mutating and unknown MCP tools behind manual approval", async () => {
    const { connection, events, completion } = await activeTurn();
    connection.serverRequest({
      id: 46,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "work",
        message: 'Allow the work MCP server to run tool "create_issue"?',
      },
    });

    expect(connection.responses).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "approval.required",
      data: {
        kind: "mcp_elicitation",
        server: "work",
        message: 'Allow the work MCP server to run tool "create_issue"?',
      },
    });

    connection.serverNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await completion;
  });

  it("auto-approves Work and Docs mutations for a full-access agent", async () => {
    const request = executionRequest();
    request.agent.fullAccess = true;
    const { connection, events, completion } = await activeTurn(request);
    connection.serverRequest({
      id: 47,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "work",
        message: 'Allow the work MCP server to run tool "create_issue"?',
      },
    });

    expect(connection.responses).toEqual([
      {
        id: 47,
        result: { action: "accept", content: null, _meta: null },
      },
    ]);
    expect(events.some(({ type }) => type === "approval.required")).toBe(false);

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
