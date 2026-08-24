import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { expect } from "vitest";
import {
  GeminiAdapter,
  type GeminiProcess,
  type GeminiProcessFactory,
} from "../src/adapters/gemini-adapter.js";
import type { AgentExecutionRequest } from "../src/runtime/protocol.js";
import { defineRuntimeAdapterConformance } from "./conformance/runtime-adapter.js";
import { executionRequest } from "./helpers/fixtures.js";

class FakeGeminiProcess extends EventEmitter implements GeminiProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  closed = false;
  killed = false;

  override once(
    event: "error" | "close",
    listener:
      | ((error: Error) => void)
      | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): this {
    return super.once(event, listener);
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killed = true;
    this.close(null, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }

  event(value: Record<string, unknown>): void {
    if (!this.closed) this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, signal));
  }
}

class FakeGeminiDriver {
  process: FakeGeminiProcess | null = null;
  turnStarted = false;
  hangHealth = false;
  selectedModelValue: string | null = null;
  configuredServers: string[] = [];
  assistantCompleted = "Conformance response";
  usageEnabled = false;
  readonly operations: Array<"start" | "resume"> = [];

  readonly factory: GeminiProcessFactory = (_executable, args, options) => {
    const process = new FakeGeminiProcess();
    if (args.includes("--version")) {
      queueMicrotask(() => process.close(0));
      return process;
    }
    this.process = process;
    this.turnStarted = true;
    const modelIndex = args.indexOf("--model");
    this.selectedModelValue = modelIndex >= 0 ? (args[modelIndex + 1] ?? null) : null;
    const settingsPath = options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    if (settingsPath) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      this.configuredServers = Object.keys(settings.mcpServers ?? {});
    }
    return process;
  };

  readonly authProbe = async (): Promise<boolean> => {
    if (!this.hangHealth) return true;
    return await new Promise<boolean>(() => undefined);
  };

  async waitForTurnStart(): Promise<void> {
    await expect.poll(() => this.turnStarted).toBe(true);
  }

  emitAssistantDelta(text: string): void {
    this.process?.event({
      type: "message",
      role: "assistant",
      content: text,
      delta: true,
    });
  }

  startTool(toolId: string): void {
    this.process?.event({
      type: "tool_use",
      tool_id: toolId,
      tool_name: "list_issues",
      parameters: { project_key: "COO" },
    });
  }

  completeTool(toolId: string, failed = false): void {
    this.process?.event({
      type: "tool_result",
      tool_id: toolId,
      status: failed ? "error" : "success",
      ...(failed
        ? { error: { type: "TOOL_EXECUTION_ERROR", message: "failed" } }
        : { output: "[]" }),
    });
  }

  emitWarning(message: string): void {
    this.process?.event({
      type: "error",
      severity: "warning",
      message,
      code: "RETRYABLE_WARNING",
    });
  }

  completeTurn(status: "completed" | "interrupted"): void {
    if (!this.process || this.process.closed) return;
    if (status === "interrupted") {
      this.process.close(null, "SIGTERM");
      return;
    }
    this.process.event({
      type: "message",
      role: "assistant",
      content: this.assistantCompleted,
      delta: true,
    });
    this.process.event({
      type: "result",
      status: "success",
      stats: this.usageEnabled
        ? {
            total_tokens: 120,
            input_tokens: 100,
            output_tokens: 20,
            cached: 40,
            duration_ms: 25,
            tool_calls: 1,
          }
        : {},
    });
    this.process.close(0);
  }
}

class ConformanceGeminiAdapter extends GeminiAdapter {
  constructor(
    private readonly driver: FakeGeminiDriver,
    processFactory: GeminiProcessFactory,
  ) {
    super(
      "/tmp",
      "/tmp/slab-gemini-conformance",
      "gemini",
      processFactory,
      driver.authProbe,
    );
  }

  override startThread(request: AgentExecutionRequest): Promise<string> {
    this.driver.operations.push("start");
    return super.startThread(request);
  }

  override resumeThread(request: AgentExecutionRequest): Promise<string> {
    this.driver.operations.push("resume");
    return super.resumeThread(request);
  }
}

function createHarness() {
  const driver = new FakeGeminiDriver();
  const adapter = new ConformanceGeminiAdapter(driver, driver.factory);
  return {
    adapter,
    request: executionRequest({
      runtime: { type: "gemini", model: "gemini-test", authentication: null },
    }),
    driver: {
      hangNextHealthProbe: () => {
        driver.hangHealth = true;
      },
      waitForTurnStart: () => driver.waitForTurnStart(),
      emitAssistantDelta: (text: string) => driver.emitAssistantDelta(text),
      emitAssistantCompleted: (text: string) => {
        driver.assistantCompleted = text;
      },
      startTool: (toolId: string) => driver.startTool(toolId),
      completeTool: (toolId: string) => driver.completeTool(toolId),
      failTool: (toolId: string) => driver.completeTool(toolId, true),
      emitUsage: () => {
        driver.usageEnabled = true;
      },
      emitWarning: (message: string) => driver.emitWarning(message),
      requestApproval: () => undefined,
      approvalDecision: () => null,
      completeTurn: (status: "completed" | "interrupted") =>
        driver.completeTurn(status),
      waitForCancellation: async () => {
        await expect.poll(() => driver.process?.killed).toBe(true);
      },
      threadOperations: () => driver.operations,
      configuredMcpServers: () => driver.configuredServers,
      selectedModel: () => driver.selectedModelValue,
    },
  };
}

defineRuntimeAdapterConformance("Gemini", {
  expectedRuntimeId: "gemini",
  runtimeWarningWillRetry: false,
  createHarness,
});
