import type { AgentExecutionRequest, NormalizedEventType } from "./protocol.js";

export interface RuntimeHealth {
  id: string;
  available: boolean;
}

export type RuntimeEventSink = (
  type: NormalizedEventType,
  data?: Record<string, unknown>,
) => void;

export interface RuntimeTurnContext {
  request: AgentExecutionRequest;
  runtimeThreadId: string;
  emit: RuntimeEventSink;
}

export type RuntimeContextProfile = Record<string, unknown>;

export interface RuntimeAdapter {
  readonly id: string;
  start(): Promise<void>;
  health(): Promise<RuntimeHealth>;
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
