import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
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

  it.each(["0.0.0.0", "192.168.1.10", "example.test"])(
    "rejects non-loopback host %s",
    (host) => {
      expect(() => loadConfig({ RUNNER_HOST: host })).toThrow();
    },
  );

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
});
