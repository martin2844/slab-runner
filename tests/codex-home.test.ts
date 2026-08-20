import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareIsolatedCodexHome } from "../src/app-server/codex-home.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) =>
    rmSync(directory, { recursive: true, force: true }),
  );
});

describe("prepareIsolatedCodexHome", () => {
  it("copies authentication but never copies global MCP configuration", () => {
    const primaryHome = temporaryDirectory("slab-runner-primary-codex-");
    const runnerHome = temporaryDirectory("slab-runner-isolated-codex-");
    const sourceAuth = join(primaryHome, "auth.json");
    writeFileSync(sourceAuth, '{"token":"primary-secret"}', { mode: 0o600 });
    writeFileSync(
      join(primaryHome, "config.toml"),
      '[mcp_servers.slab]\nurl = "http://localhost:6969/mcp"\n',
    );

    prepareIsolatedCodexHome({
      codexHome: runnerHome,
      authSourceFile: sourceAuth,
    });

    expect(readFileSync(join(runnerHome, "auth.json"), "utf8")).toBe(
      '{"token":"primary-secret"}',
    );
    expect(statSync(join(runnerHome, "auth.json")).mode & 0o777).toBe(0o600);
    const config = readFileSync(join(runnerHome, "config.toml"), "utf8");
    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).not.toContain("mcp_servers");
    expect(config).not.toContain("localhost:6969");
  });

  it("preserves authentication already refreshed inside the runner home", () => {
    const primaryHome = temporaryDirectory("slab-runner-primary-codex-");
    const runnerHome = temporaryDirectory("slab-runner-isolated-codex-");
    const sourceAuth = join(primaryHome, "auth.json");
    writeFileSync(sourceAuth, '{"token":"primary-secret"}', { mode: 0o600 });
    prepareIsolatedCodexHome({
      codexHome: runnerHome,
      authSourceFile: sourceAuth,
    });
    writeFileSync(join(runnerHome, "auth.json"), '{"token":"runner-secret"}', {
      mode: 0o600,
    });

    prepareIsolatedCodexHome({
      codexHome: runnerHome,
      authSourceFile: sourceAuth,
    });

    expect(readFileSync(join(runnerHome, "auth.json"), "utf8")).toBe(
      '{"token":"runner-secret"}',
    );
  });

  it("rejects the primary Codex home as the isolation target", () => {
    const primaryHome = temporaryDirectory("slab-runner-primary-codex-");
    const sourceAuth = join(primaryHome, "auth.json");
    chmodSync(primaryHome, 0o700);

    expect(() =>
      prepareIsolatedCodexHome({
        codexHome: primaryHome,
        authSourceFile: sourceAuth,
      }),
    ).toThrow("must not reuse the user's primary Codex home");
  });

  it("does not overwrite an unrelated non-empty directory", () => {
    const primaryHome = temporaryDirectory("slab-runner-primary-codex-");
    const unrelatedDirectory = temporaryDirectory("slab-runner-unrelated-");
    writeFileSync(join(unrelatedDirectory, "keep.txt"), "user data");

    expect(() =>
      prepareIsolatedCodexHome({
        codexHome: unrelatedDirectory,
        authSourceFile: join(primaryHome, "auth.json"),
      }),
    ).toThrow("must be empty or already managed by Slab Runner");
    expect(readFileSync(join(unrelatedDirectory, "keep.txt"), "utf8")).toBe(
      "user data",
    );
  });
});
