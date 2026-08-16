import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses loopback-safe defaults", () => {
    expect(loadConfig({})).toMatchObject({
      host: "127.0.0.1",
      port: 6990,
      codexBin: "codex",
    });
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
        RUNNER_TOKEN: "a-long-local-token",
      }),
    ).toMatchObject({
      host: "::1",
      port: 7000,
      codexBin: "/usr/local/bin/codex",
      runnerToken: "a-long-local-token",
    });
  });

  it("rejects short local authentication tokens", () => {
    expect(() => loadConfig({ RUNNER_TOKEN: "short" })).toThrow();
  });
});
