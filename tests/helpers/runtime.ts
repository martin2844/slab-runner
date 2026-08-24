import type {
  RuntimeDefinition,
  RuntimeHealth,
} from "../../src/runtime/adapter.js";

export const TEST_RUNTIME_DEFINITION = {
  id: "codex",
  displayName: "Test Runtime",
  stability: "stable",
  authModes: ["chatgpt"],
  capabilities: {
    freshThreads: true,
    threadResume: true,
    mcpServers: true,
    mcpToolAllowlist: false,
    toolApprovals: true,
    toolLifecycle: true,
    runtimeWarnings: true,
    usageReporting: true,
    cancellation: true,
    modelSelection: true,
    modelDiscovery: false,
    modelValidation: false,
    contextProfiling: true,
    budgetIncrementalUsage: false,
    budgetNativeTokenLimit: false,
    budgetNativeCostLimit: false,
  },
} satisfies RuntimeDefinition;

export function testRuntimeHealth(available = true): RuntimeHealth {
  return available
    ? {
        available: true,
        status: "available",
        reasonCode: "ready",
        authentication: { status: "authenticated", mode: "chatgpt" },
        checkedAt: "2026-08-24T00:00:00.000Z",
      }
    : {
        available: false,
        status: "unavailable",
        reasonCode: "health_check_failed",
        authentication: { status: "unknown", mode: null },
        checkedAt: "2026-08-24T00:00:00.000Z",
      };
}
