import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapters/codex-adapter.js";
import { createHttpApp } from "../src/http/app.js";
import { SilentLogger } from "../src/lib/logger.js";
import type {
  RuntimeAdapter,
  RuntimeHealth,
  RuntimeTurnContext,
} from "../src/runtime/adapter.js";
import { RunnerError } from "../src/runtime/errors.js";
import type { AgentExecutionRequest } from "../src/runtime/protocol.js";
import { parseExecutionRequest } from "../src/runtime/protocol.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { executionRequest } from "./helpers/fixtures.js";
import { FakeAppServerConnection } from "./helpers/fake-connection.js";
import { createGitFixture, gitSync, type GitFixture } from "./helpers/git-fixture.js";
import {
  TEST_RUNTIME_DEFINITION,
  testRuntimeHealth,
} from "./helpers/runtime.js";

/** Blocks each turn until it is released or cancelled. */
class BlockingAdapter implements RuntimeAdapter {
  readonly definition = TEST_RUNTIME_DEFINITION;
  readonly requests: AgentExecutionRequest[] = [];
  readonly #pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
  ignoreCancel = false;

  start(): Promise<void> {
    return Promise.resolve();
  }
  health(): Promise<RuntimeHealth> {
    return Promise.resolve(testRuntimeHealth());
  }
  startThread(request: AgentExecutionRequest): Promise<string> {
    this.requests.push(request);
    return Promise.resolve(`thread-${request.runId}`);
  }
  resumeThread(request: AgentExecutionRequest): Promise<string> {
    return this.startThread(request);
  }
  runTurn(context: RuntimeTurnContext): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#pending.set(context.request.runId, { resolve, reject });
    });
  }
  finish(runId: string): void {
    this.#pending.get(runId)?.resolve();
    this.#pending.delete(runId);
  }
  cancelRun(runId: string): Promise<void> {
    if (!this.ignoreCancel) {
      this.#pending
        .get(runId)
        ?.reject(new RunnerError("RUN_CANCELLED", "Run was cancelled", 409));
      this.#pending.delete(runId);
    }
    return Promise.resolve();
  }
  respondToApproval(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

interface ApiBody {
  data: Record<string, unknown>;
  error: { code: string; message: string; details?: unknown };
}

function body(response: { body: unknown }): ApiBody {
  return response.body as ApiBody;
}

const openServers = new Set<Server>();
const fixtures: GitFixture[] = [];

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  openServers.clear();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function listen(app: ReturnType<typeof createHttpApp>): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.add(server);
  return server;
}

async function codeApp(options: { maxActiveRuns?: number; timeLimitGraceMs?: number } = {}) {
  const fixture = createGitFixture();
  fixtures.push(fixture);
  const workspaces = new WorkspaceManager({
    root: fixture.codeRoot,
    allowFileRemotes: true,
    deleteGraceMs: 2_000,
  });
  const adapter = new BlockingAdapter();
  const manager = new RunManager(
    new Map<string, RuntimeAdapter>([[adapter.definition.id, adapter]]),
    new SilentLogger(),
    undefined,
    undefined,
    undefined,
    new Map(),
    {
      maxActiveRuns: options.maxActiveRuns ?? 2,
      workspaces,
      ...(options.timeLimitGraceMs ? { timeLimitGraceMs: options.timeLimitGraceMs } : {}),
    },
  );
  const server = await listen(
    createHttpApp({ runManager: manager, profile: "code", workspaces }),
  );
  return { fixture, workspaces, adapter, manager, server };
}

function workspaceBody(fixture: GitFixture, overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws_http",
    repository: { cloneUrl: fixture.remoteUrl, defaultBranch: "main" },
    branch: "slab/cc-7-1",
    fetchToken: null,
    setupCommand: null,
    ...overrides,
  };
}

function target(workspace: { branch: string; baseSha: string | null }) {
  return { branch: workspace.branch, baseSha: workspace.baseSha };
}

function runBody(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    runId,
    agent: {
      id: "dev",
      name: "Developer",
      role: "Engineer",
      instructions: "Write code.",
      permissionMode: "guarded",
      fullAccess: false,
    },
    runtime: { type: "codex", model: null },
    thread: { runtimeThreadId: null },
    message: "Implement it",
    context: [],
    mcpServers: [],
    cwd: null,
    workspace: { id: "ws_http" },
    ...overrides,
  };
}

async function readyWorkspace(context: Awaited<ReturnType<typeof codeApp>>) {
  await request(context.server)
    .post("/workspaces")
    .send(workspaceBody(context.fixture))
    .expect(202);
  return context.workspaces.settled("ws_http");
}

