import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function tokenFile(value: string) {
    const directory = mkdtempSync(join(tmpdir(), "slab-runner-config-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "runner-token");
    writeFileSync(filename, value, { mode: 0o600 });
    return filename;
  }

  it("uses loopback-safe defaults", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 6990,
      codexBin: "codex",
    });
    expect(config.codexHome).toContain("slab-runner/codex");
    expect(config.codexAuthSourceFile).toContain(".codex/auth.json");
  });

  it.each(["192.168.1.10", "example.test"])(
    "rejects unsupported host %s",
    (host) => {
      expect(() => loadConfig({ RUNNER_HOST: host })).toThrow();
    },
  );

  it("rejects a container bind without internal authentication", () => {
    expect(() => loadConfig({ RUNNER_HOST: "0.0.0.0" })).toThrow(
      /non-loopback RUNNER_HOST requires/,
    );
  });

  it("accepts an authenticated container bind", () => {
    expect(
      loadConfig({
        RUNNER_HOST: "0.0.0.0",
        RUNNER_TOKEN: "a-long-container-token",
      }),
    ).toMatchObject({
      host: "0.0.0.0",
      runnerToken: "a-long-container-token",
    });
  });

  it("accepts explicit loopback configuration and a sufficiently long token", () => {
    expect(
      loadConfig({
        RUNNER_HOST: "::1",
        RUNNER_PORT: "7000",
        CODEX_BIN: "/usr/local/bin/codex",
        RUNNER_CODEX_HOME: "/var/lib/slab-runner/codex",
        CODEX_HOME: "/var/lib/codex-user",
        RUNNER_TOKEN: "a-long-local-token",
      }),
    ).toMatchObject({
      host: "::1",
      port: 7000,
      codexBin: "/usr/local/bin/codex",
      codexHome: "/var/lib/slab-runner/codex",
      codexAuthSourceFile: "/var/lib/codex-user/auth.json",
      runnerToken: "a-long-local-token",
    });
  });

  it("rejects short local authentication tokens", () => {
    expect(() => loadConfig({ RUNNER_TOKEN: "short" })).toThrow();
  });

  it("reads an authenticated container token from a secret file", () => {
    expect(
      loadConfig({
        RUNNER_HOST: "0.0.0.0",
        RUNNER_TOKEN_FILE: tokenFile("a-file-backed-token\n"),
      }),
    ).toMatchObject({
      host: "0.0.0.0",
      runnerToken: "a-file-backed-token",
    });
  });

  it("rejects ambiguous environment and file token configuration", () => {
    expect(() =>
      loadConfig({
        RUNNER_TOKEN: "a-long-local-token",
        RUNNER_TOKEN_FILE: tokenFile("a-file-backed-token"),
      }),
    ).toThrow(/Configure only one/);
  });

  it("rejects a short token read from a secret file", () => {
    expect(() =>
      loadConfig({ RUNNER_TOKEN_FILE: tokenFile("short\n") }),
    ).toThrow(/at least 16 characters/);
  });
});
