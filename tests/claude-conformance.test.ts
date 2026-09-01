import { expect, it } from "vitest";
import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeAdapter,
  CLAUDE_RUNTIME_DEFINITION,
  type ClaudeCredentialBoundary,
  type ClaudeQueryFactory,
} from "../src/adapters/claude-adapter.js";
import type { AnthropicCredentialLease } from "../src/adapters/anthropic-credential-proxy.js";
import { defineRuntimeAdapterConformance } from "./conformance/runtime-adapter.js";
import { executionRequest } from "./helpers/fixtures.js";

class FakeCredentialBoundary implements ClaudeCredentialBoundary {
  ready = true;

  start(): Promise<void> {
    this.ready = true;
    return Promise.resolve();
  }

  register(): AnthropicCredentialLease {
    return {
      baseUrl: "http://127.0.0.1:43123",
      credential: "surrogate-credential-for-tests",
      release() {},
    };
  }

  stop(): Promise<void> {
    this.ready = false;
    return Promise.resolve();
  }
}

class FakeQueryDriver {
  readonly #messages: SDKMessage[] = [];
  readonly #waiters: Array<(value: IteratorResult<SDKMessage, void>) => void> =
    [];
  #ended = false;
  #cancelled = false;
  #turnStarted = false;
  #assistantCompleted = "Conformance response";
  #usageEnabled = false;
  #options: Options | null = null;
  #approvalDecisions = new Map<number, "approved" | "denied">();

  readonly factory: ClaudeQueryFactory = (input) => {
    this.#options = input.options ?? {};
    this.#turnStarted = true;
    return this.query();
  };

