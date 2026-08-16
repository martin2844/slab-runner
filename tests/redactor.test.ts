import { describe, expect, it } from "vitest";
import { Redactor } from "../src/lib/redactor.js";

describe("Redactor", () => {
  it("removes registered credentials and secret-shaped fields recursively", () => {
    const redactor = new Redactor();
    redactor.addHeaders({ Authorization: "Bearer abcdef123456" });

    const result = redactor.value({
      message: "failed with abcdef123456",
      nested: { apiKey: "another-value", safe: "visible" },
      usage: { totalTokens: 120, inputTokens: 100, outputTokens: 20 },
    });

    expect(JSON.stringify(result)).not.toContain("abcdef123456");
    expect(JSON.stringify(result)).not.toContain("another-value");
    expect(result).toMatchObject({
      nested: { apiKey: "[REDACTED]", safe: "visible" },
      usage: { totalTokens: 120, inputTokens: 100, outputTokens: 20 },
    });
  });
});
