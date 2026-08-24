import { describe, expect, it } from "vitest";
import {
  runtimeCapabilityKeys,
  type RuntimeAdapter,
} from "../../src/runtime/adapter.js";
import type {
  AgentExecutionRequest,
  RunnerEvent,
} from "../../src/runtime/protocol.js";

type CapturedEvent = Pick<RunnerEvent, "type" | "data">;

export interface RuntimeConformanceDriver {
  hangNextHealthProbe(): void;
  waitForTurnStart(): Promise<void>;
  emitAssistantDelta(text: string): void;
  emitAssistantCompleted(text: string): void;
  startTool(toolId: string): void;
  completeTool(toolId: string): void;
  failTool(toolId: string): void;
  emitUsage(): void;
  emitWarning(message: string, willRetry: boolean): void;
  requestApproval(requestId: number): void;
  approvalDecision(requestId: number): "approved" | "denied" | null;
  completeTurn(status: "completed" | "interrupted"): void;
  waitForCancellation(): Promise<void>;
  threadOperations(): Array<"start" | "resume">;
  configuredMcpServers(): string[];
  selectedModel(): string | null;
}

export interface RuntimeConformanceHarness {
  adapter: RuntimeAdapter;
  driver: RuntimeConformanceDriver;
  request: AgentExecutionRequest;
}

export interface RuntimeConformanceOptions {
  expectedRuntimeId: string;
  toolLifecycleSource?: "provider_events" | "adapter_owned";
  runtimeWarningWillRetry?: boolean;
  createHarness(): RuntimeConformanceHarness;
}

async function activeTurn(harness: RuntimeConformanceHarness) {
  const events: CapturedEvent[] = [];
  const completion = harness.adapter.runTurn({
    request: harness.request,
    runtimeThreadId: "conformance-thread",
    emit: (type, data = {}) => events.push({ type, data }),
  });
  await harness.driver.waitForTurnStart();
  return { ...harness, events, completion };
}

/**
 * Black-box tests for the provider-neutral RuntimeAdapter seam.
 *
 * A provider test supplies only a semantic driver for its external runtime.
 * The assertions below interact with RuntimeAdapter and normalized events, so
 * another provider cannot pass by exposing its native SDK lifecycle directly.
 */