async function waitForTerminal(manager: RunManager, runId: string) {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  await vi.waitFor(
    () => {
      const snapshot = manager.openEventStream(runId, 0, () => undefined);
      snapshot.unsubscribe();
      expect(snapshot.terminal).toBe(true);
      events.splice(0, events.length, ...snapshot.events);
    },
    { timeout: 5_000 },
  );
  return events;
}

describe("profile gating", () => {
  it("keeps workspaces disabled in the agent profile", async () => {
    const adapter = new BlockingAdapter();
    const manager = new RunManager(
      new Map<string, RuntimeAdapter>([[adapter.definition.id, adapter]]),
      new SilentLogger(),
    );
    const server = await listen(createHttpApp({ runManager: manager }));
    await request(server).get("/health").expect(200, { status: "ok", profile: "agent" });
    const listResponse = await request(server).get("/workspaces").expect(404);
    expect(body(listResponse).error.code).toBe("PROFILE_NOT_ENABLED");
    await request(server).post("/workspaces").send({}).expect(404);
    const run = await request(server).post("/runs").send(runBody("run-agent")).expect(400);
    expect(body(run).error.code).toBe("PROFILE_NOT_ENABLED");
  });

  it("reports the code profile in health", async () => {
    const { server } = await codeApp();
    await request(server).get("/health").expect(200, { status: "ok", profile: "code" });
  });
});

describe("workspace HTTP API", () => {
  it("creates idempotently, serves handoff, diff and delete", async () => {
    const context = await codeApp();
    const { server, fixture } = context;
    const created = await request(server)
      .post("/workspaces")
      .send(workspaceBody(fixture))
      .expect(202);
    expect(body(created).data).toMatchObject({ id: "ws_http", status: "preparing" });
    await context.workspaces.settled("ws_http");
    const again = await request(server).post("/workspaces").send(workspaceBody(fixture)).expect(200);
    expect(body(again).data.status).toBe("ready");
    const list = await request(server).get("/workspaces").expect(200);
    expect(body(list).data).toHaveLength(1);
    await request(server)
      .post("/workspaces")
      .send(workspaceBody(fixture, { workspaceId: "bad id" }))
      .expect(400);
    const missing = await request(server).get("/workspaces/nope").expect(404);
    expect(body(missing).error.code).toBe("WORKSPACE_NOT_FOUND");

    const big = "x".repeat(1_500_000);
    const put = await request(server)
      .put("/workspaces/ws_http/handoff/spec.md")
      .send({ content: big })
      .expect(200);
    expect(body(put).data).toMatchObject({ name: "spec.md", size: 1_500_000 });
    const got = await request(server).get("/workspaces/ws_http/handoff/spec.md").expect(200);
    expect(body(got).data.content).toHaveLength(1_500_000);
    const handoffList = await request(server).get("/workspaces/ws_http/handoff").expect(200);
    expect(body(handoffList).data).toEqual([
      expect.objectContaining({ name: "spec.md", size: 1_500_000 }),
    ]);
    const tooBig = await request(server)
      .put("/workspaces/ws_http/handoff/huge.md")
      .send({ content: "x".repeat(2 * 1024 * 1024 + 10) })
      .expect(413);
    expect(body(tooBig).error.code).toBe("INVALID_REQUEST");
    await request(server).put("/workspaces/ws_http/handoff/Bad.md").send({ content: "x" }).expect(400);
    const notFound = await request(server).get("/workspaces/ws_http/handoff/none.md").expect(404);
    expect(body(notFound).error.code).toBe("HANDOFF_NOT_FOUND");

    const workspace = context.workspaces.get("ws_http");
    writeFileSync(join(workspace.repoPath, "new.txt"), "hello\n");
    const diff = await request(server).get("/workspaces/ws_http/diff").expect(200);
    expect(body(diff).data).toMatchObject({
      uncommitted: true,
      files: [{ path: "new.txt", status: "A", insertions: 1, deletions: 0 }],
    });

    await request(server)
      .delete("/workspaces/ws_http")
      .expect(200, { data: { id: "ws_http", deleted: true } });
    await request(server)
      .delete("/workspaces/ws_http")
      .expect(200, { data: { id: "ws_http", deleted: true } });
    await request(server).get("/workspaces/ws_http").expect(404);
  });

  it("publishes and reports policy violations with details", async () => {
    const context = await codeApp();
    const { server, fixture } = context;
    const workspace = await readyWorkspace(context);
    writeFileSync(join(workspace.repoPath, "feature.txt"), "x\n");
    const published = await request(server)
      .post("/workspaces/ws_http/publish")
      .send({ ...target(context.workspaces.get("ws_http")), pushToken: "ghs_token00000000", remoteUrl: fixture.remoteUrl, commitMessage: "Feature" })
      .expect(200);
    expect(body(published).data).toMatchObject({ branch: "slab/cc-7-1", commits: 1, files: 1 });
    expect(gitSync(fixture.remotePath, "rev-parse", "refs/heads/slab/cc-7-1").trim()).toBe(
      body(published).data.headSha,
    );

    writeFileSync(join(workspace.repoPath, "secret.txt"), "x\n");
    const violation = await request(server)
      .post("/workspaces/ws_http/publish")
      .send({
        ...target(context.workspaces.get("ws_http")),
        pushToken: "ghs_token00000000",
        remoteUrl: fixture.remoteUrl,
        forbiddenPaths: ["secret"],
      })
      .expect(422);
    expect(body(violation).error).toMatchObject({
      code: "PUBLISH_POLICY_VIOLATION",
      details: ["secret.txt"],
    });
    expect(typeof body(violation).error.message).toBe("string");
    const badRemote = await request(server)
      .post("/workspaces/ws_http/publish")
      .send({ ...target(context.workspaces.get("ws_http")), pushToken: "t", remoteUrl: "https://example.com/o/r.git" })
      .expect(400);
    expect(body(badRemote).error.code).toBe("INVALID_REQUEST");
  });
});

