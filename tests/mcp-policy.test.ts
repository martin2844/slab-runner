import { describe, expect, it } from "vitest";
import {
  effectiveMcpToolMode,
  effectiveMcpToolPolicy,
} from "../src/runtime/mcp-policy.js";
import type { McpServerDefinition } from "../src/runtime/protocol.js";

const work: McpServerDefinition = {
  name: "work",
  url: "https://work.example.test/mcp",
  headers: {},
};

describe("MCP tool policy", () => {
  it("preserves legacy full-access and read-only defaults", () => {
    expect(effectiveMcpToolMode(work, "get_issue", false)).toBe("approve");
    expect(effectiveMcpToolMode(work, "assign_issue", false)).toBe("prompt");
    expect(effectiveMcpToolMode(work, "assign_issue", true)).toBe("approve");
  });

  it("resolves explicit allow, ask, and deny modes before the default", () => {
    const scoped: McpServerDefinition = {
      ...work,
      approval: {
        defaultMode: "deny",
        tools: {
          get_issue: "approve",
          assign_issue: "approve",
          set_issue_status: "prompt",
        },
      },
    };

    expect(effectiveMcpToolPolicy(scoped, true)).toEqual(scoped.approval);
    expect(effectiveMcpToolMode(scoped, "get_issue", true)).toBe("approve");
    expect(effectiveMcpToolMode(scoped, "set_issue_status", true)).toBe(
      "prompt",
    );
    expect(effectiveMcpToolMode(scoped, "delete_issue", true)).toBe("deny");
  });

  it("does not treat inherited object properties as explicit tool rules", () => {
    const scoped: McpServerDefinition = {
      ...work,
      approval: { defaultMode: "deny", tools: {} },
    };

    expect(effectiveMcpToolMode(scoped, "constructor", true)).toBe("deny");
    expect(effectiveMcpToolMode(scoped, "toString", true)).toBe("deny");
  });
});
