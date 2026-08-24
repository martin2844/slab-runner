import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIRECT_API_RUNTIME_DEFINITION,
  DirectApiAdapter,
} from "../src/adapters/direct-api-adapter.js";
import {
  McpToolClient,
  type DiscoveredMcpTool,
} from "../src/adapters/mcp-tool-client.js";
import type { McpServerDefinition } from "../src/runtime/protocol.js";
import { executionRequest } from "./helpers/fixtures.js";

type CapturedRequest = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function responseObject(output: unknown[], text: string, tokens = 15) {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1,
    completed_at: 2,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "gpt-test",
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
    usage: {
      input_tokens: tokens - 5,
      input_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: tokens,
    },
    user: null,
    metadata: {},
  };
}

function sse(response: unknown, deltas: string[] = []) {
  return [
    ...deltas.map((delta, sequence_number) =>
      JSON.stringify({
        type: "response.output_text.delta",
        sequence_number,
        item_id: "message_test",
        output_index: 0,
        content_index: 0,
        delta,
        logprobs: [],
      }),
    ),
    JSON.stringify({
      type: "response.completed",
      sequence_number: deltas.length,
      response,
    }),
    "[DONE]",
  ]
    .map((line) => `data: ${line}\n\n`)
    .join("");
}

function chatSse() {
  const chunks = [
    {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 1,
      model: "kimi-test",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "hi" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 1,
      model: "kimi-test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 2,
        total_tokens: 9,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    },
    "[DONE]",
  ];
  return chunks
    .map(
      (chunk) =>
        `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`,
    )
    .join("");
}

function chatToolSse(name: string, callId = "chat_call_1") {
  const chunks = [
    {
      id: "chatcmpl_tool",
      object: "chat.completion.chunk",
      created: 1,
      model: "kimi-test",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name, arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl_tool",
      object: "chat.completion.chunk",
      created: 1,
      model: "kimi-test",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 2,
        total_tokens: 9,
      },
    },
    "[DONE]",
  ];
  return chunks
    .map(
      (chunk) =>
        `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`,
    )
    .join("");
}

