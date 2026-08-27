import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
  OPENROUTER_RUNTIME_DEFINITION,
  OpenRouterAdapter,
} from "../src/adapters/openrouter-adapter.js";
import type {
  DirectApiClientFactory,
  DirectAuthentication,
} from "../src/adapters/direct-api-adapter.js";
import { DirectApiAdapter } from "../src/adapters/direct-api-adapter.js";
import {
  McpToolClient,
  type DiscoveredMcpTool,
} from "../src/adapters/mcp-tool-client.js";
import { RunnerError } from "../src/runtime/errors.js";
import { executionRequest } from "./helpers/fixtures.js";

function openRouterRequest(
  authentication: DirectAuthentication | null = {
    mode: "api_key",
    credential: "openrouter-api-key-for-tests",
    baseUrl: "https://attacker.invalid/v1",
    apiFormat: "responses",
  },
) {
  return executionRequest({
    runtime: {
      type: "openrouter",
      model: "anthropic/claude-test",
      authentication,
    },
    budget: { maxTokens: null, maxCostUsd: 0.01, pricing: null },
    mcpServers: [],
  });
}

function clientHarness(cost = 0.002, promptTokens = 100) {
  let authentication: DirectAuthentication | null = null;
  let body: Record<string, unknown> | null = null;
  const clientFactory: DirectApiClientFactory = (nextAuthentication) => {
    authentication = nextAuthentication;
    return {
      chat: {
        completions: {
          create: (nextBody: Record<string, unknown>) => {
            body = nextBody;
            return Promise.resolve({
              async *[Symbol.asyncIterator]() {
                yield await Promise.resolve({
                  id: "chatcmpl-openrouter",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "anthropic/claude-test",
                  choices: [
                    {
                      index: 0,
                      delta: { content: "done" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: 20,
                    total_tokens: 120,
                    prompt_tokens_details: { cached_tokens: 40 },
                    completion_tokens_details: { reasoning_tokens: 2 },
                    cost,
                  },
                });
              },
            });
          },
        },
      },
    } as unknown as OpenAI;
  };
  return {
    clientFactory,
    authentication: () => authentication,
    body: () => body,
  };
}

class OneToolMcp extends McpToolClient {
  readonly definition: DiscoveredMcpTool = {
    providerName: "mcp__work__lookup",
    server: {
      name: "work",
      url: "https://work.invalid/mcp",
      headers: {},
      approval: { defaultMode: "approve", tools: {} },
    },
    tool: "lookup",
    description: "Look up work",
    inputSchema: { type: "object", properties: {} },
  };

  override connect(): Promise<void> {
    return Promise.resolve();
  }

  override definitions(): DiscoveredMcpTool[] {
    return [this.definition];
  }

  override get(name: string): DiscoveredMcpTool | null {
    return name === this.definition.providerName ? this.definition : null;
  }

  override call(): Promise<unknown> {
    return Promise.resolve({ result: "ok" });
  }

  override close(): Promise<void> {
    return Promise.resolve();
  }
}

function missingSecondCallCostHarness() {
  let call = 0;
  const clientFactory: DirectApiClientFactory = () =>
    ({
      chat: {
        completions: {
          create: () => {
            call += 1;
            const currentCall = call;
            return Promise.resolve({
              async *[Symbol.asyncIterator]() {
                yield await Promise.resolve(
                  currentCall === 1
                    ? {
                        model: "anthropic/claude-test",
                        choices: [
                          {
                            index: 0,
                            finish_reason: "tool_calls",
                            delta: {
                              tool_calls: [
                                {
                                  index: 0,
                                  id: "call-1",
                                  function: {
                                    name: "mcp__work__lookup",
                                    arguments: "{}",
                                  },
                                },
                              ],
                            },
                          },
                        ],
                        usage: {
                          prompt_tokens: 10,
                          completion_tokens: 5,
                          total_tokens: 15,
                          cost: 0.001,
                        },
                      }
                    : {
                        model: "anthropic/claude-test",
                        choices: [
                          {
                            index: 0,
                            finish_reason: "stop",
                            delta: { content: "done" },
                          },
                        ],
                        usage: {
                          prompt_tokens: 20,
                          completion_tokens: 5,
                          total_tokens: 25,
                          cost: null,
                        },
                      },
                );
              },
            });
          },
        },
      },
    }) as unknown as OpenAI;
  return { clientFactory, calls: () => call };
}

describe("OpenRouterAdapter", () => {
  it("uses the fixed endpoint, safe routing defaults, and exact provider cost", async () => {
    const harness = clientHarness();
    const adapter = new OpenRouterAdapter(harness.clientFactory);
    const request = openRouterRequest();
    const events: Array<{
      type: string;
      data: Record<string, unknown> | undefined;
    }> = [];

    await adapter.runTurn({
      request,
      runtimeThreadId: await adapter.startThread(request),
      emit: (type, data) => events.push({ type, data }),
    });

    expect(adapter.definition).toEqual(OPENROUTER_RUNTIME_DEFINITION);
    expect(harness.authentication()).toMatchObject({
      credential: "openrouter-api-key-for-tests",
      baseUrl: "https://openrouter.ai/api/v1",
      apiFormat: "chat_completions",
    });
    expect(harness.body()).toMatchObject({
      model: "anthropic/claude-test",
      stream: true,
      provider: {
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
      },
    });
    expect(harness.body()).not.toHaveProperty("stream_options");
    expect(harness.body()).not.toHaveProperty("tools");
    expect(harness.body()).not.toHaveProperty("tool_choice");
    expect(events).toContainEqual({
      type: "assistant.completed",
      data: { message: "done" },
    });
    expect(
      events.find(({ type }) => type === "usage.updated")?.data,
    ).toMatchObject({
      totalTokens: 120,
      costUsd: 0.002,
    });
    expect(
      events.find(({ type }) => type === "usage.updated")?.data,
    ).not.toHaveProperty("totalCostUsd");
  });

  it("forwards explicit privacy routing while keeping endpoint selection owned by Runner", async () => {
    const harness = clientHarness();
    const adapter = new OpenRouterAdapter(harness.clientFactory);
    const request = openRouterRequest({
      mode: "api_key",
      credential: "openrouter-api-key-for-tests",
      baseUrl: "https://attacker.invalid/v1",
      apiFormat: "responses",
      providerRouting: {
        requireParameters: false,
        dataCollection: "allow",
        zdr: false,
      },
    });

    await adapter.runTurn({
      request,
      runtimeThreadId: await adapter.startThread(request),
      emit: () => undefined,
    });

    expect(harness.authentication()).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      apiFormat: "chat_completions",
    });
    expect(harness.body()?.provider).toEqual({
      require_parameters: false,
      data_collection: "allow",
      zdr: false,
    });
  });

  it("requires an API key and stops after observed provider cost reaches the limit", async () => {
    const adapter = new OpenRouterAdapter(clientHarness().clientFactory);
    expect(() => adapter.startThread(openRouterRequest(null))).toThrowError(
      RunnerError,
    );

    const expensive = clientHarness(0.02);
    const expensiveAdapter = new OpenRouterAdapter(expensive.clientFactory);
    const request = openRouterRequest();
    await expect(
      expensiveAdapter.runTurn({
        request,
        runtimeThreadId: await expensiveAdapter.startThread(request),
        emit: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_BUDGET_EXCEEDED" });
  });

  it("fails closed when a later tool-loop call omits exact cost", async () => {
    const harness = missingSecondCallCostHarness();
    const adapter = new OpenRouterAdapter(
      harness.clientFactory,
      () => new OneToolMcp(),
    );
    const request = openRouterRequest();
    await expect(
      adapter.runTurn({
        request,
        runtimeThreadId: await adapter.startThread(request),
        emit: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_CRASHED",
      message: "OpenRouter returned invalid model-call usage",
    });
    expect(harness.calls()).toBe(2);
  });

  it("rejects malformed provider token accounting", async () => {
    const harness = clientHarness(0.002, 1.5);
    const adapter = new OpenRouterAdapter(harness.clientFactory);
    const request = openRouterRequest();
    await expect(
      adapter.runTurn({
        request,
        runtimeThreadId: await adapter.startThread(request),
        emit: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_CRASHED",
      message: "OpenRouter returned invalid model-call usage",
    });
  });

  it("rejects an unsupported Direct API cost limit before a provider call", () => {
    const request = executionRequest({
      runtime: {
        type: "direct_api",
        model: "direct-test",
        authentication: {
          mode: "api_key",
          credential: "direct-api-key-for-tests",
          baseUrl: "https://direct.invalid/v1",
          apiFormat: "chat_completions",
        },
      },
      budget: { maxTokens: null, maxCostUsd: 1, pricing: null },
      mcpServers: [],
    });
    expect(() => new DirectApiAdapter().startThread(request)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_BUDGET_UNSUPPORTED" }),
    );
  });

  it("ignores untrusted Direct API cost and enforces configured pricing", async () => {
    const harness = clientHarness(0);
    const adapter = new DirectApiAdapter(harness.clientFactory);
    const request = executionRequest({
      runtime: {
        type: "direct_api",
        model: "direct-test",
        authentication: {
          mode: "api_key",
          credential: "direct-api-key-for-tests",
          baseUrl: "https://direct.invalid/v1",
          apiFormat: "chat_completions",
        },
      },
      budget: {
        maxTokens: null,
        maxCostUsd: 0.000_01,
        pricing: {
          version: 1,
          inputUsdPerMillion: 1,
          cachedInputUsdPerMillion: 1,
          outputUsdPerMillion: 1,
        },
      },
      mcpServers: [],
    });
    await expect(
      adapter.runTurn({
        request,
        runtimeThreadId: await adapter.startThread(request),
        emit: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_BUDGET_EXCEEDED" });
  });
});
