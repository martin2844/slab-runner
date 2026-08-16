import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonLogger } from "../src/lib/logger.js";
import { Redactor } from "../src/lib/redactor.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("JsonLogger", () => {
  it("writes structured output and redacts secrets from messages and fields", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const redactor = new Redactor();
    redactor.add("registered-secret");
    const logger = new JsonLogger(redactor);

    logger.info("connected with registered-secret", {
      token: "raw-token",
      nested: { authorization: "Bearer registered-secret" },
    });

    const output = String(stdout.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      level: "info",
      message: "connected with [REDACTED]",
      token: "[REDACTED]",
      nested: { authorization: "[REDACTED]" },
    });
    expect(output).not.toContain("registered-secret");
    expect(output).not.toContain("raw-token");
  });

  it("routes errors to stderr", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    new JsonLogger().error("runtime crash", { runtime: "codex" });
    expect(String(stderr.mock.calls[0]?.[0])).toContain('"level":"error"');
  });
});
