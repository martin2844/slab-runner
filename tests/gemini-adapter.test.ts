import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  GeminiAdapter,
  type GeminiProcess,
  type GeminiProcessFactory,
} from "../src/adapters/gemini-adapter.js";
import { executionRequest } from "./helpers/fixtures.js";

class Process extends EventEmitter implements GeminiProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  override once(
    event: "error" | "close",
    listener:
      | ((error: Error) => void)
      | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): this {
    return super.once(event, listener);
  }
  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
  event(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
  close(code = 0): void {
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, null));
  }
}

class StubbornProcess extends Process {
  readonly signals: Array<NodeJS.Signals | number> = [];

  override kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL") {
      queueMicrotask(() => this.emit("close", null, "SIGKILL"));
    }
    return true;
  }
}

function harness() {
  let active: Process | null = null;
  let settingsPath = "";
  let processArguments: readonly string[] = [];
  const factory: GeminiProcessFactory = (_bin, args, options) => {
    const process = new Process();
    if (args.includes("--version")) {
      queueMicrotask(() => process.close());
    } else {
      active = process;
      processArguments = args;
      settingsPath = options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? "";
    }
    return process;
  };
  const adapter = new GeminiAdapter(
    "/tmp",
    "/tmp/slab-gemini-tests",
    "gemini",
    factory,
    () => Promise.resolve(true),
  );
  return {
    adapter,
    process: () => active,
    settingsPath: () => settingsPath,
    processArguments: () => processArguments,
  };
}