export function defineRuntimeAdapterConformance(
  providerName: string,
  options: RuntimeConformanceOptions,
): void {
  describe(`${providerName} RuntimeAdapter conformance`, () => {
    it("starts and shuts down through the shared lifecycle", async () => {
      const { adapter } = options.createHarness();

      await expect(adapter.start()).resolves.toBeUndefined();
      await expect(adapter.shutdown()).resolves.toBeUndefined();
      await expect(adapter.health()).resolves.toMatchObject({
        available: false,
      });
    });

    it("publishes a complete, sanitized runtime definition and health result", async () => {
      const { adapter } = options.createHarness();
      const definition = adapter.definition;

      expect(Object.keys(definition).sort()).toEqual(
        ["authModes", "capabilities", "displayName", "id", "stability"].sort(),
      );
      expect(definition.id).toBe(options.expectedRuntimeId);
      expect(definition.id).toMatch(/^[a-z0-9_-]+$/);
      expect(definition.displayName.length).toBeGreaterThan(0);
      expect(definition.authModes.length).toBeGreaterThan(0);
      expect(Object.keys(definition.capabilities).sort()).toEqual(
        [...runtimeCapabilityKeys].sort(),
      );

      const health = await adapter.health();
      expect(Object.keys(health).sort()).toEqual(
        [
          "authentication",
          "available",
          "checkedAt",
          "reasonCode",
          "status",
        ].sort(),
      );
      expect(Object.keys(health.authentication).sort()).toEqual([
        "mode",
        "status",
      ]);
      expect(health.checkedAt).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(health.checkedAt))).toBe(false);
      expect(health.available).toBe(health.status === "available");
      expect(JSON.stringify({ definition, health }).toLowerCase()).not.toMatch(
        /bearer |refresh[_-]?token|password/,
      );
    });

    it("settles a provider health probe when its abort signal fires", async () => {
      const { adapter, driver } = options.createHarness();
      driver.hangNextHealthProbe();
      const controller = new AbortController();
      let timeout: NodeJS.Timeout | undefined;
      const probe = adapter.health(controller.signal).then(
        () => true,
        () => true,
      );

      controller.abort();
      const settled = await Promise.race([
        probe,
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), 100);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });

      expect(settled).toBe(true);
    });

    it("supports fresh and resumed runtime threads through the same interface", async () => {
      const { adapter, driver, request } = options.createHarness();
      const expectedOperations: Array<"start" | "resume"> = [];

      if (adapter.definition.capabilities.freshThreads) {
        await expect(adapter.startThread(request)).resolves.toEqual(
          expect.any(String),
        );
        expectedOperations.push("start");
      }
      if (adapter.definition.capabilities.threadResume) {
        const resumedRequest = {
          ...request,
          thread: { runtimeThreadId: "existing-runtime-thread" },
        };
        await expect(adapter.resumeThread(resumedRequest)).resolves.toBe(
          "existing-runtime-thread",
        );
        expectedOperations.push("resume");
      }
      expect(driver.threadOperations()).toEqual(expectedOperations);
    });

    it("applies run-scoped MCP servers and selected model to provider state", async () => {
      const harness = options.createHarness();
      const capabilities = harness.adapter.definition.capabilities;
      if (!capabilities.mcpServers && !capabilities.modelSelection) return;
      const executionRequest = capabilities.freshThreads
        ? harness.request
        : capabilities.threadResume
          ? {
              ...harness.request,
              thread: { runtimeThreadId: "conformance-thread" },
            }
          : harness.request;
      const runtimeThreadId = capabilities.freshThreads
        ? await harness.adapter.startThread(executionRequest)
        : capabilities.threadResume
          ? await harness.adapter.resumeThread(executionRequest)
          : "conformance-thread";
      const completion = harness.adapter.runTurn({
        request: executionRequest,
        runtimeThreadId,
        emit: () => {},
      });
      await harness.driver.waitForTurnStart();

      if (capabilities.mcpServers) {
        expect(harness.driver.configuredMcpServers().sort()).toEqual(
          harness.request.mcpServers.map(({ name }) => name).sort(),
        );
      }
      if (capabilities.modelSelection) {
        expect(harness.driver.selectedModel()).toBe(
          harness.request.runtime.model,
        );
      }
      harness.driver.completeTurn("completed");
      await expect(completion).resolves.toBeUndefined();
    });

    it("profiles runtime bootstrap without exposing run inputs or credentials", () => {
      const { adapter, request } = options.createHarness();

      if (!adapter.definition.capabilities.contextProfiling) return;
      const profile = adapter.contextProfile?.(request);
      expect(profile).toBeDefined();
      expect(profile).toMatchObject({ runtime: options.expectedRuntimeId });
      const serialized = JSON.stringify(profile);
      expect(serialized).not.toContain("work-secret");
      expect(serialized).not.toContain(request.message);
    });

    it("normalizes assistant, tool, usage, warning, and terminal lifecycle", async () => {
      const active = await activeTurn(options.createHarness());

      active.driver.emitAssistantDelta(
        "Conformance response containing work-secret",
      );
      active.driver.emitAssistantCompleted("Conformance response");
      const capabilities = active.adapter.definition.capabilities;
      if (capabilities.toolLifecycle) {
        active.driver.startTool("tool-1");
        active.driver.completeTool("tool-1");
      }
      if (capabilities.usageReporting) active.driver.emitUsage();
      if (capabilities.runtimeWarnings) {
        active.driver.emitWarning(
          "temporary provider warning containing work-secret",
          true,
        );
      }
      active.driver.completeTurn("completed");

      await expect(active.completion).resolves.toBeUndefined();
      const types = active.events.map(({ type }) => type);
      expect(types).toContain("assistant.delta");
      expect(types).toContain("assistant.completed");
      if (capabilities.toolLifecycle) {
        expect(types).toContain("tool.started");
        expect(types).toContain("tool.completed");
      }
      if (capabilities.usageReporting) expect(types).toContain("usage.updated");
      if (capabilities.runtimeWarnings) {
        expect(types).toContain("runtime.warning");
      }
      expect(JSON.stringify(active.events)).not.toContain("work-secret");
      if (capabilities.runtimeWarnings) {
        expect(
          active.events.find(({ type }) => type === "runtime.warning"),
        ).toMatchObject({
          type: "runtime.warning",
          data: { willRetry: options.runtimeWarningWillRetry ?? true },
        });
      }
      if (capabilities.toolLifecycle) {
        expect(
          active.events.filter(
            ({ type, data }) =>
              (type === "tool.completed" || type === "tool.failed") &&
              data.toolId === "tool-1",
          ),
        ).toHaveLength(1);
      }
    });

    it("normalizes an explicit provider tool failure", async () => {
      const active = await activeTurn(options.createHarness());
      if (!active.adapter.definition.capabilities.toolLifecycle) {
        active.driver.completeTurn("completed");
        await active.completion;
        return;
      }

      active.driver.startTool("tool-failed");
      active.driver.failTool("tool-failed");
      active.driver.completeTurn("completed");

      await active.completion;
      const terminals = active.events.filter(
        ({ type, data }) =>
          (type === "tool.completed" || type === "tool.failed") &&
          data.toolId === "tool-failed",
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({
        type: "tool.failed",
        data: {
          toolId: "tool-failed",
          success: false,
          reason: "provider_reported_failure",
        },
      });
    });

    it("fails every open tool exactly once when the turn omits its terminal event", async () => {
      const active = await activeTurn(options.createHarness());
      if (!active.adapter.definition.capabilities.toolLifecycle) {
        active.driver.completeTurn("completed");
        await active.completion;
        return;
      }

      if (options.toolLifecycleSource === "adapter_owned") {
        active.driver.startTool("tool-a");
        active.driver.failTool("tool-a");
        active.driver.completeTurn("completed");
        await expect(active.completion).resolves.toBeUndefined();
        expect(
          active.events.filter(
            ({ type, data }) =>
              (type === "tool.completed" || type === "tool.failed") &&
              data.toolId === "tool-a",
          ),
        ).toHaveLength(1);
        return;
      }

      active.driver.startTool("tool-a");
      active.driver.startTool("tool-b");
      active.driver.completeTurn("completed");

      await expect(active.completion).resolves.toBeUndefined();
      const failures = active.events.filter(
        ({ type }) => type === "tool.failed",
      );
      expect(failures).toHaveLength(2);
      expect(failures.map(({ data }) => data.toolId).sort()).toEqual([
        "tool-a",
        "tool-b",
      ]);
      for (const failure of failures) {
        expect(failure.data).toMatchObject({
          reason: "terminal_event_missing",
          success: false,
          status: "failed",
        });
      }
    });

    it("round-trips approval decisions without leaking provider semantics", async () => {
      const active = await activeTurn(options.createHarness());
      if (!active.adapter.definition.capabilities.toolApprovals) {
        active.driver.completeTurn("completed");
        await active.completion;
        return;
      }
      active.driver.requestApproval(701);

      await expect
        .poll(() =>
          active.events.find(({ type }) => type === "approval.required"),
        )
        .toBeDefined();

      const required = active.events.find(
        ({ type }) => type === "approval.required",
      );
      expect(required?.data.approvalId).toEqual(expect.any(String));
      await active.adapter.respondToApproval(
        active.request.runId,
        String(required?.data.approvalId),
        "approve",
      );

      expect(active.driver.approvalDecision(701)).toBe("approved");
      expect(
        active.events.find(({ type }) => type === "approval.resolved"),
      ).toMatchObject({
        type: "approval.resolved",
        data: { decision: "approve" },
      });
      active.driver.completeTurn("completed");
      await active.completion;
    });

    it("round-trips denied approvals", async () => {
      const active = await activeTurn(options.createHarness());
      if (!active.adapter.definition.capabilities.toolApprovals) {
        active.driver.completeTurn("completed");
        await active.completion;
        return;
      }
      active.driver.requestApproval(702);
      await expect
        .poll(() =>
          active.events.find(({ type }) => type === "approval.required"),
        )
        .toBeDefined();
      const required = active.events.find(
        ({ type }) => type === "approval.required",
      );

      await active.adapter.respondToApproval(
        active.request.runId,
        String(required?.data.approvalId),
        "deny",
      );

      expect(active.driver.approvalDecision(702)).toBe("denied");
      expect(
        active.events.find(({ type }) => type === "approval.resolved"),
      ).toMatchObject({ data: { decision: "deny" } });
      active.driver.completeTurn("completed");
      await active.completion;
    });

    it("cancels an active turn through a provider-neutral error", async () => {
      const active = await activeTurn(options.createHarness());
      if (!active.adapter.definition.capabilities.cancellation) {
        active.driver.completeTurn("completed");
        await active.completion;
        return;
      }

      await active.adapter.cancelRun(active.request.runId);
      await active.driver.waitForCancellation();
      active.driver.completeTurn("interrupted");

      await expect(active.completion).rejects.toMatchObject({
        code: "RUN_CANCELLED",
      });
    });
  });
}