  query(): Query {
    const iterator = {
      next: (): Promise<IteratorResult<SDKMessage, void>> => {
        const message = this.#messages.shift();
        if (message) return Promise.resolve({ done: false, value: message });
        if (this.#ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<SDKMessage, void>> => {
        this.end();
        return Promise.resolve({ done: true, value: undefined });
      },
      throw: (error?: unknown): Promise<IteratorResult<SDKMessage, void>> => {
        return Promise.reject(
          error instanceof Error ? error : new Error("Fake query failed"),
        );
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      interrupt: (): Promise<undefined> => {
        this.#cancelled = true;
        return Promise.resolve(undefined);
      },
      close: () => this.end(),
    };
    return iterator as unknown as Query;
  }

  push(message: SDKMessage): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.#messages.push(message);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  async waitForTurnStart(): Promise<void> {
    await expect.poll(() => this.#turnStarted).toBe(true);
  }

  emitAssistantDelta(text: string): void {
    this.push({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
      parent_tool_use_id: null,
      uuid: "message-delta",
      session_id: "conformance-thread",
    } as unknown as SDKMessage);
  }

  emitAssistantCompleted(text: string): void {
    this.#assistantCompleted = text;
  }

  startTool(toolId: string): void {
    this.push({
      type: "assistant",
      message: {
        id: "assistant-tool",
        role: "assistant",
        model: "claude-test",
        content: [
          {
            type: "tool_use",
            id: toolId,
            name: "mcp__work__list_issues",
            input: { project_key: "COO" },
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: {},
        type: "message",
      },
      parent_tool_use_id: null,
      uuid: `assistant-${toolId}`,
      session_id: "conformance-thread",
    } as unknown as SDKMessage);
  }

  completeTool(toolId: string, failed = false): void {
    this.push({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolId,
            content: "[]",
            is_error: failed,
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: `result-${toolId}`,
      session_id: "conformance-thread",
    } as unknown as SDKMessage);
  }

  emitWarning(message: string, willRetry: boolean): void {
    void message;
    this.push({
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: willRetry ? 3 : 1,
      retry_delay_ms: 10,
      error_status: 503,
      error: "server_error",
      uuid: "00000000-0000-4000-8000-000000000001",
      session_id: "conformance-thread",
    });
  }

  requestApproval(requestId: number): void {
    const callback = this.#options?.canUseTool;
    if (!callback) throw new Error("Claude permission callback was not set.");
    void callback(
      "Bash",
      { command: "echo approval" },
      {
        signal: new AbortController().signal,
        toolUseID: `approval-${requestId}`,
        requestId: `request-${requestId}`,
      },
    ).then((result: PermissionResult | null) => {
      if (!result) return;
      this.#approvalDecisions.set(
        requestId,
        result.behavior === "allow" ? "approved" : "denied",
      );
    });
  }

  completeTurn(status: "completed" | "interrupted"): void {
    this.push({
      type: "result",
      subtype: status === "completed" ? "success" : "error_during_execution",
      duration_ms: 25,
      duration_api_ms: 20,
      is_error: status !== "completed",
      num_turns: 1,
      stop_reason: status === "completed" ? "end_turn" : null,
      total_cost_usd: this.#usageEnabled ? 0.001 : 0,
      usage: {},
      modelUsage: this.#usageEnabled
        ? {
            "claude-test": {
              inputTokens: 100,
              outputTokens: 20,
              cacheReadInputTokens: 40,
              cacheCreationInputTokens: 10,
              webSearchRequests: 0,
              costUSD: 0.001,
              contextWindow: 200_000,
              maxOutputTokens: 8192,
            },
          }
        : {},
      permission_denials: [],
      ...(status === "completed"
        ? { result: this.#assistantCompleted }
        : { errors: ["interrupted"] }),
      uuid: "result-message",
      session_id: "conformance-thread",
    } as unknown as SDKMessage);
    this.end();
  }

  completeWithApiError(status: number, result: string): void {
    this.push({
      type: "result",
      subtype: "success",
      duration_ms: 25,
      duration_api_ms: 20,
      is_error: true,
      api_error_status: status,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      result,
      uuid: "api-error-result",
      session_id: "conformance-thread",
    } as unknown as SDKMessage);
    this.end();
  }

  completeWithBudgetError(): void {
    this.push({
      type: "result",
      subtype: "error_max_budget_usd",
      duration_ms: 25,
      duration_api_ms: 20,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 2,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      errors: ["Maximum budget reached"],
      uuid: "budget-error-result",
      session_id: "conformance-thread",
    } as unknown as SDKMessage);
    this.end();
  }

  set usageEnabled(value: boolean) {
    this.#usageEnabled = value;
  }

  get options(): Options | null {
    return this.#options;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  approvalDecision(requestId: number): "approved" | "denied" | null {
    return this.#approvalDecisions.get(requestId) ?? null;
  }
}

defineRuntimeAdapterConformance("Claude", {
  expectedRuntimeId: "claude",
  createHarness() {
    const provider = new FakeQueryDriver();
    const adapter = new ClaudeAdapter(
      "/tmp/safe-runner-cwd",
      new FakeCredentialBoundary(),
      provider.factory,
    );
    const threadOperations: Array<"start" | "resume"> = [];
    const startThread = adapter.startThread.bind(adapter);
    const resumeThread = adapter.resumeThread.bind(adapter);
    adapter.startThread = async (input) => {
      threadOperations.push("start");
      return startThread(input);
    };
    adapter.resumeThread = async (input) => {
      threadOperations.push("resume");
      return resumeThread(input);
    };
    const request = executionRequest({
      runtime: {
        type: "claude",
        model: "claude-test",
        authentication: {
          mode: "api_key",
          credential: "anthropic-test-credential",
        },
      },
    });

    return {
      adapter,
      request,
      driver: {
        hangNextHealthProbe() {},
        waitForTurnStart: () => provider.waitForTurnStart(),
        emitAssistantDelta: (text) => provider.emitAssistantDelta(text),
        emitAssistantCompleted: (text) => provider.emitAssistantCompleted(text),
        startTool: (toolId) => provider.startTool(toolId),
        completeTool: (toolId) => provider.completeTool(toolId),
        failTool: (toolId) => provider.completeTool(toolId, true),
        emitUsage() {
          provider.usageEnabled = true;
        },
        emitWarning: (message, willRetry) =>
          provider.emitWarning(message, willRetry),
        requestApproval: (requestId) => provider.requestApproval(requestId),
        approvalDecision: (requestId) => provider.approvalDecision(requestId),
        completeTurn: (status) => provider.completeTurn(status),
        async waitForCancellation() {
          await expect.poll(() => provider.cancelled).toBe(true);
        },
        threadOperations() {
          return threadOperations;
        },
        configuredMcpServers() {
          return Object.keys(provider.options?.mcpServers ?? {});
        },
        selectedModel() {
          return provider.options?.model ?? null;
        },
      },
    };
  },
});

it("keeps the Anthropic key outside the Claude child environment", async () => {
  const provider = new FakeQueryDriver();
  const boundary = new FakeCredentialBoundary();
  const adapter = new ClaudeAdapter(
    "/tmp/safe-runner-cwd",
    boundary,
    provider.factory,
  );
  const apiKey = "sk-ant-real-secret-never-in-child";
  const request = executionRequest({
    runtime: {
      type: "claude",
      model: "claude-test",
      authentication: { mode: "api_key", credential: apiKey },
    },
  });
  const runtimeThreadId = await adapter.startThread(request);
  const completion = adapter.runTurn({
    request,
    runtimeThreadId,
    emit: () => {},
  });
  await provider.waitForTurnStart();

  expect(provider.options?.sessionId).toBe(runtimeThreadId);
  expect(provider.options?.resume).toBeUndefined();
  expect(provider.options?.env?.ANTHROPIC_API_KEY).toBe(
    "surrogate-credential-for-tests",
  );
  expect(provider.options?.env?.ANTHROPIC_BASE_URL).toMatch(
    /^http:\/\/127\.0\.0\.1:/,
  );
  expect(JSON.stringify(provider.options)).not.toContain(apiKey);

  provider.completeTurn("completed");
  await expect(completion).resolves.toBeUndefined();
});

it("passes explicit yolo mode through Claude's dangerous permission gate", async () => {
  const provider = new FakeQueryDriver();
  const adapter = new ClaudeAdapter(
    "/tmp/safe-runner-cwd",
    new FakeCredentialBoundary(),
    provider.factory,
  );
  const request = executionRequest({
    agent: {
      ...executionRequest().agent,
      permissionMode: "yolo",
      fullAccess: true,
    },
    runtime: {
      type: "claude",
      model: "claude-test",
      authentication: {
        mode: "api_key",
        credential: "anthropic-yolo-test-credential",
      },
    },
  });
  const runtimeThreadId = await adapter.startThread(request);
  const completion = adapter.runTurn({
    request,
    runtimeThreadId,
    emit: () => {},
  });
  await provider.waitForTurnStart();

  expect(provider.options?.permissionMode).toBe("bypassPermissions");
  expect(provider.options?.allowDangerouslySkipPermissions).toBe(true);
  provider.completeTurn("completed");
  await completion;
});

it("passes the native cost limit to Claude and returns a structured budget failure", async () => {
  const provider = new FakeQueryDriver();
  const adapter = new ClaudeAdapter(
    "/tmp/safe-runner-cwd",
    new FakeCredentialBoundary(),
    provider.factory,
  );
  const request = executionRequest({
    runtime: {
      type: "claude",
      model: "claude-test",
      authentication: {
        mode: "api_key",
        credential: "anthropic-test-credential",
      },
    },
    budget: {
      maxTokens: null,
      maxCostUsd: 2,
      pricing: null,
    },
  });
  const runtimeThreadId = await adapter.startThread(request);
  const completion = adapter.runTurn({
    request,
    runtimeThreadId,
    emit: () => {},
  });
  await provider.waitForTurnStart();
  expect(provider.options?.maxBudgetUsd).toBe(2);
  expect(provider.options?.taskBudget).toBeUndefined();
  provider.completeWithBudgetError();
  await expect(completion).rejects.toMatchObject({
    code: "RUNTIME_BUDGET_EXCEEDED",
  });
});

it("rejects a hard Claude token ceiling instead of treating taskBudget as enforcement", async () => {
  const provider = new FakeQueryDriver();
  const adapter = new ClaudeAdapter(
    "/tmp/safe-runner-cwd",
    new FakeCredentialBoundary(),
    provider.factory,
  );
  const request = executionRequest({
    runtime: {
      type: "claude",
      model: "claude-test",
      authentication: {
        mode: "api_key",
        credential: "anthropic-test-credential",
      },
    },
    budget: {
      maxTokens: 12_000,
      maxCostUsd: null,
      pricing: null,
    },
  });
  const runtimeThreadId = await adapter.startThread(request);
  await expect(
    adapter.runTurn({ request, runtimeThreadId, emit: () => {} }),
  ).rejects.toMatchObject({ code: "RUNTIME_BUDGET_UNSUPPORTED" });
  expect(provider.options).toBeNull();
});

it("resumes only the runtime thread explicitly supplied by the control plane", async () => {
  const provider = new FakeQueryDriver();
  const adapter = new ClaudeAdapter(
    "/tmp/safe-runner-cwd",
    new FakeCredentialBoundary(),
    provider.factory,
  );
  const request = executionRequest({
    runtime: {
      type: "claude",
      model: "claude-test",
      authentication: {
        mode: "api_key",
        credential: "anthropic-test-credential",
      },
    },
    thread: { runtimeThreadId: "existing-claude-session" },
  });
  const runtimeThreadId = await adapter.resumeThread(request);
  const completion = adapter.runTurn({
    request,
    runtimeThreadId,
    emit: () => {},
  });
  await provider.waitForTurnStart();

  expect(provider.options?.resume).toBe("existing-claude-session");
  expect(provider.options?.sessionId).toBeUndefined();

  provider.completeTurn("completed");
  await expect(completion).resolves.toBeUndefined();
});

it("reports missing Claude authentication as a provider auth failure", async () => {
  const adapter = new ClaudeAdapter(
    "/tmp/safe-runner-cwd",
    new FakeCredentialBoundary(),
    new FakeQueryDriver().factory,
  );
  const request = executionRequest({
    runtime: { type: "claude", model: null, authentication: null },
  });

  await expect(adapter.startThread(request)).rejects.toMatchObject({
    code: "RUNTIME_AUTHENTICATION_REQUIRED",
    httpStatus: 401,
  });
});

it("does not claim an MCP visibility allowlist it cannot enforce", () => {
  expect(CLAUDE_RUNTIME_DEFINITION.capabilities.mcpToolAllowlist).toBe(false);
});

it("maps producer-shaped API auth errors without assistant output", async () => {
  const provider = new FakeQueryDriver();
  const adapter = new ClaudeAdapter(
    "/tmp/safe-runner-cwd",
    new FakeCredentialBoundary(),
    provider.factory,
  );
  const request = executionRequest({
    runtime: {
      type: "claude",
      model: "claude-test",
      authentication: {
        mode: "api_key",
        credential: "anthropic-test-credential",
      },
    },
  });
  const runtimeThreadId = await adapter.startThread(request);
  const events: string[] = [];
  const completion = adapter.runTurn({
    request,
    runtimeThreadId,
    emit: (type) => events.push(type),
  });
  await provider.waitForTurnStart();

  provider.completeWithApiError(401, "Invalid API key: secret provider detail");

  await expect(completion).rejects.toMatchObject({
    code: "RUNTIME_AUTHENTICATION_REQUIRED",
    httpStatus: 401,
  });
  expect(events).not.toContain("assistant.completed");
});

it("includes explicit Email send context in Claude approvals", async () => {
  const provider = new FakeQueryDriver();
  const adapter = new ClaudeAdapter(
    "/tmp/safe-runner-cwd",
    new FakeCredentialBoundary(),
    provider.factory,
  );
  const request = executionRequest({
    runtime: {
      type: "claude",
      model: "claude-test",
      authentication: {
        mode: "api_key",
        credential: "anthropic-test-credential",
      },
    },
    mcpServers: [
      {
        name: "email",
        url: "http://email.invalid/mcp",
        headers: {},
        approval: { defaultMode: "prompt", tools: {} },
      },
    ],
  });
  const runtimeThreadId = await adapter.startThread(request);
  const events: Array<{
    type: string;
    data: Record<string, unknown> | undefined;
  }> = [];
  const completion = adapter.runTurn({
    request,
    runtimeThreadId,
    emit: (type, data) => events.push({ type, data }),
  });
  await provider.waitForTurnStart();
  const decision = provider.options!.canUseTool!(
    "mcp__email__email_send",
    {
      expectedFrom: "clara@clasific.ar",
      to: ["buyer@example.com"],
      subject: "Follow-up",
      text: "Hello",
    },
    {
      signal: new AbortController().signal,
      toolUseID: "email-tool",
      requestId: "email-approval-request",
    },
  );
  const approval = events.find(({ type }) => type === "approval.required");
  expect(approval).toMatchObject({
    data: {
      server: "email",
      tool: "email_send",
      toolArguments: {
        expectedFrom: "clara@clasific.ar",
        to: ["buyer@example.com"],
        subject: "Follow-up",
        text: "Hello",
      },
    },
  });
  await adapter.respondToApproval(
    request.runId,
    String(approval?.data?.approvalId),
    "deny",
  );
  await expect(decision).resolves.toMatchObject({ behavior: "deny" });
  provider.completeTurn("completed");
  await completion;
});

it("rejects policy-denied Claude MCP tools without operator approval", async () => {
  const provider = new FakeQueryDriver();
  const adapter = new ClaudeAdapter(
    "/tmp/safe-runner-cwd",
    new FakeCredentialBoundary(),
    provider.factory,
  );
  const request = executionRequest({
    runtime: {
      type: "claude",
      model: "claude-test",
      authentication: {
        mode: "api_key",
        credential: "anthropic-test-credential",
      },
    },
    mcpServers: [
      {
        name: "work",
        url: "http://work.invalid/mcp",
        headers: {},
        approval: {
          defaultMode: "deny",
          tools: { assign_issue: "approve", set_issue_status: "prompt" },
        },
      },
    ],
  });
  const runtimeThreadId = await adapter.startThread(request);
  const events: Array<{
    type: string;
    data: Record<string, unknown> | undefined;
  }> = [];
  const completion = adapter.runTurn({
    request,
    runtimeThreadId,
    emit: (type, data) => events.push({ type, data }),
  });
  await provider.waitForTurnStart();

  expect(provider.options?.allowedTools).toContain("mcp__work__assign_issue");
  expect(provider.options?.allowedTools).not.toContain(
    "mcp__work__delete_issue",
  );
  await expect(
    provider.options!.canUseTool!(
      "mcp__work__delete_issue",
      { key: "COO-1", expected_version: 1 },
      {
        signal: new AbortController().signal,
        toolUseID: "denied-delete",
        requestId: "denied-delete-request",
      },
    ),
  ).resolves.toMatchObject({
    behavior: "deny",
    message: "Tool is not available for this agent.",
  });
  expect(events.some(({ type }) => type === "approval.required")).toBe(false);

  provider.completeTurn("completed");
  await completion;
});

it("settles SDK-aborted approvals exactly once", async () => {
  const provider = new FakeQueryDriver();
  const adapter = new ClaudeAdapter(
    "/tmp/safe-runner-cwd",
    new FakeCredentialBoundary(),
    provider.factory,
  );
  const request = executionRequest({
    runtime: {
      type: "claude",
      model: "claude-test",
      authentication: {
        mode: "api_key",
        credential: "anthropic-test-credential",
      },
    },
  });
  const runtimeThreadId = await adapter.startThread(request);
  const events: Array<{
    type: string;
    data: Record<string, unknown> | undefined;
  }> = [];
  const completion = adapter.runTurn({
    request,
    runtimeThreadId,
    emit: (type, data) => events.push({ type, data }),
  });
  await provider.waitForTurnStart();
  const callback = provider.options?.canUseTool;
  expect(callback).toBeTypeOf("function");

  const preAborted = new AbortController();
  preAborted.abort();
  await expect(
    callback!(
      "Bash",
      {},
      {
        signal: preAborted.signal,
        toolUseID: "pre-aborted",
        requestId: "pre-aborted-request",
      },
    ),
  ).resolves.toMatchObject({ behavior: "deny" });
  expect(
    events.filter(({ type }) => type === "approval.required"),
  ).toHaveLength(0);

  const controller = new AbortController();
  const decision = callback!(
    "Bash",
    {},
    {
      signal: controller.signal,
      toolUseID: "aborted-after-required",
      requestId: "aborted-request",
    },
  );
  expect(
    events.filter(({ type }) => type === "approval.required"),
  ).toHaveLength(1);
  controller.abort();
  await expect(decision).resolves.toMatchObject({ behavior: "deny" });
  expect(
    events.filter(({ type }) => type === "approval.resolved"),
  ).toHaveLength(1);

  provider.completeTurn("completed");
  await expect(completion).resolves.toBeUndefined();
  expect(
    events.filter(({ type }) => type === "approval.resolved"),
  ).toHaveLength(1);
});

it("marks Claude usage as a run aggregate with provider turn count", async () => {
  const provider = new FakeQueryDriver();
  provider.usageEnabled = true;
  const adapter = new ClaudeAdapter(
    "/tmp/safe-runner-cwd",
    new FakeCredentialBoundary(),
    provider.factory,
  );
  const request = executionRequest({
    runtime: {
      type: "claude",
      model: "claude-test",
      authentication: {
        mode: "api_key",
        credential: "anthropic-test-credential",
      },
    },
  });
  const runtimeThreadId = await adapter.startThread(request);
  const usage: Record<string, unknown>[] = [];
  const completion = adapter.runTurn({
    request,
    runtimeThreadId,
    emit: (type, data) => {
      if (type === "usage.updated") usage.push(data ?? {});
    },
  });
  await provider.waitForTurnStart();
  provider.completeTurn("completed");
  await completion;

  expect(usage).toEqual([
    expect.objectContaining({
      usageScope: "run_aggregate",
      providerTurnCount: 1,
      inputTokens: 150,
      cachedInputTokens: 40,
      cacheCreationInputTokens: 10,
      uncachedInputTokens: 110,
      outputTokens: 20,
      totalTokens: 170,
      costSource: "sdk_estimated",
    }),
  ]);
});
