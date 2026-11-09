import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Redactor } from "../src/lib/redactor.js";
import { RunnerError } from "../src/runtime/errors.js";
import {
  credentialArgs,
  git,
  gitEnv,
  isAllowedRemoteUrl,
  isSafeRefName,
  sanitizeGitOutput,
} from "../src/workspaces/git.js";
import {
  createWorkspaceSchema,
  publishSchema,
} from "../src/workspaces/types.js";
import { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { createGitFixture, gitSync, type GitFixture } from "./helpers/git-fixture.js";

const fixtures: GitFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function setup(options: { allowFileRemotes?: boolean; redactor?: Redactor } = {}) {
  const fixture = createGitFixture();
  fixtures.push(fixture);
  const manager = new WorkspaceManager({
    root: fixture.codeRoot,
    allowFileRemotes: options.allowFileRemotes ?? true,
    deleteGraceMs: 2_000,
    ...(options.redactor ? { redactor: options.redactor } : {}),
  });
  return { fixture, manager };
}

function createInput(fixture: GitFixture, overrides: Record<string, unknown> = {}) {
  return createWorkspaceSchema.parse({
    workspaceId: "ws_test",
    repository: { cloneUrl: fixture.remoteUrl, defaultBranch: "main" },
    branch: "slab/cc-42-1",
    fetchToken: null,
    setupCommand: null,
    gitIdentity: { name: "Slab Bot", email: "slab@users.noreply.github.com" },
    ...overrides,
  });
}

async function readyWorkspace(overrides: Record<string, unknown> = {}) {
  const context = setup();
  context.manager.create(createInput(context.fixture, overrides));
  const workspace = await context.manager.settled("ws_test");
  return { ...context, workspace };
}

/** The publish target the control plane sends: its view of the workspace. */
function target(workspace: { branch: string; baseSha: string | null }) {
  return { branch: workspace.branch, baseSha: workspace.baseSha };
}

function expectRunnerError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RunnerError);
    expect((error as RunnerError).code).toBe(code);
    return error as RunnerError;
  }
  throw new Error(`Expected ${code}`);
}

