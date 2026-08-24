import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { McpToolClient } from "../src/adapters/mcp-tool-client.js";

describe("MCP tool client", () => {
  it("discovers every bounded tools/list page", async () => {
    const cursors: Array<string | undefined> = [];
    const client = {
      connect: () => Promise.resolve(),
      listTools: (params?: { cursor?: string }) => {
        cursors.push(params?.cursor);
        return Promise.resolve(
          params?.cursor === "page-2"
            ? {
                tools: [
                  {
                    name: "get_issue",
                    description: "Get an issue",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : {
                tools: [
                  {
                    name: "list_issues",
                    description: "List issues",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
                nextCursor: "page-2",
              },
        );
      },
      close: () => Promise.resolve(),
    } as unknown as Client;
    const transport = {
      close: () => Promise.resolve(),
    } as unknown as StreamableHTTPClientTransport;
    const tools = new McpToolClient(
      () => client,
      () => transport,
    );

    await tools.connect(
      [
        {
          name: "work",
          url: "https://work.invalid/mcp",
          headers: {},
        },
      ],
      new AbortController().signal,
    );

    expect(cursors).toEqual([undefined, "page-2"]);
    expect(tools.definitions().map(({ tool }) => tool)).toEqual([
      "list_issues",
      "get_issue",
    ]);
    await tools.close();
  });

  it("fails boundedly when tools/list repeats a cursor", async () => {
    const client = {
      connect: () => Promise.resolve(),
      listTools: () =>
        Promise.resolve({ tools: [], nextCursor: "same-cursor" }),
      close: () => Promise.resolve(),
    } as unknown as Client;
    const transport = {
      close: () => Promise.resolve(),
    } as unknown as StreamableHTTPClientTransport;
    const tools = new McpToolClient(
      () => client,
      () => transport,
    );

    await expect(
      tools.connect(
        [{ name: "work", url: "https://work.invalid/mcp", headers: {} }],
        new AbortController().signal,
      ),
    ).rejects.toThrow(/repeated a cursor/);
  });
});
