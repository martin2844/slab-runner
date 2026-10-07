import { describe, expect, it } from "vitest";
import { normalizeRuntimeError, publicError } from "../src/runtime/errors.js";

describe("runtime failure explanations", () => {
  it("explains exhausted quota and keeps only the provider's retry date", () => {
    const error = publicError(new Error(
      "You've hit your usage limit. Upgrade to Plus (https://private.example/token-secret), or try again at Nov 2nd, 2026 4:05 PM.",
    ));
    expect(error.code).toBe("RUNTIME_USAGE_LIMIT_EXCEEDED");
    expect(error.message).toContain("usage limit");
    expect(error.message).toContain("Nov 2nd, 2026 4:05 PM");
    expect(error.message).not.toContain("private.example");
    expect(error.message).not.toContain("token-secret");
  });

  it("explains quota failures without exposing unrecognized retry text", () => {
    const error = publicError(new Error("insufficient_quota: try again at secret-account@example.com"));
    expect(error.code).toBe("RUNTIME_USAGE_LIMIT_EXCEEDED");
    expect(error.message).toContain("Retry after quota is restored");
    expect(error.message).not.toContain("secret-account");
  });

  it("explains unsupported models without exposing raw provider details", () => {
    const error = publicError(new Error("The 'private-model' model is not supported when using Codex with a ChatGPT account."));
    expect(error.code).toBe("RUNTIME_MODEL_UNSUPPORTED");
    expect(error.message).toContain("Choose a supported model");
    expect(error.message).not.toContain("private-model");
  });

  it.each(["refresh_token_reused", "Your access token has expired", "Incorrect API key provided: secret-key"])(
    "explains credential failure: %s",
    (message) => {
      const error = publicError(new Error(message));
      expect(error.code).toBe("RUNTIME_AUTHENTICATION_REQUIRED");
      expect(error.message).toContain("Reconnect the account");
      expect(error.message).not.toContain("secret-key");
    },
  );

  it("keeps unknown failures private", () => {
    expect(publicError(new Error("private internal details"))).toEqual({
      code: "UNKNOWN_RUNTIME_ERROR",
      message: "The runtime could not complete the run",
    });
  });

  it.each([
    "MCP initialization failed: invalid_api_key",
    "MCP connection failed: authentication token expired",
    "MCP initialize failed: model_not_found",
    "MCP connection failed: insufficient_quota",
  ])("keeps integration failures distinct from runtime account failures: %s", (message) => {
    expect(publicError(new Error(message))).toEqual({
      code: "MCP_CONNECTION_FAILED",
      message: "An allowed MCP server could not be reached",
    });
  });

  it("preserves thread recovery when a missing thread error includes model details", () => {
    expect(publicError(new Error("Thread does not exist; model_not_found"))).toEqual({
      code: "THREAD_NOT_FOUND",
      message: "Runtime thread was not found",
    });
  });

  it("preserves an already normalized explanation", () => {
    const error = normalizeRuntimeError(new Error("insufficient_quota"));
    expect(normalizeRuntimeError(error)).toBe(error);
    expect(error.httpStatus).toBe(429);
  });
});
