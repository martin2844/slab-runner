import type OpenAI from "openai";
import { expect } from "vitest";
import {
  DirectApiAdapter,
  type DirectApiClientFactory,
} from "../src/adapters/direct-api-adapter.js";
import {
  McpToolClient,
  type DiscoveredMcpTool,
} from "../src/adapters/mcp-tool-client.js";
import type { McpServerDefinition } from "../src/runtime/protocol.js";
import {
  defineRuntimeAdapterConformance,
  type RuntimeConformanceDriver,
} from "./conformance/runtime-adapter.js";
import { executionRequest } from "./helpers/fixtures.js";

type StreamEvent = Record<string, unknown>;

class ControlledStream implements AsyncIterable<StreamEvent> {
  readonly #events: StreamEvent[] = [];
  readonly #waiters: Array<(value: IteratorResult<StreamEvent>) => void> = [];
  #ended = false;

  push(event: StreamEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.#events.push(event);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: () => {
        const event = this.#events.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.#ended)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function completedResponse(
  output: StreamEvent[],
  text: string,
  withUsage: boolean,
): StreamEvent {
  return {
    id: `response-${crypto.randomUUID()}`,
    object: "response",
    created_at: 1,
    completed_at: 2,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "direct-test",
    output,
    output_text: text,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: withUsage
      ? {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 120,
        }
      : null,
    user: null,
    metadata: {},
  };
}

class FakeDirectMcp extends McpToolClient {
  servers: McpServerDefinition[] = [];

  constructor(private readonly driver: DirectDriver) {
    super();
  }

  override connect(servers: McpServerDefinition[]): Promise<void> {
    this.servers = servers;
    return Promise.resolve();
  }

  override definitions(): DiscoveredMcpTool[] {
    const server = this.servers[0];
    if (!server) return [];
    return ["list_issues", "approval_tool"].map((tool) => ({
      providerName: `mcp__work__${tool}`,
      server,
      tool,
      description: tool,
      inputSchema: { type: "object", properties: {} },
    }));
  }

  override get(name: string): DiscoveredMcpTool | null {
    return (
      this.definitions().find(({ providerName }) => providerName === name) ??
      null
    );
  }

  override call(definition: DiscoveredMcpTool): Promise<unknown> {
    return this.driver.toolResult(definition.tool);
  }

  override close(): Promise<void> {
    return Promise.resolve();
  }
}

class DirectDriver implements RuntimeConformanceDriver {
  readonly requests: Array<Record<string, unknown>> = [];
  readonly operations: Array<"start" | "resume"> = [];
  readonly #turnWaiters: Array<() => void> = [];
  readonly #toolOutcomes = new Map<string, "complete" | "fail">();
  readonly #approvalDecisions = new Map<number, "approved" | "denied">();
  #current: ControlledStream | null = null;
  #pendingTools: Array<{ id: string; tool: string }> = [];
  #toolFlushScheduled = false;
  #finalText = "Conformance response";
  #usage = false;
  #warning: { message: string; willRetry: boolean } | null = null;
  #terminal: "completed" | "interrupted" | null = null;
  #cancelled = false;
  #lastApprovalRequest: number | null = null;

  readonly clientFactory: DirectApiClientFactory = () =>
    ({
      responses: {
        create: (
          request: Record<string, unknown>,
          options?: { signal?: AbortSignal },
        ) => {
          this.requests.push(request);
          const stream = new ControlledStream();
          this.#current = stream;
          options?.signal?.addEventListener(
            "abort",
            () => {
              this.#cancelled = true;
              stream.end();
            },
            { once: true },
          );
          for (const waiter of this.#turnWaiters.splice(0)) waiter();
          this.deliverTerminal();
          return Promise.resolve(stream);
        },
      },
    }) as unknown as OpenAI;

  waitForTurnStart(): Promise<void> {
    if (this.#current) return Promise.resolve();
    return new Promise((resolve) => this.#turnWaiters.push(resolve));
  }

  hangNextHealthProbe(): void {}

  emitAssistantDelta(text: string): void {
    this.#current?.push({ type: "response.output_text.delta", delta: text });
  }

  emitAssistantCompleted(text: string): void {
    this.#finalText = text;
  }

  startTool(toolId: string): void {
    this.#pendingTools.push({ id: toolId, tool: "list_issues" });
    this.scheduleToolFlush();
  }

  completeTool(toolId: string): void {
    this.#toolOutcomes.set(toolId, "complete");
  }

  failTool(toolId: string): void {
    this.#toolOutcomes.set(toolId, "fail");
  }

  emitUsage(): void {
    this.#usage = true;
  }

  emitWarning(message: string, willRetry: boolean): void {
    this.#warning = { message, willRetry };
  }

  requestApproval(requestId: number): void {
    this.#lastApprovalRequest = requestId;
    this.#pendingTools.push({
      id: `approval-${requestId}`,
      tool: "approval_tool",
    });
    this.scheduleToolFlush();
  }

  recordApprovalDecision(decision: "approve" | "deny"): void {
    if (this.#lastApprovalRequest === null) return;
    this.#approvalDecisions.set(
      this.#lastApprovalRequest,
      decision === "approve" ? "approved" : "denied",
    );
    if (decision === "approve") {
      this.#toolOutcomes.set(
        `approval-${this.#lastApprovalRequest}`,
        "complete",
      );
    }
  }

