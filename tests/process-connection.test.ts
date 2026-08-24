import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessAppServerConnection } from "../src/app-server/process-connection.js";
import { SilentLogger } from "../src/lib/logger.js";

const fakeCodex = resolve("tests/fixtures/fake-codex");
const connections: ProcessAppServerConnection[] = [];
const temporaryHomes: string[] = [];

function isolatedCodexHome() {
  const directory = mkdtempSync(join(tmpdir(), "slab-runner-codex-home-"));
  temporaryHomes.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.stop()));
  temporaryHomes.splice(0).forEach((directory) =>
    rmSync(directory, { recursive: true, force: true }),
  );
  delete process.env.RUNNER_TOKEN;
});

describe("ProcessAppServerConnection", () => {
  it("initializes JSONL RPC and does not expose RUNNER_TOKEN to Codex", async () => {
    process.env.RUNNER_TOKEN = "runner-secret-token";
    const codexHome = isolatedCodexHome();
    const connection = new ProcessAppServerConnection(
      fakeCodex,
      new SilentLogger(),
      codexHome,
    );
    connections.push(connection);

    await connection.start();
    expect(connection.ready).toBe(true);
    await expect(connection.request("echo", { value: 42 })).resolves.toEqual({
      value: 42,
    });
    const environment = (await connection.request("environment/read")) as {
      runnerToken: string | null;
      codexHome: string | null;
      argv: string[];
    };
    expect(environment).toEqual({
      runnerToken: null,
      codexHome,
      argv: ["app-server", "--stdio"],
    });
  });

  it("rejects active requests on crash and restores availability", async () => {
    const connection = new ProcessAppServerConnection(
      fakeCodex,
      new SilentLogger(),
      isolatedCodexHome(),
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

  it("abandons an aborted RPC request and remains usable", async () => {
    const connection = new ProcessAppServerConnection(
      fakeCodex,
      new SilentLogger(),
      isolatedCodexHome(),
    );
    connections.push(connection);
    await connection.start();
    const controller = new AbortController();

    const request = connection.request("hang", {}, { signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      message: "Runtime request was cancelled",
    });
    await expect(connection.request("echo", { recovered: true })).resolves.toEqual({
      recovered: true,
    });
  });
});
