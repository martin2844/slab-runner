import { describe, expect, it, vi } from "vitest";
import { failOpenTools } from "../src/lib/open-tool-lifecycle.js";

describe("failOpenTools", () => {
  it("emits one terminal failure for each still-open tool", () => {
    const emit = vi.fn();
    const starts = new Map([
      ["open", { timestampMs: 900, data: { toolId: "open" } }],
      ["already-terminal", { timestampMs: 800, data: { toolId: "already-terminal" } }],
    ]);
    const terminalIds = new Set(["already-terminal"]);

    failOpenTools({
      emit,
      starts,
      terminalIds,
      completedAt: new Date(1_000),
    });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith("tool.failed", {
      toolId: "open",
      completedAt: new Date(1_000).toISOString(),
      durationMs: 100,
      success: false,
      status: "failed",
      reason: "terminal_event_missing",
    });
    expect(terminalIds).toEqual(new Set(["already-terminal", "open"]));
    expect(starts.size).toBe(0);
  });
});
