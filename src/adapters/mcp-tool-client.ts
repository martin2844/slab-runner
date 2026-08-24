import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerDefinition } from "../runtime/protocol.js";

export type DiscoveredMcpTool = {
  providerName: string;
  server: McpServerDefinition;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ConnectedServer = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

type ClientFactory = () => Client;
type TransportFactory = (
  server: McpServerDefinition,
  signal: AbortSignal,
) => StreamableHTTPClientTransport;

const MAX_TOOL_PAGES = 20;
const MAX_TOOLS = 1_000;

function providerToolName(server: string, tool: string): string {
  const candidate = `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (candidate.length <= 64) return candidate;
  const digest = createHash("sha256")
    .update(candidate)
    .digest("hex")
    .slice(0, 10);
  return `${candidate.slice(0, 53)}_${digest}`;
}

function bounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const succeed = (value: T) => {
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(
        error instanceof Error ? error : new Error("MCP connection failed."),
      );
    };
    const timeout = setTimeout(
      () => fail(new Error("MCP server connection timed out.")),
      timeoutMs,
    );
    timeout.unref();
    const onAbort = () => fail(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(succeed, fail);
  });
}

export class McpToolClient {
  readonly #connections = new Map<string, ConnectedServer>();
  readonly #tools = new Map<string, DiscoveredMcpTool>();

  constructor(
    private readonly clientFactory: ClientFactory = () =>
      new Client(
        { name: "slab-runner", version: "0.1.0" },
        { capabilities: {} },
      ),
    private readonly transportFactory: TransportFactory = (server, signal) =>
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers, signal },
      }),
  ) {}

  async connect(
    servers: McpServerDefinition[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const server of servers) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const client = this.clientFactory();
      const transport = this.transportFactory(server, signal);
      try {
        // SDK 1.30's StreamableHTTP declaration is not exact-optional clean,
        // although it implements the Transport contract at runtime.
        await bounded(client.connect(transport as Transport), signal, 10_000);
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        let complete = false;
        for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
          const discovered = await client.listTools(
            cursor ? { cursor } : undefined,
            { signal, timeout: 10_000 },
          );
          for (const tool of discovered.tools) {
            if (this.#tools.size >= MAX_TOOLS) {
              throw new Error("MCP server exposed too many tools.");
            }
            const providerName = providerToolName(server.name, tool.name);
            if (this.#tools.has(providerName)) {
              throw new Error(`MCP tool name collision: ${providerName}`);
            }
            this.#tools.set(providerName, {
              providerName,
              server,
              tool: tool.name,
              description: tool.description ?? `${server.name}.${tool.name}`,
              inputSchema: tool.inputSchema as Record<string, unknown>,
            });
          }
          cursor = discovered.nextCursor;
          if (!cursor) {
            complete = true;
            break;
          }
          if (seenCursors.has(cursor)) {
            throw new Error("MCP tools pagination repeated a cursor.");
          }
          seenCursors.add(cursor);
        }
        if (!complete)
          throw new Error("MCP tools pagination exceeded its limit.");
        this.#connections.set(server.name, { client, transport });
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw error;
      }
    }
  }

  definitions(): DiscoveredMcpTool[] {
    return [...this.#tools.values()];
  }

  get(providerName: string): DiscoveredMcpTool | null {
    return this.#tools.get(providerName) ?? null;
  }

  async call(
    definition: DiscoveredMcpTool,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const target = this.#connections.get(definition.server.name);
    if (!target) throw new Error("MCP server connection is unavailable.");
    const result = await target.client.callTool(
      { name: definition.tool, arguments: argumentsValue },
      undefined,
      { signal, timeout: 60_000 },
    );
    if (result.isError === true) {
      throw new Error("MCP server reported a tool failure.");
    }
    return result;
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.#connections.values()].map(async ({ client, transport }) => {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }),
    );
    this.#connections.clear();
    this.#tools.clear();
  }
}
