import type { AgentExecutionRequest, NormalizedEventType } from "./protocol.js";

export const runtimeCapabilityKeys = [
  "freshThreads",
  "threadResume",
  "mcpServers",
  "mcpToolAllowlist",
  "toolApprovals",
  "toolLifecycle",
  "runtimeWarnings",
  "usageReporting",
  "cancellation",
  "modelSelection",
  "modelDiscovery",
  "modelValidation",
  "contextProfiling",
] as const;

export type RuntimeCapability = (typeof runtimeCapabilityKeys)[number];
export type RuntimeCapabilities = Record<RuntimeCapability, boolean>;
export type RuntimeAuthMode =
  | "none"
  | "chatgpt"
  | "api_key"
  | "oauth"
  | "cloud_provider";

export interface RuntimeDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly stability: "stable" | "experimental";
  readonly authModes: readonly RuntimeAuthMode[];
  readonly capabilities: Readonly<RuntimeCapabilities>;
}

export type RuntimeHealthStatus =
  | "available"
  | "authentication_required"
  | "unavailable";

export interface RuntimeHealth {
  available: boolean;
  status: RuntimeHealthStatus;
  reasonCode:
    | "ready"
    | "not_started"
    | "authentication_required"
    | "health_check_failed";
  authentication: {
    status: "authenticated" | "required" | "unknown";
    mode: RuntimeAuthMode | null;
  };
  checkedAt: string;
}

export type RuntimeSummary = RuntimeDefinition & RuntimeHealth;

export function unavailableRuntimeHealth(): RuntimeHealth {
  return {
    available: false,
    status: "unavailable",
    reasonCode: "health_check_failed",
    authentication: { status: "unknown", mode: null },
    checkedAt: new Date().toISOString(),
  };
}

export const runtimeAdapterEventTypes = [
  "assistant.delta",
  "assistant.completed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "runtime.warning",
  "approval.required",
  "approval.resolved",
  "usage.updated",
] as const satisfies readonly NormalizedEventType[];

export type RuntimeAdapterEventType =
  (typeof runtimeAdapterEventTypes)[number];

export type RuntimeEventSink = (
  type: RuntimeAdapterEventType,
  data?: Record<string, unknown>,
) => void;

export interface RuntimeTurnContext {
  request: AgentExecutionRequest;
  runtimeThreadId: string;
  emit: RuntimeEventSink;
}

export type RuntimeContextProfile = Record<string, unknown>;

export interface RuntimeAdapter {
  readonly definition: RuntimeDefinition;
  start(): Promise<void>;
  health(signal?: AbortSignal): Promise<RuntimeHealth>;
  contextProfile?(request: AgentExecutionRequest): RuntimeContextProfile;
  startThread(request: AgentExecutionRequest): Promise<string>;
  resumeThread(request: AgentExecutionRequest): Promise<string>;
  runTurn(context: RuntimeTurnContext): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  respondToApproval(
    runId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<void>;
  shutdown(): Promise<void>;
}