describe("runs with a workspace", () => {
  it("resolves the workspace, holds the lock for the run and releases it", async () => {
    const context = await codeApp();
    const { server, adapter, manager } = context;
    const workspace = await readyWorkspace(context);

    await request(server).post("/runs").send(runBody("run-1")).expect(202);
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1));
    expect(adapter.requests[0]?.workspace).toEqual({
      id: "ws_http",
      repoPath: workspace.repoPath,
      handoffPath: workspace.handoffPath,
      branch: "slab/cc-7-1",
    });
    const busy = await request(server).get("/workspaces/ws_http").expect(200);
    expect(body(busy).data.status).toBe("busy");

    const second = await request(server).post("/runs").send(runBody("run-2")).expect(409);
    expect(body(second).error.code).toBe("WORKSPACE_BUSY");
    const publish = await request(server)
      .post("/workspaces/ws_http/publish")
      .send({ ...target(context.workspaces.get("ws_http")), pushToken: "ghs_token00000000", remoteUrl: context.fixture.remoteUrl })
      .expect(409);
    expect(body(publish).error.code).toBe("WORKSPACE_BUSY");

    adapter.finish("run-1");
    const events = await waitForTerminal(manager, "run-1");
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(context.workspaces.get("ws_http").status).toBe("ready");
    await request(server).post("/runs").send(runBody("run-3")).expect(202);
    adapter.finish("run-3");
    await waitForTerminal(manager, "run-3");
  });

  it("validates workspace run requests", async () => {
    const context = await codeApp();
    const { server, fixture } = context;
    const missing = await request(server).post("/runs").send(runBody("run-missing")).expect(404);
    expect(body(missing).error.code).toBe("WORKSPACE_NOT_FOUND");

    await request(server)
      .post("/workspaces")
      .send(workspaceBody(fixture, { setupCommand: "sleep 5" }))
      .expect(202);
    const notReady = await request(server).post("/runs").send(runBody("run-nr")).expect(409);
    expect(body(notReady).error.code).toBe("WORKSPACE_NOT_READY");

    const unsupported = await request(server)
      .post("/runs")
      .send(runBody("run-gemini", { runtime: { type: "gemini", model: null } }))
      .expect(400);
    expect(body(unsupported).error.code).toBe("RUNTIME_UNSUPPORTED_FOR_PROFILE");

    const cwd = await request(server)
      .post("/runs")
      .send(runBody("run-cwd", { cwd: "/tmp" }))
      .expect(400);
    expect(body(cwd).error.code).toBe("INVALID_REQUEST");

    // Every code-profile run must take a workspace lock.
    for (const overrides of [{ workspace: null }, { workspace: undefined, cwd: "/tmp" }]) {
      const plain = await request(server)
        .post("/runs")
        .send(runBody("run-plain", overrides))
        .expect(400);
      expect(body(plain).error.code).toBe("WORKSPACE_REQUIRED");
    }

    await request(server)
      .post("/runs")
      .send(runBody("run-limit", { limits: { wallClockSeconds: 14_401 } }))
      .expect(400);
    await request(server).delete("/workspaces/ws_http").expect(200);
  });

  it("fails the run with RUN_TIME_LIMIT after the wall-clock limit", async () => {
    const context = await codeApp();
    const { server, manager, adapter } = context;
    await readyWorkspace(context);
    await request(server)
      .post("/runs")
      .send(runBody("run-slow", { limits: { wallClockSeconds: 1 } }))
      .expect(202);
    const events = await waitForTerminal(manager, "run-slow");
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      data: { error: { code: "RUN_TIME_LIMIT" } },
    });
    expect(adapter.requests).toHaveLength(1);
    expect(context.workspaces.get("ws_http").status).toBe("ready");
  });

  it("forces the terminal event when the runtime ignores the cancel", async () => {
    const context = await codeApp({ timeLimitGraceMs: 200 });
    const { server, manager, adapter } = context;
    adapter.ignoreCancel = true;
    await readyWorkspace(context);
    await request(server)
      .post("/runs")
      .send(runBody("run-stuck", { limits: { wallClockSeconds: 1 } }))
      .expect(202);
    const events = await waitForTerminal(manager, "run-stuck");
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      data: { error: { code: "RUN_TIME_LIMIT" } },
    });
    expect(context.workspaces.get("ws_http").status).toBe("ready");
    // A late adapter completion cannot change the terminal state.
    adapter.finish("run-stuck");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.status("run-stuck")).toBe("failed");
  });

  it("rejects runs over the concurrency limit", async () => {
    const context = await codeApp({ maxActiveRuns: 1 });
    const { server, adapter, manager } = context;
    await readyWorkspace(context);
    await request(server)
      .post("/workspaces")
      .send(workspaceBody(context.fixture, { workspaceId: "ws_two", branch: "slab/cc-7-2" }))
      .expect(202);
    await context.workspaces.settled("ws_two");
    await request(server).post("/runs").send(runBody("run-a")).expect(202);
    const rejected = await request(server)
      .post("/runs")
      .send(runBody("run-b", { workspace: { id: "ws_two" } }))
      .expect(429);
    expect(body(rejected).error.code).toBe("RUNNER_AT_CAPACITY");
    adapter.finish("run-a");
    await waitForTerminal(manager, "run-a");
    await request(server)
      .post("/runs")
      .send(runBody("run-c", { workspace: { id: "ws_two" } }))
      .expect(202);
    adapter.finish("run-c");
    await waitForTerminal(manager, "run-c");
  });

  it("cancels an active run when the workspace is deleted", async () => {
    const context = await codeApp();
    const { server, manager } = context;
    await readyWorkspace(context);
    await request(server).post("/runs").send(runBody("run-del")).expect(202);
    await request(server).delete("/workspaces/ws_http").expect(200);
    const events = await waitForTerminal(manager, "run-del");
    expect(events.at(-1)?.type).toBe("run.cancelled");
  });
});