describe("WorkspaceManager", () => {
  it("clones, switches to the workspace branch, removes origin and becomes ready", async () => {
    const { manager, fixture } = setup();
    const created = manager.create(createInput(fixture));
    expect(created.created).toBe(true);
    expect(created.workspace).toMatchObject({
      id: "ws_test",
      status: "preparing",
      baseSha: null,
      branch: "slab/cc-42-1",
      setup: { status: "skipped", exitCode: null, logTail: "" },
      error: null,
    });

    const workspace = await manager.settled("ws_test");
    expect(workspace.status).toBe("ready");
    expect(workspace.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(workspace.headSha).toBe(workspace.baseSha);
    expect(workspace.repoPath).toBe(join(fixture.codeRoot, "workspaces", "ws_test", "repo"));
    expect(existsSync(workspace.handoffPath)).toBe(true);
    const repo = workspace.repoPath;
    expect(gitSync(repo, "branch", "--show-current").trim()).toBe("slab/cc-42-1");
    expect(gitSync(repo, "remote").trim()).toBe("");
    expect(gitSync(repo, "config", "user.name").trim()).toBe("Slab Bot");
    expect(existsSync(join(fixture.codeRoot, "workspaces", "ws_test", "workspace.json"))).toBe(true);
  });

  it("is idempotent for the same workspace id", async () => {
    const { manager, fixture } = await readyWorkspace();
    const again = manager.create(createInput(fixture, { branch: "slab/other" }));
    expect(again.created).toBe(false);
    expect(again.workspace.branch).toBe("slab/cc-42-1");
    expect(again.workspace.status).toBe("ready");
    expect(manager.list()).toHaveLength(1);
  });

  it("records a passing setup command", async () => {
    const { workspace } = await readyWorkspace({
      setupCommand: "echo installing && touch setup-done",
    });
    expect(workspace.status).toBe("ready");
    expect(workspace.setup).toMatchObject({ status: "passed", exitCode: 0 });
    expect(workspace.setup.logTail).toContain("installing");
    expect(existsSync(join(workspace.repoPath, "setup-done"))).toBe(true);
  });

  it("keeps the workspace ready when setup fails", async () => {
    const { workspace } = await readyWorkspace({
      setupCommand: "echo broken >&2; exit 3",
    });
    expect(workspace.status).toBe("ready");
    expect(workspace.setup).toMatchObject({ status: "failed", exitCode: 3 });
    expect(workspace.setup.logTail).toContain("broken");
  });

  it("times out a long setup command", async () => {
    const { workspace } = await readyWorkspace({
      setupCommand: "sleep 30",
      setupTimeoutSeconds: 1,
    });
    expect(workspace.status).toBe("ready");
    expect(workspace.setup.status).toBe("failed");
    expect(workspace.setup.logTail).toContain("timed out");
  });

  it("fails the workspace when the clone fails", async () => {
    const { manager, fixture } = setup();
    manager.create(createInput(fixture, { baseRef: "does-not-exist" }));
    const workspace = await manager.settled("ws_test");
    expect(workspace.status).toBe("failed");
    expect(workspace.error).toMatch(/git clone failed/);
    expect(workspace.baseSha).toBeNull();
  });

  it("validates clone URLs and names", () => {
    const { manager, fixture } = setup({ allowFileRemotes: false });
    expectRunnerError(() => manager.create(createInput(fixture)), "INVALID_REQUEST");
    expect(isAllowedRemoteUrl("https://github.com/o/r.git", false)).toBe(true);
    expect(isAllowedRemoteUrl("https://github.com/o/r", false)).toBe(true);
    expect(isAllowedRemoteUrl("https://gitlab.com/o/r.git", false)).toBe(false);
    expect(isAllowedRemoteUrl("https://x:y@github.com/o/r.git", false)).toBe(false);
    expect(isAllowedRemoteUrl("https://github.com/o/r/extra", false)).toBe(false);
    expect(isAllowedRemoteUrl("file:///tmp/r.git", false)).toBe(false);
    expect(isAllowedRemoteUrl("file:///tmp/r.git", true)).toBe(true);
    expect(isSafeRefName("slab/cc-1")).toBe(true);
    expect(isSafeRefName("--upload-pack=x")).toBe(false);
    expect(isSafeRefName("a/../b")).toBe(false);
    expect(isSafeRefName("a/.hidden")).toBe(false);
    expect(() =>
      createWorkspaceSchema.parse({ ...createInput(fixture), branch: "main" }),
    ).toThrow();
    expect(() =>
      createWorkspaceSchema.parse({ ...createInput(fixture), workspaceId: "../x" }),
    ).toThrow();
  });

  it("never persists the fetch token", async () => {
    const token = "ghs_FetchTokenThatMustNeverBeStored0001";
    const redactor = new Redactor();
    const { manager, fixture } = setup({ redactor });
    manager.create(createInput(fixture, { fetchToken: token }));
    const workspace = await manager.settled("ws_test");
    expect(workspace.status).toBe("ready");
    const metadata = readFileSync(
      join(fixture.codeRoot, "workspaces", "ws_test", "workspace.json"),
      "utf8",
    );
    expect(metadata).not.toContain(token);
    expect(readFileSync(join(workspace.repoPath, ".git", "config"), "utf8")).not.toContain(token);
    // Released from the redactor once the clone finished.
    expect(redactor.text(token)).toBe(token);
  });

  it("sanitizes credentials from git output", () => {
    const text =
      "fatal: unable to access 'https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz@github.com/o/r.git/': 403 secret-value";
    const sanitized = sanitizeGitOutput(text, ["secret-value"]);
    expect(sanitized).not.toContain("ghs_abcdefghijklmnopqrstuvwxyz");
    expect(sanitized).not.toContain("x-access-token:");
    expect(sanitized).not.toContain("secret-value");
    expect(sanitizeGitOutput("token github_pat_ABCDEFGHIJKLMNOPQRSTUV here")).toBe(
      "token [REDACTED] here",
    );
  });

  describe("handoff", () => {
    it("writes, reads and lists files", async () => {
      const { manager } = await readyWorkspace();
      const written = manager.writeHandoff("ws_test", "spec.md", "# Spec\nñ\n");
      expect(written).toMatchObject({ name: "spec.md", size: Buffer.byteLength("# Spec\nñ\n") });
      manager.writeHandoff("ws_test", "plan.md", "plan");
      expect(manager.readHandoff("ws_test", "spec.md")).toMatchObject({
        name: "spec.md",
        content: "# Spec\nñ\n",
      });
      expect(manager.listHandoff("ws_test").map(({ name }) => name)).toEqual([
        "plan.md",
        "spec.md",
      ]);
    });

    it("validates names, size, and missing files", async () => {
      const { manager } = await readyWorkspace();
      for (const name of ["../x", ".hidden", "Spec.md", "a/b", ""]) {
        expectRunnerError(() => manager.writeHandoff("ws_test", name, "x"), "INVALID_REQUEST");
      }
      const tooLarge = expectRunnerError(
        () => manager.writeHandoff("ws_test", "big.txt", "x".repeat(2 * 1024 * 1024 + 1)),
        "INVALID_REQUEST",
      );
      expect(tooLarge.httpStatus).toBe(413);
      manager.writeHandoff("ws_test", "max.txt", "x".repeat(2 * 1024 * 1024));
      expectRunnerError(() => manager.readHandoff("ws_test", "missing.md"), "HANDOFF_NOT_FOUND");
      expectRunnerError(() => manager.listHandoff("ws_missing"), "WORKSPACE_NOT_FOUND");
    });
  });

  describe("diff", () => {
    it("includes committed, uncommitted and untracked changes without touching the index", async () => {
      const { manager, workspace } = await readyWorkspace();
      const repo = workspace.repoPath;
      writeFileSync(join(repo, "committed.txt"), "c\n");
      gitSync(repo, "add", "committed.txt");
      gitSync(repo, "commit", "--quiet", "-m", "Add committed file");
      writeFileSync(join(repo, "src", "a.txt"), "one\nTWO\nthree\nfour\n");
      writeFileSync(join(repo, "untracked.txt"), "new\nfile\n");
      rmSync(join(repo, "README.md"));
      mkdirSync(join(repo, "node_modules"));
      writeFileSync(join(repo, "node_modules", "ignored.js"), "x");
      const indexBefore = readFileSync(join(repo, ".git", "index"));
      const statusBefore = gitSync(repo, "status", "--porcelain");

      const diff = await manager.diff("ws_test");

      expect(readFileSync(join(repo, ".git", "index")).equals(indexBefore)).toBe(true);
      expect(gitSync(repo, "status", "--porcelain")).toBe(statusBefore);
      expect(diff.baseSha).toBe(workspace.baseSha);
      expect(diff.headSha).not.toBe(workspace.baseSha);
      expect(diff.uncommitted).toBe(true);
      expect(diff.truncated).toBe(false);
      const byPath = Object.fromEntries(diff.files.map((file) => [file.path, file]));
      expect(byPath["untracked.txt"]).toEqual({ path: "untracked.txt", status: "A", insertions: 2, deletions: 0 });
      expect(byPath["committed.txt"]).toMatchObject({ status: "A", insertions: 1 });
      expect(byPath["README.md"]).toMatchObject({ status: "D", deletions: 1 });
      expect(byPath["src/a.txt"]).toMatchObject({ status: "M", insertions: 2, deletions: 1 });
      expect(byPath["node_modules/ignored.js"]).toBeUndefined();
      expect(diff.insertions).toBe(5);
      expect(diff.deletions).toBe(2);
      expect(diff.commits).toEqual([
        { sha: diff.headSha, subject: "Add committed file" },
      ]);
      expect(diff.patch).toContain("+++ b/untracked.txt");
    });

    it("reports a clean workspace", async () => {
      const { manager } = await readyWorkspace();
      const diff = await manager.diff("ws_test");
      expect(diff).toMatchObject({ files: [], uncommitted: false, commits: [], patch: "" });
    });
  });

  describe("publish", () => {
    it("commits pending changes and force-pushes only the workspace branch", async () => {
      const { manager, workspace, fixture } = await readyWorkspace();
      const repo = workspace.repoPath;
      writeFileSync(join(repo, "feature.txt"), "feature\n");
      // An agent-planted url rewrite must not redirect the push.
      gitSync(repo, "config", `url.file:///nonexistent/.insteadOf`, fixture.remoteUrl);

      const result = await manager.publish(
        "ws_test",
        publishSchema.parse({
          ...target(manager.get("ws_test")),
          pushToken: "ghs_PushTokenValue0000000000000001",
          remoteUrl: fixture.remoteUrl,
          commitMessage: "[CC-42] Apply pending changes",
        }),
      );

      expect(result).toMatchObject({
        branch: "slab/cc-42-1",
        baseSha: workspace.baseSha,
        commits: 1,
        insertions: 1,
        deletions: 0,
        files: 1,
      });
      expect(gitSync(fixture.remotePath, "rev-parse", "refs/heads/slab/cc-42-1").trim()).toBe(result.headSha);
      expect(gitSync(fixture.remotePath, "log", "-1", "--format=%s", "refs/heads/slab/cc-42-1").trim()).toBe(
        "[CC-42] Apply pending changes",
      );
      expect(gitSync(fixture.remotePath, "rev-parse", "refs/heads/main").trim()).toBe(workspace.baseSha);
      expect(gitSync(repo, "remote").trim()).toBe("");
      expect(manager.get("ws_test")).toMatchObject({ status: "ready", headSha: result.headSha });

      // A rewritten history is force-pushed over the previous branch.
      gitSync(repo, "commit", "--quiet", "--amend", "-m", "Rewritten");
      const second = await manager.publish(
        "ws_test",
        publishSchema.parse({ ...target(manager.get("ws_test")), pushToken: "ghs_x0000000000", remoteUrl: fixture.remoteUrl }),
      );
      expect(gitSync(fixture.remotePath, "rev-parse", "refs/heads/slab/cc-42-1").trim()).toBe(second.headSha);
    });

    it("refuses changes under forbidden paths", async () => {
      const { manager, workspace, fixture } = await readyWorkspace();
      mkdirSync(join(workspace.repoPath, ".github", "workflows"), { recursive: true });
      writeFileSync(join(workspace.repoPath, ".github", "workflows", "ci.yml"), "on: push\n");
      writeFileSync(join(workspace.repoPath, "ok.txt"), "ok\n");
      const error = await manager
        .publish(
          "ws_test",
          publishSchema.parse({ ...target(manager.get("ws_test")), pushToken: "ghs_x0000000000", remoteUrl: fixture.remoteUrl }),
        )
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RunnerError);
      expect(error).toMatchObject({
        code: "PUBLISH_POLICY_VIOLATION",
        httpStatus: 422,
        details: [".github/workflows/ci.yml"],
      });
      expect(() => gitSync(fixture.remotePath, "rev-parse", "--verify", "--quiet", "refs/heads/slab/cc-42-1")).toThrow();
      expect(manager.get("ws_test").status).toBe("ready");
    });

    it("reports push failures with a sanitized message", async () => {
      const { manager, fixture } = await readyWorkspace();
      const error = await manager
        .publish(
          "ws_test",
          publishSchema.parse({
          ...target(manager.get("ws_test")),
            pushToken: "ghs_SecretPushToken000000000001",
            remoteUrl: `file://${join(fixture.directory, "missing.git")}`,
          }),
        )
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "GIT_PUSH_FAILED", httpStatus: 502 });
      expect((error as Error).message).not.toContain("ghs_SecretPushToken000000000001");
    });
  });

  describe("locking", () => {
    it("holds the lock for a run and rejects concurrent runs and publishes", async () => {
      const { manager, fixture } = await readyWorkspace();
      const lease = manager.acquireForRun("ws_test", "run-1", () => Promise.resolve());
      expect(lease.workspace).toMatchObject({ id: "ws_test", branch: "slab/cc-42-1" });
      expect(manager.get("ws_test").status).toBe("busy");
      expectRunnerError(
        () => manager.acquireForRun("ws_test", "run-2", () => Promise.resolve()),
        "WORKSPACE_BUSY",
      );
      await expect(
        manager.publish(
          "ws_test",
          publishSchema.parse({ ...target(manager.get("ws_test")), pushToken: "ghs_x0000000000", remoteUrl: fixture.remoteUrl }),
        ),
      ).rejects.toMatchObject({ code: "WORKSPACE_BUSY", httpStatus: 409 });
      lease.release();
      expect(manager.get("ws_test").status).toBe("ready");
    });

    it("rejects runs on workspaces that are not ready", () => {
      const { manager, fixture } = setup();
      manager.create(createInput(fixture, { setupCommand: "sleep 5" }));
      expectRunnerError(
        () => manager.acquireForRun("ws_test", "run-1", () => Promise.resolve()),
        "WORKSPACE_NOT_READY",
      );
      expectRunnerError(
        () => manager.acquireForRun("missing", "run-1", () => Promise.resolve()),
        "WORKSPACE_NOT_FOUND",
      );
      return manager.delete("ws_test");
    });
  });

  it("deletes the workspace, cancelling an active run", async () => {
    const { manager, fixture } = await readyWorkspace();
    let cancelled = false;
    const lease = manager.acquireForRun("ws_test", "run-1", () => {
      cancelled = true;
      lease.release();
      return Promise.resolve();
    });
    await expect(manager.delete("ws_test")).resolves.toEqual({ id: "ws_test", deleted: true });
    expect(cancelled).toBe(true);
    expect(existsSync(join(fixture.codeRoot, "workspaces", "ws_test"))).toBe(false);
    expectRunnerError(() => manager.get("ws_test"), "WORKSPACE_NOT_FOUND");
    await expect(manager.delete("ws_test")).resolves.toEqual({ id: "ws_test", deleted: true });
  });

  it("recovers interrupted workspaces after a restart", async () => {
    const { manager, fixture } = await readyWorkspace();
    manager.acquireForRun("ws_test", "run-1", () => Promise.resolve());
    const preparingDir = join(fixture.codeRoot, "workspaces", "ws_prep");
    mkdirSync(preparingDir, { recursive: true });
    writeFileSync(
      join(preparingDir, "workspace.json"),
      JSON.stringify({
        ...manager.get("ws_test"),
        id: "ws_prep",
        status: "preparing",
        baseSha: null,
        headSha: null,
        baseRef: "main",
        gitIdentity: { name: "Slab", email: "slab@example.test" },
      }),
    );

    const restarted = new WorkspaceManager({ root: fixture.codeRoot, allowFileRemotes: true });
    expect(restarted.get("ws_test").status).toBe("ready");
    expect(restarted.get("ws_prep")).toMatchObject({
      status: "failed",
      error: "Runner restarted while preparing the workspace",
      repoPath: join(preparingDir, "repo"),
    });
  });

  describe("security regressions", () => {
    const PUSH_TOKEN = "ghs_PushTokenThatMustStayPrivate0001";

    function publishInput(
      manager: WorkspaceManager,
      fixture: GitFixture,
      overrides: Record<string, unknown> = {},
    ) {
      return publishSchema.parse({
        ...target(manager.get("ws_test")),
        pushToken: PUSH_TOKEN,
        remoteUrl: fixture.remoteUrl,
        ...overrides,
      });
    }

    function remoteHasBranch(fixture: GitFixture, branch: string): boolean {
      try {
        gitSync(fixture.remotePath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
        return true;
      } catch {
        return false;
      }
    }

    function commitAll(repo: string, message: string) {
      gitSync(repo, "add", "-A");
      gitSync(repo, "commit", "--quiet", "-m", message);
    }

    function isAlive(pid: number): boolean {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
      } catch {
        return false;
      }
    }

    it("hands tokens to git only via a command-line credential helper", async () => {
      const { fixture } = setup();
      expect(existsSync(join(fixture.codeRoot, "bin", "git-askpass.sh"))).toBe(false);
      const env = gitEnv({ allowFileRemotes: false, token: PUSH_TOKEN });
      expect(env.GIT_ASKPASS).toBeUndefined();
      expect(env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
      });
      const filled = await git([...credentialArgs(), "credential", "fill"], {
        cwd: tmpdir(),
        env,
        input: "protocol=https\nhost=github.com\n\n",
      });
      expect(filled.stdout).toContain("username=x-access-token\n");
      expect(filled.stdout).toContain(`password=${PUSH_TOKEN}\n`);
      // Without a token in the environment the helper yields nothing usable.
      const empty = await git([...credentialArgs(), "credential", "fill"], {
        cwd: tmpdir(),
        env: gitEnv({ allowFileRemotes: false }),
        input: "protocol=https\nhost=github.com\n\n",
        okExitCodes: [0, 128],
      });
      expect(empty.stdout).not.toContain(PUSH_TOKEN);
    });

    it("pushes from a clean repository even if .git/commondir redirects the gitdir", async () => {
      const { manager, workspace, fixture } = await readyWorkspace();
      const repo = workspace.repoPath;
      const attacker = join(fixture.directory, "attacker.git");
      gitSync(fixture.directory, "init", "--bare", "--quiet", attacker);
      const evil = join(fixture.directory, "evilgit");
      cpSync(join(repo, ".git"), evil, { recursive: true });
      const envDump = join(fixture.directory, "filter-env");
      writeFileSync(
        join(evil, "config"),
        `${readFileSync(join(evil, "config"), "utf8")}[url "file://${attacker}"]\n\tinsteadOf = ${fixture.remoteUrl}\n[filter "x"]\n\tclean = "sh -c 'env > ${envDump}; cat'"\n`,
      );
      writeFileSync(join(repo, ".git", "commondir"), `${evil}\n`);
      writeFileSync(join(repo, ".gitattributes"), "*.txt filter=x\n");
      writeFileSync(join(repo, "new.txt"), "hi\n");

      const result = await manager.publish("ws_test", publishInput(manager, fixture));

      expect(gitSync(attacker, "for-each-ref").trim()).toBe("");
      expect(gitSync(fixture.remotePath, "rev-parse", "refs/heads/slab/cc-42-1").trim()).toBe(
        result.headSha,
      );
      // Agent-controlled config ran during the workspace commit, but never
      // with the token in its environment.
      const dumped = readFileSync(envDump, "utf8");
      expect(dumped).not.toContain(PUSH_TOKEN);
      expect(dumped).not.toContain("SLAB_GIT_TOKEN");
    });

    it("rejects a forbidden path hidden behind git replace", async () => {
      const { manager, workspace, fixture } = await readyWorkspace();
      const repo = workspace.repoPath;
      const baseSha = workspace.baseSha ?? "";
      mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
      writeFileSync(join(repo, ".github", "workflows", "x.yml"), "on: push\n");
      commitAll(repo, "wf");
      const head = gitSync(repo, "rev-parse", "HEAD").trim();
      const fake = gitSync(repo, "commit-tree", `${baseSha}^{tree}`, "-p", baseSha, "-m", "fake").trim();
      gitSync(repo, "replace", head, fake);
      gitSync(repo, "rm", "-rq", "--cached", ".github");
      rmSync(join(repo, ".github"), { recursive: true });

      await expect(manager.publish("ws_test", publishInput(manager, fixture))).rejects.toMatchObject({
        code: "PUBLISH_POLICY_VIOLATION",
        httpStatus: 422,
        details: [".github/workflows/x.yml"],
      });
      expect(remoteHasBranch(fixture, "slab/cc-42-1")).toBe(false);
    });

    it("checks every commit, not only the end-to-end diff", async () => {
      const { manager, workspace, fixture } = await readyWorkspace();
      const repo = workspace.repoPath;
      mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
      writeFileSync(join(repo, ".github", "workflows", "x.yml"), "on: push\n");
      commitAll(repo, "add wf");
      rmSync(join(repo, ".github"), { recursive: true });
      commitAll(repo, "rm wf");

      await expect(manager.publish("ws_test", publishInput(manager, fixture))).rejects.toMatchObject({
        code: "PUBLISH_POLICY_VIOLATION",
        details: [".github/workflows/x.yml"],
      });
      expect(remoteHasBranch(fixture, "slab/cc-42-1")).toBe(false);
    });

    it("forbids .gitmodules by default", async () => {
      const { manager, workspace, fixture } = await readyWorkspace();
      writeFileSync(
        join(workspace.repoPath, ".gitmodules"),
        '[submodule "x"]\n\tpath = x\n\turl = https://github.com/o/x.git\n',
      );
      await expect(manager.publish("ws_test", publishInput(manager, fixture))).rejects.toMatchObject({
        code: "PUBLISH_POLICY_VIOLATION",
        details: [".gitmodules"],
      });
    });

    it("requires branch and baseSha and refuses a mismatch", async () => {
      const { manager, workspace, fixture } = await readyWorkspace();
      writeFileSync(join(workspace.repoPath, "evil.txt"), "x\n");
      const base = { pushToken: PUSH_TOKEN, remoteUrl: fixture.remoteUrl };
      expect(() => publishSchema.parse(base)).toThrow();
      expect(() =>
        publishSchema.parse({ ...base, ...target(workspace), branch: "main" }),
      ).toThrow();
      expect(() =>
        publishSchema.parse({ ...base, ...target(workspace), baseSha: "HEAD" }),
      ).toThrow();
      for (const overrides of [
        { branch: "slab/other" },
        { baseSha: "0".repeat(40) },
      ]) {
        await expect(
          manager.publish("ws_test", publishInput(manager, fixture, overrides)),
        ).rejects.toMatchObject({ code: "WORKSPACE_STATE_MISMATCH", httpStatus: 409 });
      }
      expect(remoteHasBranch(fixture, "slab/other")).toBe(false);
      expect(manager.get("ws_test").status).toBe("ready");
    });

    it("does not trust a tampered workspace.json after a restart", async () => {
      const { manager, workspace, fixture } = await readyWorkspace();
      const expected = target(workspace);
      writeFileSync(join(workspace.repoPath, "evil.txt"), "x\n");
      const file = join(fixture.codeRoot, "workspaces", "ws_test", "workspace.json");
      const original = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      void manager;

      // A record that fails create-time validation is not loaded at all.
      writeFileSync(file, JSON.stringify({ ...original, branch: "main" }));
      let restarted = new WorkspaceManager({ root: fixture.codeRoot, allowFileRemotes: true });
      expectRunnerError(() => restarted.get("ws_test"), "WORKSPACE_NOT_FOUND");

      // A valid-looking but different branch is caught by the request check.
      writeFileSync(file, JSON.stringify({ ...original, branch: "slab/other" }));
      restarted = new WorkspaceManager({ root: fixture.codeRoot, allowFileRemotes: true });
      await expect(
        restarted.publish(
          "ws_test",
          publishSchema.parse({ ...expected, pushToken: PUSH_TOKEN, remoteUrl: fixture.remoteUrl }),
        ),
      ).rejects.toMatchObject({ code: "WORKSPACE_STATE_MISMATCH" });
      expect(gitSync(fixture.remotePath, "for-each-ref", "--format=%(refname)").trim()).toBe(
        "refs/heads/main",
      );
      expect(gitSync(fixture.remotePath, "ls-tree", "--name-only", "main")).not.toContain("evil.txt");
    });

    it("never reads through a symlinked handoff directory or a hardlink", async () => {
      const { manager, workspace, fixture } = await readyWorkspace();
      const secretDir = join(fixture.directory, "codexhome");
      mkdirSync(secretDir);
      const secret = join(secretDir, "auth.json");
      writeFileSync(secret, '{"secret":1}');

      // Hardlink and symlink inside the real handoff directory.
      manager.writeHandoff("ws_test", "ok.md", "fine");
      linkSync(secret, join(workspace.handoffPath, "notes.md"));
      symlinkSync(secret, join(workspace.handoffPath, "link.md"));
      expect(manager.listHandoff("ws_test").map(({ name }) => name)).toEqual(["ok.md"]);
      expectRunnerError(() => manager.readHandoff("ws_test", "notes.md"), "HANDOFF_NOT_FOUND");
      expectRunnerError(() => manager.readHandoff("ws_test", "link.md"), "HANDOFF_NOT_FOUND");
      // Writing replaces the link instead of writing through it.
      manager.writeHandoff("ws_test", "notes.md", "replaced");
      expect(readFileSync(secret, "utf8")).toBe('{"secret":1}');
      expect(manager.readHandoff("ws_test", "notes.md").content).toBe("replaced");

      // The handoff directory itself replaced by a symlink.
      rmSync(workspace.handoffPath, { recursive: true });
      symlinkSync(secretDir, workspace.handoffPath);
      expect(manager.listHandoff("ws_test")).toEqual([]);
      expectRunnerError(() => manager.readHandoff("ws_test", "auth.json"), "HANDOFF_NOT_FOUND");
      expectRunnerError(
        () => manager.writeHandoff("ws_test", "planted.md", "x"),
        "WORKSPACE_STATE_MISMATCH",
      );
      expect(existsSync(join(secretDir, "planted.md"))).toBe(false);
    });

    it("refuses to recreate a workspace while it is being deleted", async () => {
      const { manager, fixture } = await readyWorkspace();
      const deletion = manager.delete("ws_test");
      expectRunnerError(() => manager.create(createInput(fixture)), "WORKSPACE_BUSY");
      // A concurrent delete joins the same tombstone.
      await expect(manager.delete("ws_test")).resolves.toEqual({ id: "ws_test", deleted: true });
      await deletion;
      expect(manager.create(createInput(fixture)).created).toBe(true);
      expect((await manager.settled("ws_test")).status).toBe("ready");
    });

    it.runIf(process.platform === "linux")(
      "kills processes left in the workspace when a run ends",
      async () => {
        const { manager, workspace } = await readyWorkspace();
        const lease = manager.acquireForRun("ws_test", "run-1", () => Promise.resolve());
        // A background process whose parent (sh) exits, as an agent would leave it.
        const pid = Number.parseInt(
          execFileSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], {
            cwd: workspace.repoPath,
            encoding: "utf8",
          }).trim(),
          10,
        );
        expect(isAlive(pid)).toBe(true);
        lease.release();
        await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 3_000 });
        expect(manager.get("ws_test").status).toBe("ready");
      },
    );

    it("finishes setup on exit even if a background child holds its output", async () => {
      const started = Date.now();
      const { workspace } = await readyWorkspace({
        setupCommand: "sleep 30 & echo started",
        setupTimeoutSeconds: 20,
      });
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(workspace.setup).toMatchObject({ status: "passed", exitCode: 0 });
      expect(workspace.setup.logTail).toContain("started");
    });
  });
});
