import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAuthManager } from "../src/auth/codex-auth-manager.js";
import { createHttpApp } from "../src/http/app.js";
import { SilentLogger } from "../src/lib/logger.js";
import type {
  RuntimeAdapter,
  RuntimeHealth,
  RuntimeTurnContext,
} from "../src/runtime/adapter.js";
import { RunnerError } from "../src/runtime/errors.js";
import type { AgentExecutionRequest } from "../src/runtime/protocol.js";
import { RuntimeActivityGate } from "../src/runtime/activity-gate.js";
import { RunManager } from "../src/runtime/run-manager.js";
import {
  TEST_RUNTIME_DEFINITION,
  testRuntimeHealth,
} from "./helpers/runtime.js";
import { FakeAppServerConnection } from "./helpers/fake-connection.js";

class HttpTestAdapter implements RuntimeAdapter {
  readonly definition = TEST_RUNTIME_DEFINITION;
  cancelled: string[] = [];
  approvals: Array<{
    runId: string;
    approvalId: string;
    decision: "approve" | "deny";
  }> = [];
  turn: (context: RuntimeTurnContext) => Promise<void> = (context) => {
    context.emit("assistant.completed", { message: "Done" });
    return Promise.resolve();
  };
  cancel: (runId: string) => Promise<void> = (runId) => {
    this.cancelled.push(runId);
    return Promise.resolve();
  };

