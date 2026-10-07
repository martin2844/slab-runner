import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapters/codex-adapter.js";
import { executionRequest } from "./helpers/fixtures.js";
import { FakeAppServerConnection } from "./helpers/fake-connection.js";

describe("Codex failure explanations", () => {
  it.each(["object", "string", "message", "completion"])(
    "reports quota exhaustion from a %s error",
    async (shape) => {
      const connection = new FakeAppServerConnection();
      const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");
      const completion = adapter.runTurn({
        request: executionRequest(),
        runtimeThreadId: "thread-1",
        emit: () => {},
      });
      await vi.waitFor(() => {
        expect(connection.requests.some(({ method }) => method === "turn/start")).toBe(true);
      });
      const message = "You've hit your usage limit. Try again at Nov 2nd, 2026 4:05 PM.";
      const rejection = expect(completion).rejects.toMatchObject({
        code: "RUNTIME_USAGE_LIMIT_EXCEEDED",
        message: "The runtime account has reached its usage limit. Check the connected account and its plan or credits in runtime settings. The provider reports that you can retry at Nov 2nd, 2026 4:05 PM.",
      });
      if (shape !== "completion") {
        connection.serverNotification({
          method: "error",
          params: {
            threadId: "thread-1",
            ...(shape === "object" ? { error: { message } } : shape === "string" ? { error: message } : { message }),
            willRetry: false,
          },
        });
      }
      connection.serverNotification({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "failed", ...(shape === "completion" ? { error: { message } } : {}) },
        },
      });
      await rejection;
    },
  );
});
