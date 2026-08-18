import { describe, expect, it } from "vitest";
import {
  measurePayload,
  measureText,
  summarizeSearchTool,
} from "../src/lib/observability.js";
import { Redactor } from "../src/lib/redactor.js";

describe("observability measurements", () => {
  it("measures raw payload size while redacting its preview", () => {
    const redactor = new Redactor();
    redactor.add("very-secret-value");
    const payload = {
      apiKey: "unknown-secret",
      authorization: "Bearer very-secret-value",
      body: "use very-secret-value",
    };

    const measurement = measurePayload(payload, redactor);

    expect(measurement.bytes).toBe(Buffer.byteLength(JSON.stringify(payload)));
    expect(measurement.approxTokens).toBeGreaterThan(0);
    expect(measurement.preview).not.toContain("unknown-secret");
    expect(measurement.preview).not.toContain("very-secret-value");
    expect(measurement.preview).toContain("[REDACTED]");
  });

  it("caps text previews without changing raw size metrics", () => {
    const redactor = new Redactor();
    const text = "x".repeat(800);
    const measurement = measureText(text, redactor, 300);

    expect(measurement.bytes).toBe(800);
    expect(measurement.approxTokens).toBe(200);
    expect(measurement.preview).toHaveLength(301);
    expect(measurement.preview.endsWith("…")).toBe(true);
  });
});

describe("search tool summaries", () => {
  it("captures a query and result identities without document bodies", () => {
    const summary = summarizeSearchTool(
      "search_docs",
      { query: "pricing" },
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data: [
                {
                  id: "doc-1",
                  slug: "pricing",
                  title: "Pricing",
                  body: "Do not persist this body",
                  score: 2.5,
                },
              ],
            }),
          },
        ],
      },
    );

    expect(summary).toEqual({
      query: "pricing",
      resultCount: 1,
      results: [
        {
          id: "doc-1",
          slug: "pricing",
          title: "Pricing",
          score: 2.5,
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain("Do not persist");
  });

  it("ignores non-search tools", () => {
    expect(summarizeSearchTool("get_doc", { id: "doc-1" }, {})).toBeNull();
  });
});
