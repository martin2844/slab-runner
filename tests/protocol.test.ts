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
  });

  it.each([
    [{ runtime: { type: "claude" } }],
    [
      {
        mcpServers: [
          { name: "other", url: "https://example.test/mcp", headers: {} },
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