describe("protocol and Codex adapter", () => {
  it("parses workspace and limits only when supplied", () => {
    const parsed = parseExecutionRequest(runBody("run-parse", { limits: {} }));
    expect(parsed.workspace).toEqual({ id: "ws_http" });
    expect(parsed.limits).toEqual({ wallClockSeconds: 3_600 });
    const plain = parseExecutionRequest(runBody("run-plain", { workspace: undefined }));
    expect("workspace" in plain).toBe(false);
    expect("limits" in plain).toBe(false);
    expect(() =>
      parseExecutionRequest(runBody("run-bad", { workspace: { id: "../etc" } })),
    ).toThrow();
  });

  it("runs workspace threads in the checkout without command approvals", async () => {
    const connection = new FakeAppServerConnection();
    const adapter = new CodexAdapter(connection, "/tmp/safe-runner-cwd");
    await adapter.startThread(
      executionRequest({
        workspace: {
          id: "ws_x",
          repoPath: "/var/lib/slab-code/workspaces/ws_x/repo",
          handoffPath: "/var/lib/slab-code/workspaces/ws_x/handoff",
          branch: "slab/cc-1-1",
        },
      }),
    );
    await adapter.startThread(executionRequest());
    const [workspaceStart, plainStart] = connection.requests
      .filter(({ method }) => method === "thread/start")
      .map(({ params }) => params as Record<string, unknown>);
    expect(workspaceStart).toMatchObject({
      cwd: "/var/lib/slab-code/workspaces/ws_x/repo",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const instructions = String(workspaceStart?.developerInstructions);
    expect(instructions).toContain("/var/lib/slab-code/workspaces/ws_x/handoff");
    expect(instructions).toContain("slab/cc-1-1");
    expect(instructions).toContain("Never push");
    expect(instructions).toContain(".github/workflows/");
    expect(plainStart).toMatchObject({
      cwd: "/tmp/safe-runner-cwd",
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    expect(String(plainStart?.developerInstructions)).not.toContain("Workspace:");
  });
});
