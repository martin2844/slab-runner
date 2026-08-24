import { expect } from "vitest";
import { CodexAdapter } from "../src/adapters/codex-adapter.js";
import { defineRuntimeAdapterConformance } from "./conformance/runtime-adapter.js";
import { executionRequest } from "./helpers/fixtures.js";
import { FakeAppServerConnection } from "./helpers/fake-connection.js";

defineRuntimeAdapterConformance("Codex", {
  expectedRuntimeId: "codex",
  createHarness() {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = (method, params) => {
      if (method === "account/read") {
        return Promise.resolve({
          account: { type: "chatgpt", email: "operator@example.test" },
          requiresOpenaiAuth: true,
        });
      }
      if (method === "thread/start") {
        return Promise.resolve({ thread: { id: "fresh-runtime-thread" } });
      }
      if (method === "thread/resume") {
        const threadId = (params as { threadId?: unknown }).threadId;
        return Promise.resolve({ thread: { id: threadId } });
      }
      if (method === "turn/start") {
        return Promise.resolve({ turn: { id: "conformance-turn" } });
      }
      return Promise.resolve({});
    };
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");

    return {
      adapter,
      request: executionRequest({
        runtime: { type: "codex", model: "conformance-model" },
      }),
      driver: {
        async waitForTurnStart() {
          await expect
            .poll(() =>
              connection.requests.some(({ method }) => method === "turn/start"),
            )
            .toBe(true);
        },
        emitAssistantDelta(text: string) {
          connection.serverNotification({
            method: "item/agentMessage/delta",
            params: {
              threadId: "conformance-thread",
              turnId: "conformance-turn",
              itemId: "message-1",
              delta: text,
            },
          });
        },
        emitAssistantCompleted(text: string) {
          connection.serverNotification({
            method: "item/completed",
            params: {
              threadId: "conformance-thread",
              turnId: "conformance-turn",
              item: {
                type: "agentMessage",
                id: "message-1",
                text,
                phase: "final_answer",
              },
            },
          });
        },
        startTool(toolId: string) {
          connection.serverNotification({
            method: "item/started",
            params: {
              threadId: "conformance-thread",
              turnId: "conformance-turn",
              item: {
                type: "mcpToolCall",
                id: toolId,
                server: "work",
                tool: "list_issues",
                status: "inProgress",
                arguments: { project_key: "COO" },
              },
            },
          });
        },
        completeTool(toolId: string) {
          connection.serverNotification({
            method: "item/completed",
            params: {
              threadId: "conformance-thread",
              turnId: "conformance-turn",
              item: {
                type: "mcpToolCall",
                id: toolId,
                server: "work",
                tool: "list_issues",
                status: "completed",
                arguments: { project_key: "COO" },
                result: { content: [{ type: "text", text: "[]" }] },
              },
            },
          });
        },
        failTool(toolId: string) {
          connection.serverNotification({
            method: "item/completed",
            params: {
              threadId: "conformance-thread",
              turnId: "conformance-turn",
              item: {
                type: "mcpToolCall",
                id: toolId,
                server: "work",
                tool: "list_issues",
                status: "failed",
                arguments: { project_key: "COO" },
                error: { message: "provider tool failure" },
              },
            },
          });
        },
        emitUsage() {
          connection.serverNotification({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "conformance-thread",
              turnId: "conformance-turn",
              tokenUsage: {
                total: {
                  inputTokens: 10,
                  cachedInputTokens: 4,
                  outputTokens: 2,
                  totalTokens: 12,
                },
                last: {
                  inputTokens: 10,
                  cachedInputTokens: 4,
                  outputTokens: 2,
                  totalTokens: 12,
                },
                modelContextWindow: 128_000,
              },
            },
          });
        },
        emitWarning(message: string, willRetry: boolean) {
          connection.serverNotification({
            method: "error",
            params: {
              threadId: "conformance-thread",
              turnId: "conformance-turn",
              error: { message, code: "TRANSIENT" },
              willRetry,
            },
          });
        },
        requestApproval(requestId: number) {
          connection.serverRequest({
            id: requestId,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "conformance-thread",
              turnId: "conformance-turn",
              itemId: "approval-tool",
              command: "date",
            },
          });
        },
        approvalDecision(requestId: number) {
          const response = connection.responses.find(
            ({ id }) => id === requestId,
          )?.result as { decision?: unknown } | undefined;
          if (response?.decision === "accept") return "approved";
          if (response?.decision === "decline") return "denied";
          return null;
        },
        completeTurn(status: "completed" | "interrupted") {
          connection.serverNotification({
            method: "turn/completed",
            params: {
              threadId: "conformance-thread",
              turn: { id: "conformance-turn", status },
            },
          });
        },
        async waitForCancellation() {
          await expect
            .poll(() =>
              connection.requests.some(
                ({ method }) => method === "turn/interrupt",
              ),
            )
            .toBe(true);
        },
        threadOperations() {
          return connection.requests.flatMap(({ method }) => {
            if (method === "thread/start") return ["start" as const];
            if (method === "thread/resume") return ["resume" as const];
            return [];
          });
        },
        configuredMcpServers() {
          const start = connection.requests.find(
            ({ method }) => method === "thread/start",
          );
          const params = start?.params as
            | { config?: { mcp_servers?: Record<string, unknown> } }
            | undefined;
          return Object.keys(params?.config?.mcp_servers ?? {});
        },
        selectedModel() {
          const start = connection.requests.find(
            ({ method }) => method === "thread/start",
          );
          const model = (start?.params as { model?: unknown } | undefined)
            ?.model;
          return typeof model === "string" ? model : null;
        },
      },
    };
  },
});