describe("GeminiAdapter", () => {
  it("marks missing terminal tool events failed exactly once", async () => {
    const current = harness();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
      }),
      runtimeThreadId: "gemini-session",
      emit: (type, data = {}) => events.push({ type, data }),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    current.process()!.event({
      type: "tool_use",
      tool_id: "open-tool",
      tool_name: "get_issue",
      parameters: { key: "COO-1" },
    });
    current.process()!.event({ type: "result", status: "success", stats: {} });
    current.process()!.close();
    await completion;

    const terminals = events.filter(
      ({ type, data }) =>
        ["tool.completed", "tool.failed"].includes(type) &&
        data.toolId === "open-tool",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("tool.failed");
    expect(terminals[0]?.data.reason).toBe("terminal_event_missing");
  });

  it("rejects human output instead of parsing it as a protocol", async () => {
    const current = harness();
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    current.process()!.stdout.write("Gemini says hello\n");
    current.process()!.close();
    await expect(completion).rejects.toMatchObject({ code: "RUNTIME_CRASHED" });
  });

  it("classifies producer-shaped terminal authentication failures", async () => {
    const current = harness();
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    current.process()!.event({
      type: "result",
      status: "error",
      error: {
        type: "FatalAuthenticationError",
        message: "OAuth token was revoked",
      },
      stats: {},
    });
    current.process()!.close(1);
    await expect(completion).rejects.toMatchObject({
      code: "RUNTIME_AUTHENTICATION_REQUIRED",
    });
  });

  it("classifies a missing resumed Gemini session as THREAD_NOT_FOUND", async () => {
    const current = harness();
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
        thread: {
          runtimeThreadId: "missing-session",
        },
      }),
      runtimeThreadId: "missing-session",
      emit: vi.fn(),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    current.process()!.event({
      type: "result",
      status: "error",
      error: {
        type: "SessionError",
        message:
          "Error resuming session: No previous sessions found for this project.",
      },
      stats: {},
    });
    current.process()!.close(1);
    await expect(completion).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });

  it("escalates malformed protocol termination to SIGKILL", async () => {
    let active: StubbornProcess | null = null;
    const adapter = new GeminiAdapter(
      "/tmp",
      "/tmp/slab-gemini-protocol-tests",
      "gemini",
      (_bin, args) => {
        const process = new StubbornProcess();
        if (args.includes("--version")) queueMicrotask(() => process.close());
        else active = process;
        return process;
      },
      () => Promise.resolve(true),
    );
    const completion = adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    await expect.poll(() => active).not.toBeNull();
    vi.useFakeTimers();
    try {
      active!.stdout.write("not-json\n");
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(completion).rejects.toMatchObject({ code: "RUNTIME_CRASHED" });
      expect(active!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed before process creation when a hard budget is present", async () => {
    const current = harness();
    await expect(
      current.adapter.runTurn({
        request: executionRequest({
          runtime: { type: "gemini", model: null, authentication: null },
          budget: { maxTokens: 100, maxCostUsd: null, pricing: null },
        }),
        runtimeThreadId: "gemini-session",
        emit: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_BUDGET_UNSUPPORTED" });
    expect(current.process()).toBeNull();
  });

  it("sanitizes runtime warnings and removes protected run configuration", async () => {
    const current = harness();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const secret = "gemini-mcp-secret-never-persist";
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
        mcpServers: [
          {
            name: "work",
            url: "https://work.example.test/mcp",
            headers: { Authorization: `Bearer ${secret}` },
            approval: { defaultMode: "approve", tools: {} },
          },
        ],
      }),
      runtimeThreadId: "gemini-session",
      emit: (type, data = {}) => events.push({ type, data }),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    expect(current.processArguments().join(" ")).not.toContain(secret);
    current.process()!.event({
      type: "error",
      message: `temporary interruption ${secret}`,
      code: "MCP_INTERRUPTED",
      willRetry: true,
      tool_id: "tool-1",
    });
    current.process()!.event({ type: "result", status: "success", stats: {} });
    current.process()!.close();
    await completion;

    const warning = events.find(({ type }) => type === "runtime.warning");
    expect(warning?.data).toMatchObject({
      message: "temporary interruption [REDACTED]",
      code: "MCP_INTERRUPTED",
      willRetry: true,
      toolId: "tool-1",
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    await expect(access(current.settingsPath())).rejects.toThrow();
  });

  it("passes every run-scoped MCP server through the documented array flag", async () => {
    const current = harness();
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
        mcpServers: [
          {
            name: "work",
            url: "https://work.example.test/mcp",
            headers: {},
            approval: { defaultMode: "approve", tools: {} },
          },
          {
            name: "Docs server",
            url: "https://docs.example.test/mcp",
            headers: {},
            approval: { defaultMode: "approve", tools: {} },
          },
        ],
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    await expect.poll(() => current.process()).not.toBeNull();

    const args = current.processArguments();
    expect(
      args.flatMap((value, index) =>
        value === "--allowed-mcp-server-names" ? [args[index + 1]] : [],
      ),
    ).toEqual(["work", "slab-2-docs-server"]);

    current.process()!.event({ type: "result", status: "success", stats: {} });
    current.process()!.close();
    await completion;
  });

  it("exposes only known read-only defaults when approvals cannot round-trip", async () => {
    const current = harness();
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
        mcpServers: [
          {
            name: "work",
            url: "https://work.example.test/mcp",
            headers: {},
          },
          {
            name: "custom",
            url: "https://custom.example.test/mcp",
            headers: {},
          },
        ],
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    const settings = JSON.parse(
      await readFile(current.settingsPath(), "utf8"),
    ) as {
      mcpServers: Record<string, { includeTools?: string[] }>;
    };
    expect(settings.mcpServers.work?.includeTools).toContain("get_issue");
    expect(settings.mcpServers.work?.includeTools).not.toContain("update_issue");
    expect(settings.mcpServers.custom).toBeUndefined();

    current.process()!.event({ type: "result", status: "success", stats: {} });
    current.process()!.close();
    await completion;
  });

  it("filters prompt and denied tools while retaining explicit allows", async () => {
    const current = harness();
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
        mcpServers: [
          {
            name: "work",
            url: "https://work.example.test/mcp",
            headers: {},
            approval: {
              defaultMode: "deny",
              tools: {
                get_issue: "approve",
                assign_issue: "approve",
                set_issue_status: "prompt",
                delete_issue: "deny",
              },
            },
          },
        ],
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    const settings = JSON.parse(
      await readFile(current.settingsPath(), "utf8"),
    ) as {
      mcpServers: Record<string, { includeTools?: string[] }>;
    };
    expect(settings.mcpServers.work?.includeTools).toEqual([
      "get_issue",
      "assign_issue",
    ]);

    current.process()!.event({ type: "result", status: "success", stats: {} });
    current.process()!.close();
    await completion;
  });

  it("fails a successful model turn when required MCP discovery failed", async () => {
    const current = harness();
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
        agent: {
          id: "agent-1",
          name: "COO",
          role: "operator",
          instructions: "Operate safely.",
          fullAccess: true,
        },
        mcpServers: [
          {
            name: "work",
            url: "https://work.example.test/mcp",
            headers: {},
          },
        ],
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    current.process()!.stderr.write(
      "[INFO] MCP issues detected. Run /mcp list for status.\n",
    );
    current.process()!.event({ type: "result", status: "success", stats: {} });
    current.process()!.close();

    await expect(completion).rejects.toMatchObject({
      code: "MCP_CONNECTION_FAILED",
    });
  });

  it("prioritizes terminal authentication failure over an MCP startup warning", async () => {
    const current = harness();
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
        agent: {
          id: "agent-1",
          name: "COO",
          role: "operator",
          instructions: "Operate safely.",
          fullAccess: true,
        },
        mcpServers: [
          {
            name: "work",
            url: "https://work.example.test/mcp",
            headers: {},
          },
        ],
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    current.process()!.stderr.write("MCP issues detected. Run /mcp list.\n");
    current.process()!.event({
      type: "result",
      status: "error",
      error: {
        type: "FatalAuthenticationError",
        message: "OAuth credential was revoked",
      },
      stats: {},
    });
    current.process()!.close(1);

    await expect(completion).rejects.toMatchObject({
      code: "RUNTIME_AUTHENTICATION_REQUIRED",
    });
  });

  it("allocates collision-free aliases and attributes tools to the right server", async () => {
    const current = harness();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
        agent: {
          id: "agent-1",
          name: "COO",
          role: "operator",
          instructions: "Operate safely.",
          fullAccess: true,
        },
        mcpServers: [
          {
            name: "slab-2-foo",
            url: "https://first.example.test/mcp",
            headers: {},
          },
          {
            name: "foo_bar",
            url: "https://second.example.test/mcp",
            headers: {},
          },
        ],
      }),
      runtimeThreadId: "gemini-session",
      emit: (type, data = {}) => events.push({ type, data }),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    const settings = JSON.parse(
      await readFile(current.settingsPath(), "utf8"),
    ) as { mcpServers: Record<string, { httpUrl: string }> };
    const secondAlias = Object.entries(settings.mcpServers).find(
      ([, value]) => value.httpUrl === "https://second.example.test/mcp",
    )?.[0];
    expect(Object.keys(settings.mcpServers)).toHaveLength(2);
    expect(secondAlias).toBeTruthy();
    expect(secondAlias).not.toBe("slab-2-foo");

    current.process()!.event({
      type: "tool_use",
      tool_id: "second-tool",
      tool_name: `mcp_${secondAlias}_lookup`,
      parameters: {},
    });
    current.process()!.event({
      type: "tool_result",
      tool_id: "second-tool",
      status: "success",
      output: {},
    });
    current.process()!.event({ type: "result", status: "success", stats: {} });
    current.process()!.close();
    await completion;
    expect(
      events.find(
        ({ type, data }) => type === "tool.started" && data.toolId === "second-tool",
      )?.data.server,
    ).toBe("foo_bar");
  });

  it("probes beyond adversarial alias collisions without rejecting valid servers", async () => {
    const current = harness();
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
        agent: {
          id: "agent-1",
          name: "COO",
          role: "operator",
          instructions: "Operate safely.",
          fullAccess: true,
        },
        mcpServers: [
          {
            name: "slab-3-270e309a",
            url: "https://first.example.test/mcp",
            headers: {},
          },
          {
            name: "slab-3-270e309a-270e309a",
            url: "https://second.example.test/mcp",
            headers: {},
          },
          {
            name: "abcdefghijklmnopqrstuvwxyz1234",
            url: "https://third.example.test/mcp",
            headers: {},
          },
        ],
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    const settings = JSON.parse(
      await readFile(current.settingsPath(), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(settings.mcpServers)).toHaveLength(3);
    expect(new Set(Object.keys(settings.mcpServers)).size).toBe(3);
    expect(Object.keys(settings.mcpServers).every((alias) => alias.length <= 25)).toBe(
      true,
    );

    current.process()!.event({ type: "result", status: "success", stats: {} });
    current.process()!.close();
    await completion;
  });

  it("keeps long-server tool attribution through Gemini's FQN truncation", async () => {
    const current = harness();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const longServerName = "abcdefghijklmnopqrstuvwxyz1234";
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
        agent: {
          id: "agent-1",
          name: "COO",
          role: "operator",
          instructions: "Operate safely.",
          fullAccess: true,
        },
        mcpServers: [
          {
            name: longServerName,
            url: "https://long.example.test/mcp",
            headers: {},
          },
          {
            name: "work",
            url: "https://work.example.test/mcp",
            headers: {},
          },
        ],
      }),
      runtimeThreadId: "gemini-session",
      emit: (type, data = {}) => events.push({ type, data }),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    const settings = JSON.parse(
      await readFile(current.settingsPath(), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    const alias = Object.keys(settings.mcpServers)[0]!;
    expect(alias.length).toBeLessThanOrEqual(25);
    const original = `mcp_${alias}_lookup_customer_account_history_with_details`;
    const truncated = `${original.slice(0, 30)}...${original.slice(-30)}`;
    current.process()!.event({
      type: "tool_use",
      tool_id: "long-tool",
      tool_name: truncated,
      parameters: {},
    });
    current.process()!.event({
      type: "tool_result",
      tool_id: "long-tool",
      status: "success",
      output: {},
    });
    current.process()!.event({ type: "result", status: "success", stats: {} });
    current.process()!.close();
    await completion;
    expect(
      events.find(
        ({ type, data }) => type === "tool.started" && data.toolId === "long-tool",
      )?.data.server,
    ).toBe(longServerName);
  });

  it("uses an impossible run sentinel when no MCP servers are assigned", async () => {
    const current = harness();
    const completion = current.adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
        mcpServers: [],
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    await expect.poll(() => current.process()).not.toBeNull();
    const args = current.processArguments();
    const flagIndex = args.indexOf("--allowed-mcp-server-names");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toMatch(/^slab-empty-/);

    current.process()!.event({ type: "result", status: "success", stats: {} });
    current.process()!.close();
    await completion;
  });

  it("honors cancellation while authentication is still being checked", async () => {
    let resolveAuth: ((authenticated: boolean) => void) | undefined;
    const auth = new Promise<boolean>((resolve) => {
      resolveAuth = resolve;
    });
    const factory = vi.fn<GeminiProcessFactory>();
    const adapter = new GeminiAdapter(
      "/tmp",
      "/tmp/slab-gemini-cancel-tests",
      "gemini",
      factory,
      () => auth,
    );
    const completion = adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    await adapter.cancelRun("run-1");
    resolveAuth?.(true);

    await expect(completion).rejects.toMatchObject({ code: "RUN_CANCELLED" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("prevents an initializing turn from outliving adapter shutdown", async () => {
    let resolveAuth: ((authenticated: boolean) => void) | undefined;
    const auth = new Promise<boolean>((resolve) => {
      resolveAuth = resolve;
    });
    const factory = vi.fn<GeminiProcessFactory>();
    const adapter = new GeminiAdapter(
      "/tmp",
      "/tmp/slab-gemini-shutdown-init-tests",
      "gemini",
      factory,
      () => auth,
    );
    const completion = adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    const outcome = completion.catch((error: unknown) => error);
    await adapter.shutdown();
    resolveAuth?.(true);

    await expect(outcome).resolves.toMatchObject({ code: "RUN_CANCELLED" });
    expect(factory).not.toHaveBeenCalled();
    await expect(
      adapter.runTurn({
        request: executionRequest({
          runtime: { type: "gemini", model: null, authentication: null },
        }),
        runtimeThreadId: "another-session",
        emit: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("waits for active process termination and protected cleanup on shutdown", async () => {
    let active: StubbornProcess | null = null;
    let settingsPath = "";
    const adapter = new GeminiAdapter(
      "/tmp",
      "/tmp/slab-gemini-shutdown-active-tests",
      "gemini",
      (_bin, args, options) => {
        const process = new StubbornProcess();
        if (args.includes("--version")) queueMicrotask(() => process.close());
        else {
          active = process;
          settingsPath = options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? "";
        }
        return process;
      },
      () => Promise.resolve(true),
    );
    const completion = adapter.runTurn({
      request: executionRequest({
        runtime: { type: "gemini", model: null, authentication: null },
      }),
      runtimeThreadId: "gemini-session",
      emit: vi.fn(),
    });
    const outcome = completion.catch((error: unknown) => error);
    await expect.poll(() => active).not.toBeNull();
    vi.useFakeTimers();
    try {
      let shutdownSettled = false;
      const shutdown = adapter.shutdown().then(() => {
        shutdownSettled = true;
      });
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await shutdown;
      expect(active!.signals).toEqual(["SIGTERM", "SIGKILL"]);
      await expect(outcome).resolves.toMatchObject({ code: "RUN_CANCELLED" });
      await expect(access(settingsPath)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes secret-bearing temporary settings when process creation throws", async () => {
    let settingsPath = "";
    const adapter = new GeminiAdapter(
      "/tmp",
      "/tmp/slab-gemini-cleanup-tests",
      "gemini",
      (_bin, _args, options) => {
        settingsPath = options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? "";
        throw new Error("spawn failed");
      },
      () => Promise.resolve(true),
    );
    await expect(
      adapter.runTurn({
        request: executionRequest({
          runtime: { type: "gemini", model: null, authentication: null },
          mcpServers: [
            {
              name: "work",
              url: "https://work.example.test/mcp",
              headers: { Authorization: "Bearer cleanup-secret" },
            },
          ],
        }),
        runtimeThreadId: "gemini-session",
        emit: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_CRASHED" });
    expect(settingsPath).not.toBe("");
    await expect(access(dirname(settingsPath))).rejects.toThrow();
  });
});