  start(): Promise<void> {
    return Promise.resolve();
  }
  health(): Promise<RuntimeHealth> {
    return Promise.resolve(testRuntimeHealth());
  }
  startThread(): Promise<string> {
    return Promise.resolve("thread-http");
  }
  resumeThread(): Promise<string> {
    return Promise.resolve("thread-http");
  }
  runTurn(context: RuntimeTurnContext): Promise<void> {
    return this.turn(context);
  }
  cancelRun(runId: string): Promise<void> {
    return this.cancel(runId);
  }
  respondToApproval(
    runId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<void> {
    this.approvals.push({ runId, approvalId, decision });
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const validBody: AgentExecutionRequest = {
  runId: "run-http",
  agent: {
    id: "coo",
    name: "COO",
    role: "Operations",
    instructions: "Operate.",
    fullAccess: false,
  },
  runtime: { type: "codex", model: null },
  thread: { runtimeThreadId: null },
  message: "Start",
  context: [],
  mcpServers: [],
  cwd: null,
};

const openServers = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  openServers.clear();
});

async function testApp(
  runnerToken?: string,
  codexAuth?: CodexAuthManager,
  runtimeActivityGates: ReadonlyMap<string, RuntimeActivityGate> = new Map(),
) {
  const adapter = new HttpTestAdapter();
  const manager = new RunManager(
    new Map<string, RuntimeAdapter>([[adapter.definition.id, adapter]]),
    new SilentLogger(),
    undefined,
    undefined,
    undefined,
    runtimeActivityGates,
  );
  const app = createHttpApp({
    runManager: manager,
    ...(codexAuth ? { codexAuth } : {}),
    ...(runnerToken ? { runnerToken } : {}),
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  openServers.add(server);
  return {
    adapter,
    manager,
    server,
  };
}

describe("Runner HTTP API", () => {
  it("reports health and runtime availability", async () => {
    const { server } = await testApp();
    await request(server).get("/health").expect(200, { status: "ok" });
    const response = await request(server).get("/runtimes").expect(200);
    expect(response.body).toEqual({
      data: [
        {
          ...TEST_RUNTIME_DEFINITION,
          ...testRuntimeHealth(),
        },
      ],
    });
  });

  it("exposes structured Codex device authentication without token fields", async () => {
    const connection = new FakeAppServerConnection();
    let authenticated = false;
    connection.requestHandler = (method) => {
      if (method === "account/read") {
        return Promise.resolve({
          account: authenticated
            ? {
                type: "chatgpt",
                email: "operator@example.com",
                planType: "plus",
                accessToken: "never-return-this",
              }
            : null,
        });
      }
      if (method === "account/login/start") return Promise.resolve({
        type: "chatgptDeviceCode",
        loginId: "login-http",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "HTTP-1234",
      });
      if (method === "account/logout") {
        authenticated = false;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    };
    const activityGate = new RuntimeActivityGate();
    const codexAuth = new CodexAuthManager(connection, activityGate);
    const { server } = await testApp(
      undefined,
      codexAuth,
      new Map([["codex", activityGate]]),
    );

    await request(server).get("/auth/codex").expect(200, {
      data: {
        status: "not_authenticated",
        authMode: null,
        email: null,
        planType: null,
        login: null,
      },
    });
    const started = await request(server)
      .post("/auth/codex/device-login")
      .expect(202);
    expect(started.body).toMatchObject({
      data: {
        loginId: "login-http",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "HTTP-1234",
        status: "pending",
      },
    });
    expect(JSON.stringify(started.body)).not.toContain("Token");
    await request(server).post("/runs").send(validBody).expect(409, {
      error: {
        code: "RUNTIME_UNAVAILABLE",
        message: "Runtime authentication is changing",
      },
    });

    await request(server)
      .delete("/auth/codex/device-login/login-http")
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ data: { status: "cancelled" } });
      });
    authenticated = true;
    await request(server)
      .post("/auth/codex/logout")
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ data: { status: "not_authenticated" } });
        expect(JSON.stringify(body)).not.toContain("never-return-this");
      });
  });

  it("creates a run immediately and exposes replayable SSE events", async () => {
    const { server, manager } = await testApp();
    await request(server)
      .post("/runs")
      .send(validBody)
      .expect(202, { runId: "run-http", status: "running" });
    await vi.waitFor(() =>
      expect(manager.status("run-http")).toBe("completed"),
    );

    const response = await request(server)
      .get("/runs/run-http/events")
      .set("Accept", "text/event-stream")
      .expect(200)
      .expect("Content-Type", /text\/event-stream/);
    expect(response.text).toContain("event: run.started");
    expect(response.text).toContain("event: thread.created");
    expect(response.text).toContain("event: assistant.completed");
    expect(response.text).toContain("event: run.completed");
  });

  it("attaches only to an existing run without creating a replacement", async () => {
    const { server, manager } = await testApp();
    await request(server).post("/runs").send(validBody).expect(202);
    await vi.waitFor(() =>
      expect(manager.status("run-http")).toBe("completed"),
    );
    await request(server)
      .post("/runs/run-http/attach")
      .expect(200, { runId: "run-http", status: "completed" });
    await request(server)
      .post("/runs/missing/attach")
      .expect(404, {
        error: { code: "RUN_NOT_FOUND", message: "Run was not found" },
      });
  });

  it("returns 410 through HTTP after a restarted runner has only the durable tombstone", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slab-runner-http-journal-"));
    const journal = join(directory, "runs.jsonl");
    try {
      const firstAdapter = new HttpTestAdapter();
      const firstManager = new RunManager(
        new Map([[firstAdapter.definition.id, firstAdapter]]),
        new SilentLogger(),
        50,
        journal,
      );
      firstManager.create(validBody);
      await vi.waitFor(() =>
        expect(firstManager.status("run-http")).toBe("completed"),
      );
      await vi.waitFor(() =>
        expect(firstManager.status("run-http")).toBeNull(),
      );

      const restartedAdapter = new HttpTestAdapter();
      const restartedManager = new RunManager(
        new Map([[restartedAdapter.definition.id, restartedAdapter]]),
        new SilentLogger(),
        1,
        journal,
      );
      const app = createHttpApp({
        runManager: restartedManager,
      });
      const server = createServer(app);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      openServers.add(server);

      const expired = {
        error: {
          code: "RUN_HISTORY_EXPIRED",
          message: "Run history is no longer available",
        },
      };
      await request(server).post("/runs/run-http/attach").expect(410, expired);
      await request(server).post("/runs").send(validBody).expect(410);
      expect(restartedAdapter.cancelled).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a safe unavailable error for a valid but unregistered runtime", async () => {
    const { server } = await testApp();
    const response = await request(server)
      .post("/runs")
      .send({ ...validBody, runtime: { type: "claude" } })
      .expect(503);
    expect(response.body).toMatchObject({
      error: {
        code: "RUNTIME_UNAVAILABLE",
        message: "Requested runtime is unavailable",
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("stack");
  });

  it("returns safe validation errors for malformed runtime IDs", async () => {
    const { server } = await testApp();
    const response = await request(server)
      .post("/runs")
      .send({ ...validBody, runtime: { type: "Claude API" } })
      .expect(400);
    expect(response.body).toMatchObject({
      error: { code: "INVALID_REQUEST", message: "Request validation failed" },
    });
    expect(JSON.stringify(response.body)).not.toContain("stack");
  });

  it("returns a 400 error for malformed JSON", async () => {
    const { server } = await testApp();
    await request(server)
      .post("/runs")
      .set("Content-Type", "application/json")
      .send('{"runId":')
      .expect(400, {
        error: {
          code: "INVALID_REQUEST",
          message: "Request body must be valid JSON",
        },
      });
  });

  it("protects every operational endpoint when RUNNER_TOKEN is configured", async () => {
    const { server } = await testApp("sixteen-byte-token");
    await request(server).get("/health").expect(200);
    await request(server).get("/runtimes").expect(401);
    await request(server)
      .get("/runtimes")
      .set("Authorization", "Bearer sixteen-byte-token")
      .expect(200);
  });

  it("returns 404 for unknown runs before opening SSE headers", async () => {
    const { server } = await testApp();
    await request(server)
      .get("/runs/missing/events")
      .expect(404, {
        error: { code: "RUN_NOT_FOUND", message: "Run was not found" },
      });
  });

  it("forwards approval decisions through the HTTP boundary", async () => {
    const { server, adapter, manager } = await testApp();
    let context!: RuntimeTurnContext;
    let finishTurn!: () => void;
    adapter.turn = (turnContext) => {
      context = turnContext;
      return new Promise((resolve) => {
        finishTurn = resolve;
      });
    };
    await request(server).post("/runs").send(validBody).expect(202);
    await vi.waitFor(() => expect(context).toBeDefined());
    context.emit("approval.required", { approvalId: "approval-http" });

    await request(server)
      .post("/runs/run-http/approvals/approval-http")
      .send({ decision: "deny" })
      .expect(200, {
        runId: "run-http",
        approvalId: "approval-http",
        decision: "deny",
      });
    expect(adapter.approvals).toEqual([
      {
        runId: "run-http",
        approvalId: "approval-http",
        decision: "deny",
      },
    ]);
    context.emit("approval.resolved", {
      approvalId: "approval-http",
      decision: "deny",
    });
    finishTurn();
    await vi.waitFor(() =>
      expect(manager.status("run-http")).toBe("completed"),
    );
  });

  it("forwards cancellation through the HTTP boundary", async () => {
    const { server, adapter, manager } = await testApp();
    let rejectTurn!: (error: Error) => void;
    adapter.turn = () =>
      new Promise((_resolve, reject) => {
        rejectTurn = reject;
      });
    await request(server).post("/runs").send(validBody).expect(202);
    await vi.waitFor(() => expect(rejectTurn).toBeDefined());

    await request(server).delete("/runs/run-http").expect(200, {
      runId: "run-http",
      status: "cancelling",
    });
    expect(adapter.cancelled).toEqual(["run-http"]);
    rejectTurn(new RunnerError("RUN_CANCELLED", "Run was cancelled", 409));
    await vi.waitFor(() =>
      expect(manager.status("run-http")).toBe("cancelled"),
    );
  });
});
