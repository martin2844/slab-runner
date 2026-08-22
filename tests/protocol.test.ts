import { describe, expect, it } from "vitest";
import { parseExecutionRequest } from "../src/runtime/protocol.js";

describe("parseExecutionRequest", () => {
  it("parses the canonical public contract", () => {
    const request = parseExecutionRequest({
      runId: "run-123",
      agent: {
        id: "coo",
        name: "COO",
        role: "Operations",
        instructions: "Classify work.",
        fullAccess: true,
      },
      runtime: { type: "codex", model: null },
      thread: { runtimeThreadId: null },
      message: "Start",
      mcpServers: [
        {
          name: "work",
          url: "https://work.example.test/mcp",
          credentials: { bearerToken: "secret-value" },
        },
      ],
    });

    expect(request.runId).toBe("run-123");
    expect(request.mcpServers[0]?.headers.Authorization).toBe(
      "Bearer secret-value",
    );
    expect(request.context).toEqual([]);
    expect(request.agent.fullAccess).toBe(true);
  });

  it("accepts the current control-plane aliases without exposing them downstream", () => {
    const request = parseExecutionRequest({
      run_id: "run-legacy",
      runtime: "codex",
      model: "gpt-test",
      runtime_thread_id: "thread-1",
      agent: {
        name: "Sales",
        role: "Sales",
        instructions: "Follow up.",
      },
      prompt: "Continue",
      mcp_servers: {
        docs: {
          url: "http://127.0.0.1:6980/mcp",
          headers: { "X-API-Key": "docs-key" },
        },
      },
    });

    expect(request).toMatchObject({
      runId: "run-legacy",
      runtime: { type: "codex", model: "gpt-test" },
      thread: { runtimeThreadId: "thread-1" },
      message: "Continue",
      agent: { id: "Sales" },
    });
    expect(request.mcpServers[0]?.name).toBe("docs");
    expect(request.agent.fullAccess).toBe(false);
  });

  it("accepts a PostHog MCP tool server from the control plane", () => {
    const request = parseExecutionRequest({
      runId: "run-posthog",
      agent: {
        id: "coo",
        name: "COO",
        role: "Operations",
        instructions: "Use analytics evidence.",
      },
      runtime: { type: "codex", model: null },
      thread: { runtimeThreadId: null },
      message: "Review activation",
      mcpServers: [
        {
          name: "posthog",
          url: "http://127.0.0.1:3009/api/integrations/posthog/mcp",
          credentials: { bearerToken: "local-mcp-token" },
        },
      ],
    });

    expect(request.mcpServers[0]).toMatchObject({
      name: "posthog",
      headers: { Authorization: "Bearer local-mcp-token" },
    });
  });

  it("accepts scoped Email MCP approval overrides", () => {
    const request = parseExecutionRequest({
      runId: "run-email",
      agent: {
        id: "sales",
        name: "Sales",
        role: "Sales",
        instructions: "Use email carefully.",
        fullAccess: true,
      },
      runtime: { type: "codex", model: null },
      thread: { runtimeThreadId: null },
      message: "Prepare a follow-up",
      mcpServers: [
        {
          name: "email",
          url: "http://127.0.0.1:6981/mcp",
          credentials: { bearerToken: "scoped-token" },
          approval: {
            defaultMode: "approve",
            tools: { email_send: "prompt", email_reply: "prompt" },
          },
        },
      ],
    });

    expect(request.mcpServers[0]).toMatchObject({
      name: "email",
      headers: { Authorization: "Bearer scoped-token" },
      approval: {
        defaultMode: "approve",
        tools: { email_send: "prompt", email_reply: "prompt" },
      },
    });
  });

  it("accepts safe dynamic MCP server names for custom integrations", () => {
    const request = parseExecutionRequest({
      runId: "run-custom-http",
      agent: {
        id: "coo",
        name: "COO",
        role: "Operations",
        instructions: "Use configured business metrics.",
      },
      runtime: { type: "codex", model: null },
      thread: { runtimeThreadId: null },
      message: "Review company metrics",
      mcpServers: [
        {
          name: "custom_http_agent_metrics_api",
          url: "http://slab-agents:3009/api/integrations/example/mcp?run=run-custom-http",
          credentials: { bearerToken: "run-scoped-token" },
        },
      ],
    });

    expect(request.mcpServers[0]).toMatchObject({
      name: "custom_http_agent_metrics_api",
      headers: { Authorization: "Bearer run-scoped-token" },
    });
  });

  it.each([
    [{ runtime: { type: "claude" } }],
    [
      {
        mcpServers: [
          {
            name: "unsafe.server/name",
            url: "https://example.test/mcp",
            headers: {},
          },
        ],
      },
    ],
    [
      {
        mcpServers: [
          {
            name: "work",
            url: "https://user:password@example.test/mcp",
            headers: {},
          },
        ],
      },
    ],
    [{ cwd: "relative/path" }],
  ])("rejects invalid or unsafe input", (override) => {
    expect(() =>
      parseExecutionRequest({
        runId: "run-1",
        agent: {
          id: "coo",
          name: "COO",
          role: "Operations",
          instructions: "Operate.",
        },
        runtime: { type: "codex", model: null },
        thread: { runtimeThreadId: null },
        message: "Start",
        mcpServers: [],
        ...override,
      }),
    ).toThrow();
  });
});
