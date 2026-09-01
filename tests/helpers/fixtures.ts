import type { AgentExecutionRequest } from "../../src/runtime/protocol.js";

export function executionRequest(
  overrides: Partial<AgentExecutionRequest> = {},
): AgentExecutionRequest {
  return {
    runId: "run-1",
    agent: {
      id: "coo",
      name: "COO",
      role: "Operate the company",
      instructions: "Use Slab Work and Slab Docs.",
      permissionMode: "guarded",
      fullAccess: false,
    },
    runtime: { type: "codex", model: null },
    thread: { runtimeThreadId: null },
    message: "Classify the new requests.",
    context: [],
    mcpServers: [
      {
        name: "work",
        url: "http://127.0.0.1:6969/mcp",
        headers: { Authorization: "Bearer work-secret" },
      },
      {
        name: "docs",
        url: "http://127.0.0.1:6980/mcp",
        headers: { Authorization: "Bearer docs-secret" },
      },
    ],
    cwd: null,
    ...overrides,
  };
}
