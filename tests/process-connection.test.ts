import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessAppServerConnection } from "../src/app-server/process-connection.js";
import { SilentLogger } from "../src/lib/logger.js";

const fakeCodex = resolve("tests/fixtures/fake-codex");
const connections: ProcessAppServerConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.stop()));
  delete process.env.RUNNER_TOKEN;
});

describe("ProcessAppServerConnection", () => {
  it("initializes JSONL RPC and does not expose RUNNER_TOKEN to Codex", async () => {
    process.env.RUNNER_TOKEN = "runner-secret-token";
    const connection = new ProcessAppServerConnection(
      fakeCodex,
      new SilentLogger(),
    );
    connections.push(connection);

    await connection.start();
    expect(connection.ready).toBe(true);
    await expect(connection.request("echo", { value: 42 })).resolves.toEqual({
      value: 42,
    });
    await expect(connection.request("environment/read")).resolves.toEqual({
      runnerToken: null,
    });
  });

  it("rejects active requests on crash and restores availability", async () => {
    const connection = new ProcessAppServerConnection(
      fakeCodex,
      new SilentLogger(),
    );
    connections.push(connection);
    await connection.start();
    const crash = vi.fn();
    connection.on("crash", crash);

    await expect(connection.request("crash")).rejects.toMatchObject({
      code: "RUNTIME_CRASHED",
    });
    expect(crash).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(connection.ready).toBe(true), {
      timeout: 3_000,
    });
    await expect(connection.request("echo", { restarted: true })).resolves.toEqual({
      restarted: true,
    });
  });
});