async function provider(
  responder: (
    request: CapturedRequest,
    call: number,
  ) => { status?: number; body: string },
) {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as unknown;
      const captured = { headers: request.headers, body };
      requests.push(captured);
      const result = responder(captured, requests.length);
      response.writeHead(result.status ?? 200, {
        "content-type": "text/event-stream",
      });
      response.end(result.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

class FakeMcp extends McpToolClient {
  calls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  constructor(
    private readonly server: McpServerDefinition,
    private readonly fail = false,
  ) {
    super();
  }
  override connect(): Promise<void> {
    return Promise.resolve();
  }
  override definitions(): DiscoveredMcpTool[] {
    return [
      {
        providerName: "mcp__work__get_issue",
        server: this.server,
        tool: "get_issue",
        description: "Get a Work issue",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        },
      },
    ];
  }
  override get(name: string): DiscoveredMcpTool | null {
    return (
      this.definitions().find(({ providerName }) => providerName === name) ??
      null
    );
  }
  override call(
    definition: DiscoveredMcpTool,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push({ tool: definition.tool, arguments: argumentsValue });
    return this.fail
      ? Promise.reject(new Error("provider tool failed"))
      : Promise.resolve({ content: [{ type: "text", text: "COO-1" }] });
  }
  override close(): Promise<void> {
    return Promise.resolve();
  }
}

function directRequest(baseUrl: string, overrides = {}) {
  return executionRequest({
    runtime: {
      type: "direct_api",
      model: "gpt-test",
      authentication: {
        mode: "api_key",
        credential: "direct-api-secret-for-tests",
        baseUrl,
        apiFormat: "responses",
      },
    },
    mcpServers: [],
    ...overrides,
  });
}

describe("Direct API adapter", () => {
  it("declares the capabilities it actually enforces", () => {
    expect(DIRECT_API_RUNTIME_DEFINITION).toMatchObject({
      id: "direct_api",
      capabilities: {
        mcpServers: true,
        mcpToolAllowlist: false,
        toolApprovals: true,
        budgetIncrementalUsage: true,
        budgetNativeTokenLimit: false,
        budgetNativeCostLimit: false,
      },
    });
  });

  it("streams a Responses API answer and normalized per-call usage", async () => {
    const remote = await provider(() => ({
      body: sse(
        responseObject(
          [
            {
              id: "message_test",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "hello",
                  annotations: [],
                  logprobs: [],
                },
              ],
            },
          ],
          "hello",
        ),
        ["hel", "lo"],
      ),
    }));
    const request = directRequest(remote.baseUrl);
    const adapter = new DirectApiAdapter();
    const events: Array<{
      type: string;
      data: Record<string, unknown> | undefined;
    }> = [];

    await adapter.runTurn({
      request,
      runtimeThreadId: await adapter.startThread(request),
      emit: (type, data) => events.push({ type, data }),
    });

    expect(
      events.filter(({ type }) => type === "assistant.delta"),
    ).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "assistant.completed",
        data: { message: "hello" },
      }),
    );
    const usage = events.find(({ type }) => type === "usage.updated")?.data;
    expect(usage?.usageScope).toBe("model_call");
    expect(usage?.totalTokens).toBe(15);
    expect(remote.requests[0]?.headers.authorization).toBe(
      "Bearer direct-api-secret-for-tests",
    );
    expect(JSON.stringify(events)).not.toContain("direct-api-secret-for-tests");
    const firstRequestBody = remote.requests[0]?.body as Record<
      string,
      unknown
    >;
    expect(firstRequestBody.store).toBe(false);
    expect(firstRequestBody.model).toBe("gpt-test");
  });

  it("executes configured MCP tools with one terminal lifecycle", async () => {
    const first = responseObject(
      [
        {
          id: "call_item",
          type: "function_call",
          call_id: "call_1",
          name: "mcp__work__get_issue",
          arguments: '{"key":"COO-1"}',
          status: "completed",
        },
      ],
      "",
    );
    const second = responseObject(
      [
        {
          id: "message_done",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "done",
              annotations: [],
              logprobs: [],
            },
          ],
        },
      ],
      "done",
    );
    const remote = await provider((_request, call) => ({
      body: sse(call === 1 ? first : second),
    }));
    const work: McpServerDefinition = {
      name: "work",
      url: "http://work.invalid/mcp",
      headers: { Authorization: "Bearer work-secret" },
      approval: { defaultMode: "approve", tools: {} },
    };
    const mcp = new FakeMcp(work);
    const request = directRequest(remote.baseUrl, { mcpServers: [work] });
    const adapter = new DirectApiAdapter(undefined, () => mcp);
    const events: Array<{
      type: string;
      data: Record<string, unknown> | undefined;
    }> = [];

    await adapter.runTurn({
      request,
      runtimeThreadId: await adapter.startThread(request),
      emit: (type, data) => events.push({ type, data }),
    });

    expect(mcp.calls).toEqual([
      { tool: "get_issue", arguments: { key: "COO-1" } },
    ]);
    expect(events.filter(({ type }) => type === "tool.started")).toHaveLength(
      1,
    );
    expect(events.filter(({ type }) => type === "tool.completed")).toHaveLength(
      1,
    );
    expect(events.filter(({ type }) => type === "tool.failed")).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain("work-secret");
    const secondRequestBody = remote.requests[1]?.body as {
      input?: Array<Record<string, unknown>>;
    };
    expect(secondRequestBody.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_1",
        }),
      ]),
    );
  });

  it("does not invoke MCP when the provider emits invalid tool arguments", async () => {
    const first = responseObject(
      [
        {
          id: "call_item",
          type: "function_call",
          call_id: "call_invalid",
          name: "mcp__work__get_issue",
          arguments: "not-json",
          status: "completed",
        },
      ],
      "",
    );
    const second = responseObject(
      [
        {
          id: "message_done",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "reconsidered",
              annotations: [],
              logprobs: [],
            },
          ],
        },
      ],
      "reconsidered",
    );
    const remote = await provider((_request, call) => ({
      body: sse(call === 1 ? first : second),
    }));
    const work: McpServerDefinition = {
      name: "work",
      url: "http://work.invalid/mcp",
      headers: {},
      approval: { defaultMode: "approve", tools: {} },
    };
    const mcp = new FakeMcp(work);
    const request = directRequest(remote.baseUrl, { mcpServers: [work] });
    const adapter = new DirectApiAdapter(undefined, () => mcp);
    const events: Array<{
      type: string;
      data: Record<string, unknown> | undefined;
    }> = [];

    await adapter.runTurn({
      request,
      runtimeThreadId: await adapter.startThread(request),
      emit: (type, data) => events.push({ type, data }),
    });

    expect(mcp.calls).toHaveLength(0);
    expect(events.filter(({ type }) => type === "tool.started")).toHaveLength(
      1,
    );
    const failures = events.filter(({ type }) => type === "tool.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.data?.reason).toBe("invalid_arguments");
    expect(failures[0]?.data?.success).toBe(false);
    expect(JSON.stringify(remote.requests[1]?.body)).toContain(
      "INVALID_TOOL_ARGUMENTS",
    );
  });

  it("audits an unknown Responses tool as one terminal failure", async () => {
    const first = responseObject(
      [
        {
          id: "unknown_item",
          type: "function_call",
          call_id: "unknown_call",
          name: "mcp__unknown__missing",
          arguments: "{}",
          status: "completed",
        },
      ],
      "",
    );
    const second = responseObject([], "recovered");
    const remote = await provider((_request, call) => ({
      body: sse(call === 1 ? first : second),
    }));
    const request = directRequest(remote.baseUrl);
    const adapter = new DirectApiAdapter();
    const events: Array<{
      type: string;
      data: Record<string, unknown> | undefined;
    }> = [];

    await adapter.runTurn({
      request,
      runtimeThreadId: await adapter.startThread(request),
      emit: (type, data) => events.push({ type, data }),
    });

    expect(events.filter(({ type }) => type === "tool.started")).toHaveLength(
      1,
    );
    const failed = events.filter(({ type }) => type === "tool.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data?.reason).toBe("tool_not_found");
    expect(JSON.stringify(remote.requests[1]?.body)).toContain(
      "TOOL_NOT_FOUND",
    );
  });

  it("audits an unknown Chat Completions tool as one terminal failure", async () => {
    const remote = await provider((_request, call) => ({
      body: call === 1 ? chatToolSse("mcp__unknown__missing") : chatSse(),
    }));
    const request = directRequest(remote.baseUrl, {
      runtime: {
        type: "direct_api",
        model: "kimi-test",
        authentication: {
          mode: "api_key",
          credential: "kimi-compatible-key-for-tests",
          baseUrl: remote.baseUrl,
          apiFormat: "chat_completions",
        },
      },
    });
    const adapter = new DirectApiAdapter();
    const events: Array<{
      type: string;
      data: Record<string, unknown> | undefined;
    }> = [];

    await adapter.runTurn({
      request,
      runtimeThreadId: await adapter.startThread(request),
      emit: (type, data) => events.push({ type, data }),
    });

    expect(events.filter(({ type }) => type === "tool.started")).toHaveLength(
      1,
    );
    const failed = events.filter(({ type }) => type === "tool.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data?.reason).toBe("tool_not_found");
    expect(JSON.stringify(remote.requests[1]?.body)).toContain(
      "TOOL_NOT_FOUND",
    );
  });

  it("supports OpenAI-compatible Chat Completions providers", async () => {
    const remote = await provider(() => ({ body: chatSse() }));
    const request = directRequest(remote.baseUrl, {
      budget: { maxTokens: 100, maxCostUsd: null, pricing: null },
      runtime: {
        type: "direct_api",
        model: "kimi-test",
        authentication: {
          mode: "api_key",
          credential: "kimi-compatible-key-for-tests",
          baseUrl: remote.baseUrl,
          apiFormat: "chat_completions",
        },
      },
    });
    const adapter = new DirectApiAdapter();
    const events: Array<{
      type: string;
      data: Record<string, unknown> | undefined;
    }> = [];

    await adapter.runTurn({
      request,
      runtimeThreadId: await adapter.startThread(request),
      emit: (type, data) => events.push({ type, data }),
    });

    expect(events).toContainEqual({
      type: "assistant.delta",
      data: { delta: "hi" },
    });
    expect(events).toContainEqual({
      type: "assistant.completed",
      data: { message: "hi" },
    });
    const usage = events.find(({ type }) => type === "usage.updated")?.data;
    expect(usage?.totalTokens).toBe(9);
    expect(usage?.model).toBe("kimi-test");
    const requestBody = remote.requests[0]?.body as Record<string, unknown>;
    expect(requestBody.model).toBe("kimi-test");
    expect(requestBody.stream).toBe(true);
    expect(requestBody.stream_options).toEqual({ include_usage: true });
    expect(requestBody.max_tokens).toBe(100);
  });

  it("rejects a Chat Completions stream without a terminal choice", async () => {
    const body = [
      {
        id: "chatcmpl_partial",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-test",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "partial" },
            finish_reason: null,
          },
        ],
      },
      "[DONE]",
    ]
      .map(
        (chunk) =>
          `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`,
      )
      .join("");
    const remote = await provider(() => ({ body }));
    const request = directRequest(remote.baseUrl, {
      runtime: {
        type: "direct_api",
        model: "kimi-test",
        authentication: {
          mode: "api_key",
          credential: "kimi-compatible-key-for-tests",
          baseUrl: remote.baseUrl,
          apiFormat: "chat_completions",
        },
      },
    });
    const adapter = new DirectApiAdapter();
    const events: Array<{
      type: string;
      data: Record<string, unknown> | undefined;
    }> = [];

    await expect(
      adapter.runTurn({
        request,
        runtimeThreadId: await adapter.startThread(request),
        emit: (type, data) => events.push({ type, data }),
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_CRASHED" });
    expect(events.some(({ type }) => type === "assistant.completed")).toBe(
      false,
    );
  });

  it("returns a structured budget failure at the first observable overage", async () => {
    const remote = await provider(() => ({
      body: sse(responseObject([], "", 15)),
    }));
    const request = directRequest(remote.baseUrl, {
      budget: { maxTokens: 10, maxCostUsd: null, pricing: null },
    });
    const adapter = new DirectApiAdapter();

    await expect(
      adapter.runTurn({
        request,
        runtimeThreadId: await adapter.startThread(request),
        emit: () => {},
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_BUDGET_EXCEEDED" });
    expect(remote.requests).toHaveLength(1);
  });

  it("maps provider authentication failures without leaking the response", async () => {
    const remote = await provider(() => ({
      status: 401,
      body: JSON.stringify({ error: { message: "secret rejected" } }),
    }));
    const request = directRequest(remote.baseUrl);
    const adapter = new DirectApiAdapter();

    await expect(
      adapter.runTurn({
        request,
        runtimeThreadId: await adapter.startThread(request),
        emit: () => {},
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_AUTHENTICATION_REQUIRED",
      httpStatus: 401,
    });
  });
});