  approvalDecision(requestId: number): "approved" | "denied" | null {
    return this.#approvalDecisions.get(requestId) ?? null;
  }

  completeTurn(status: "completed" | "interrupted"): void {
    this.#terminal = status;
    this.deliverTerminal();
  }

  waitForCancellation(): Promise<void> {
    return expect.poll(() => this.#cancelled).toBe(true);
  }

  threadOperations(): Array<"start" | "resume"> {
    return [...this.operations];
  }

  configuredMcpServers(): string[] {
    const tools = this.requests[0]?.tools;
    return Array.isArray(tools) && tools.length > 0 ? ["work"] : [];
  }

  selectedModel(): string | null {
    const model = this.requests[0]?.model;
    return typeof model === "string" ? model : null;
  }

  toolResult(tool: string): Promise<unknown> {
    const call = [...this.#toolOutcomes.entries()].find(([id]) =>
      tool === "approval_tool"
        ? id.startsWith("approval-")
        : id.startsWith("tool-"),
    );
    if (!call || call[1] === "fail") {
      return Promise.reject(new Error("provider tool failed"));
    }
    this.#toolOutcomes.delete(call[0]);
    return Promise.resolve({ content: [{ type: "text", text: "[]" }] });
  }

  private scheduleToolFlush(): void {
    if (this.#toolFlushScheduled) return;
    this.#toolFlushScheduled = true;
    queueMicrotask(() => {
      this.#toolFlushScheduled = false;
      const calls = this.#pendingTools.splice(0).map(({ id, tool }) => ({
        id: `item-${id}`,
        type: "function_call",
        call_id: id,
        name: `mcp__work__${tool}`,
        arguments: "{}",
        status: "completed",
      }));
      const stream = this.#current;
      if (!stream) return;
      stream.push({
        type: "response.completed",
        response: completedResponse(calls, "", false),
      });
      stream.end();
      this.#current = null;
    });
  }

  private deliverTerminal(): void {
    if (
      !this.#terminal ||
      this.#pendingTools.length > 0 ||
      this.#toolFlushScheduled
    )
      return;
    const stream = this.#current;
    if (!stream) return;
    if (this.#warning) {
      stream.push({
        type: "error",
        code: "provider_warning",
        message: this.#warning.message,
      });
    }
    if (this.#terminal === "completed") {
      stream.push({
        type: "response.completed",
        response: completedResponse(
          [
            {
              id: "message-final",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: this.#finalText }],
            },
          ],
          this.#finalText,
          this.#usage,
        ),
      });
    }
    stream.end();
    this.#current = null;
  }
}

defineRuntimeAdapterConformance("Direct API", {
  expectedRuntimeId: "direct_api",
  toolLifecycleSource: "adapter_owned",
  runtimeWarningWillRetry: false,
  createHarness() {
    const driver = new DirectDriver();
    const adapter = new DirectApiAdapter(
      driver.clientFactory,
      () => new FakeDirectMcp(driver),
    );
    const startThread = adapter.startThread.bind(adapter);
    const resumeThread = adapter.resumeThread.bind(adapter);
    adapter.startThread = async (request) => {
      driver.operations.push("start");
      return startThread(request);
    };
    adapter.resumeThread = async (request) => {
      driver.operations.push("resume");
      return resumeThread(request);
    };
    const respond = adapter.respondToApproval.bind(adapter);
    adapter.respondToApproval = async (runId, approvalId, decision) => {
      driver.recordApprovalDecision(decision);
      return respond(runId, approvalId, decision);
    };
    return {
      adapter,
      driver,
      request: executionRequest({
        runtime: {
          type: "direct_api",
          model: "direct-test",
          authentication: {
            mode: "api_key",
            credential: "direct-conformance-key",
            baseUrl: "https://provider.invalid/v1",
            apiFormat: "responses",
          },
        },
        mcpServers: [
          {
            name: "work",
            url: "https://work.invalid/mcp",
            headers: { Authorization: "Bearer work-secret" },
            approval: {
              defaultMode: "approve",
              tools: { approval_tool: "prompt" },
            },
          },
        ],
      }),
    };
  },
});
