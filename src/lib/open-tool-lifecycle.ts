import type { RuntimeEventSink } from "../runtime/adapter.js";

export interface OpenToolStart {
  timestampMs: number;
  data: Record<string, unknown>;
}

interface FailOpenToolsInput<T extends OpenToolStart> {
  emit: RuntimeEventSink;
  starts: Map<string, T>;
  terminalIds: Set<string>;
  completedAt?: Date;
  normalize?: (toolId: string, event: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Closes every provider tool that never emitted its own terminal event.
 * Adapters share this invariant even though their native event formats differ.
 */
export function failOpenTools<T extends OpenToolStart>({
  emit,
  starts,
  terminalIds,
  completedAt = new Date(),
  normalize = (_toolId, event) => event,
}: FailOpenToolsInput<T>): void {
  for (const [toolId, start] of starts) {
    if (terminalIds.has(toolId)) continue;
    emit(
      "tool.failed",
      normalize(toolId, {
        ...start.data,
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - start.timestampMs),
        success: false,
        status: "failed",
        reason: "terminal_event_missing",
      })
    );
    terminalIds.add(toolId);
  }
  starts.clear();
}
