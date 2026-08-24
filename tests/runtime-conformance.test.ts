import { expect } from "vitest";
import type {
  RuntimeAdapter,
  RuntimeDefinition,
  RuntimeEventSink,
  RuntimeHealth,
  RuntimeTurnContext,
} from "../src/runtime/adapter.js";
import type { AgentExecutionRequest } from "../src/runtime/protocol.js";
import {
  defineRuntimeAdapterConformance,
  type RuntimeConformanceDriver,
} from "./conformance/runtime-adapter.js";
import { executionRequest } from "./helpers/fixtures.js";

const STATELESS_RUNTIME_DEFINITION = {
  id: "stateless",
  displayName: "Stateless Test Runtime",
  stability: "experimental",
  authModes: ["none"],
  capabilities: {
    freshThreads: false,
    threadResume: true,
    mcpServers: true,
    mcpToolAllowlist: false,
    toolApprovals: false,
    toolLifecycle: false,
    runtimeWarnings: false,
    usageReporting: false,
    cancellation: false,
    modelSelection: true,
    modelDiscovery: false,
    modelValidation: false,
    contextProfiling: false,
  },
} satisfies RuntimeDefinition;

class StatelessTestAdapter implements RuntimeAdapter {
  readonly definition = STATELESS_RUNTIME_DEFINITION;
  started = true;
  threadStarts = 0;
  threadResumes = 0;
  configuredServers: string[] = [];
  configuredModel: string | null = null;
  hangHealth = false;
  emit: RuntimeEventSink | null = null;
  resolveTurn: (() => void) | null = null;

  emitAssistantDelta(text: string): void {
    this.emit?.("assistant.delta", {
      delta: text.replaceAll("work-secret", "[REDACTED]"),
    });
  }

  emitAssistantCompleted(text: string): void {
    this.emit?.("assistant.completed", {
      message: text.replaceAll("work-secret", "[REDACTED]"),
    });
  }

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  health(signal?: AbortSignal): Promise<RuntimeHealth> {
    const health = {
      available: this.started,
      status: this.started ? "available" : "unavailable",
      reasonCode: this.started ? "ready" : "not_started",
      authentication: {
        status: this.started ? "authenticated" : "unknown",
        mode: this.started ? "none" : null,
      },
      checkedAt: new Date().toISOString(),
    } satisfies RuntimeHealth;
    if (!this.hangHealth) return Promise.resolve(health);
    this.hangHealth = false;
    return new Promise((resolve) => {
      const aborted = () => resolve({
        available: false,
        status: "unavailable",
        reasonCode: "health_check_failed",
        authentication: { status: "unknown", mode: null },
        checkedAt: new Date().toISOString(),
      });
      if (signal?.aborted) aborted();
      else signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  startThread(): Promise<string> {
    this.threadStarts += 1;
    return Promise.reject(new Error("Fresh threads are unsupported"));
  }

  resumeThread(request: AgentExecutionRequest): Promise<string> {
    this.threadResumes += 1;
    return Promise.resolve(request.thread.runtimeThreadId ?? "stateless-thread");
  }

  runTurn(context: RuntimeTurnContext): Promise<void> {
    if (
      context.request.thread.runtimeThreadId !== null &&
      context.request.thread.runtimeThreadId !== context.runtimeThreadId
    ) {
      return Promise.reject(new Error("Runtime thread context is inconsistent"));
    }
    this.configuredServers = context.request.mcpServers.map(({ name }) => name);
    this.configuredModel = context.request.runtime.model;
    this.emit = context.emit;
    return new Promise<void>((resolve) => {
      this.resolveTurn = resolve;
    });
  }

  cancelRun(): Promise<void> {
    return Promise.resolve();
  }

  respondToApproval(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.started = false;
    this.resolveTurn?.();
    return Promise.resolve();
  }
}

defineRuntimeAdapterConformance("Stateless test adapter", {
  expectedRuntimeId: "stateless",
  createHarness() {
    const adapter = new StatelessTestAdapter();
    const driver: RuntimeConformanceDriver = {
      hangNextHealthProbe() {
        adapter.hangHealth = true;
      },
      async waitForTurnStart() {
        await expect.poll(() => adapter.emit !== null).toBe(true);
      },
      emitAssistantDelta(text) {
        adapter.emitAssistantDelta(text);
      },
      emitAssistantCompleted(text) {
        adapter.emitAssistantCompleted(text);
      },
      startTool() {},
      completeTool() {},
      failTool() {},
      emitUsage() {},
      emitWarning() {},
      requestApproval() {},
      approvalDecision() {
        return null;
      },
      completeTurn() {
        adapter.resolveTurn?.();
      },
      waitForCancellation() {
        return Promise.resolve();
      },
      threadOperations() {
        return [
          ...Array.from({ length: adapter.threadStarts }, () =>
            "start" as const,
          ),
          ...Array.from({ length: adapter.threadResumes }, () =>
            "resume" as const,
          ),
        ];
      },
      configuredMcpServers() {
        return adapter.configuredServers;
      },
      selectedModel() {
        return adapter.configuredModel;
      },
    };

    return {
      adapter,
      driver,
      request: executionRequest({
        runtime: { type: "stateless", model: "stateless-model" },
      }),
    };
  },
});
