import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Logger } from "../lib/logger.js";
import type { Redactor } from "../lib/redactor.js";
import { RunnerError } from "../runtime/errors.js";
import { WORKSPACE_ID_PATTERN } from "../runtime/protocol.js";
import type {
  RunWorkspaceLease,
  RunWorkspaceProvider,
} from "../runtime/run-manager.js";
import {
  childBaseEnv,
  credentialArgs,
  git,
  gitEnv,
  GitCommandError,
  isAllowedRemoteUrl,
  sanitizeGitOutput,
} from "./git.js";
import { killProcessesIn } from "./processes.js";
import {
  DIFF_PATCH_MAX_BYTES,
  HANDOFF_MAX_BYTES,
  HANDOFF_NAME_PATTERN,
  SETUP_LOG_TAIL_CHARS,
  storedWorkspaceSchema,
  type CreateWorkspaceInput,
  type DiffFile,
  type HandoffEntry,
  type PublishInput,
  type PublishResult,
  type StoredWorkspace,
  type Workspace,
  type WorkspaceDiff,
} from "./types.js";

type LockHolder =
  | { kind: "run"; runId: string; cancel: () => Promise<unknown> }
  | { kind: "publish" };

interface WorkspaceEntry {
  record: StoredWorkspace;
  holder: LockHolder | null;
  released: Promise<void> | null;
  prepareAbort: AbortController | null;
  preparing: Promise<void> | null;
  deleted: boolean;
}

export interface WorkspaceManagerOptions {
  root: string;
  allowFileRemotes?: boolean;
  redactor?: Redactor;
  logger?: Logger;
  /** How long DELETE waits for an active run/publish/preparation to stop. */
  deleteGraceMs?: number;
  cloneTimeoutMs?: number;
  pushTimeoutMs?: number;
}

interface GitRunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

const GIT_TIMEOUT_MS = 120_000;
/** After setup exits, how long to wait for its output pipes to drain. */
const SETUP_DRAIN_MS = 1_000;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

function now(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function notFound(): RunnerError {
  return new RunnerError("WORKSPACE_NOT_FOUND", "Workspace was not found", 404);
}

export class WorkspaceManager implements RunWorkspaceProvider {
  readonly root: string;
  readonly #workspacesDir: string;
  readonly #tmpDir: string;
  readonly #entries = new Map<string, WorkspaceEntry>();
  /** Tombstones: ids whose directory is still being removed. */
  readonly #deleting = new Map<string, Promise<void>>();
  readonly #secretUses = new Map<string, number>();
  readonly #allowFileRemotes: boolean;
  readonly #redactor: Redactor | undefined;
  readonly #logger: Logger | undefined;
  readonly #deleteGraceMs: number;
  readonly #cloneTimeoutMs: number;
  readonly #pushTimeoutMs: number;

  constructor(options: WorkspaceManagerOptions) {
    if (!isAbsolute(options.root)) {
      throw new Error("Workspace root must be an absolute path.");
    }
    this.root = resolve(options.root);
    this.#workspacesDir = join(this.root, "workspaces");
    this.#tmpDir = join(this.root, "tmp");
    this.#allowFileRemotes = options.allowFileRemotes ?? false;
    this.#redactor = options.redactor;
    this.#logger = options.logger;
    this.#deleteGraceMs = options.deleteGraceMs ?? 15_000;
    this.#cloneTimeoutMs = options.cloneTimeoutMs ?? 15 * 60_000;
    this.#pushTimeoutMs = options.pushTimeoutMs ?? 5 * 60_000;
    mkdirSync(this.#workspacesDir, { recursive: true, mode: 0o700 });
    rmSync(this.#tmpDir, { recursive: true, force: true });
    mkdirSync(this.#tmpDir, { recursive: true, mode: 0o700 });
    this.#recover();
  }

  // ---------------------------------------------------------------- lifecycle

  #recover(): void {
    for (const dirent of readdirSync(this.#workspacesDir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || !WORKSPACE_ID_PATTERN.test(dirent.name)) continue;
      const file = join(this.#workspacesDir, dirent.name, "workspace.json");
      if (!existsSync(file)) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        this.#logger?.warn("workspace metadata unreadable", { workspaceId: dirent.name });
        continue;
      }
      // workspace.json is agent-writable: re-apply the create-time validation
      // and drop records that fail it (DELETE still removes the directory and a
      // new POST /workspaces recreates it).
      const parsed = storedWorkspaceSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.id !== dirent.name ||
        !isAllowedRemoteUrl(parsed.data.repository.cloneUrl, this.#allowFileRemotes)
      ) {
        this.#logger?.warn("workspace metadata failed validation; not loaded", {
          workspaceId: dirent.name,
        });
        continue;
      }
      const record: StoredWorkspace = parsed.data;
      record.repoPath = this.#repoPath(record.id);
      record.handoffPath = this.#handoffPath(record.id);
      const entry: WorkspaceEntry = {
        record,
        holder: null,
        released: null,
        prepareAbort: null,
        preparing: null,
        deleted: false,
      };
      this.#entries.set(record.id, entry);
      if (record.status === "preparing") {
        if (record.baseSha) {
          // The checkout finished; only setup was interrupted.
          record.status = "ready";
          record.setup = {
            status: "failed",
            exitCode: null,
            logTail: this.#tail(
              `${record.setup.logTail}\n[runner restarted during setup]`,
            ),
          };
        } else {
          record.status = "failed";
          record.error = "Runner restarted while preparing the workspace";
        }
        record.updatedAt = now();
        this.#persist(entry);
      } else if (record.status === "busy") {
        record.status = "ready";
        record.updatedAt = now();
        this.#persist(entry);
        this.#logger?.warn("workspace lock released after runner restart", {
          workspaceId: record.id,
        });
      }
    }
  }

  create(input: CreateWorkspaceInput): { workspace: Workspace; created: boolean } {
    const existing = this.#entries.get(input.workspaceId);
    if (this.#deleting.has(input.workspaceId) || existing?.deleted) {
      throw new RunnerError(
        "WORKSPACE_BUSY",
        "Workspace is being deleted; retry once the deletion finished",
        409,
      );
    }
    if (existing) return { workspace: this.#view(existing), created: false };
    if (!isAllowedRemoteUrl(input.repository.cloneUrl, this.#allowFileRemotes)) {
      throw new RunnerError(
        "INVALID_REQUEST",
        this.#allowFileRemotes
          ? "cloneUrl must be https://github.com/<owner>/<repo>(.git) or file:///"
          : "cloneUrl must be https://github.com/<owner>/<repo>(.git)",
        400,
      );
    }
    const id = input.workspaceId;
    const directory = this.#workspaceDir(id);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(this.#handoffPath(id), { recursive: true, mode: 0o700 });
    const timestamp = now();
    const record: StoredWorkspace = {
      id,
      status: "preparing",
      repository: {
        cloneUrl: input.repository.cloneUrl,
        defaultBranch: input.repository.defaultBranch,
      },
      branch: input.branch,
      baseSha: null,
      headSha: null,
      repoPath: this.#repoPath(id),
      handoffPath: this.#handoffPath(id),
      setup: {
        status: input.setupCommand ? "running" : "skipped",
        exitCode: null,
        logTail: "",
      },
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      baseRef: input.baseRef ?? input.repository.defaultBranch,
      gitIdentity: input.gitIdentity,
    };
    const entry: WorkspaceEntry = {
      record,
      holder: null,
      released: null,
      prepareAbort: new AbortController(),
      preparing: null,
      deleted: false,
    };
    this.#entries.set(id, entry);
    this.#persist(entry);
    entry.preparing = this.#prepare(entry, input).finally(() => {
      entry.preparing = null;
      entry.prepareAbort = null;
    });
    return { workspace: this.#view(entry), created: true };
  }

  /** Resolves once preparation (clone + setup) has finished. */
  async settled(id: string): Promise<Workspace> {
    const entry = this.#require(id);
    await entry.preparing;
    return this.#view(entry);
  }

  list(): Workspace[] {
    return [...this.#entries.values()]
      .filter((entry) => !entry.deleted)
      .map((entry) => this.#view(entry))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Workspace {
    return this.#view(this.#require(id));
  }

  async delete(id: string): Promise<{ id: string; deleted: true }> {
    if (!WORKSPACE_ID_PATTERN.test(id)) return { id, deleted: true };
    let deletion = this.#deleting.get(id);
    if (!deletion) {
      // The tombstone stays until the directory is gone, so a concurrent
      // create for the same id cannot interleave with the removal.
      const work = this.#deleteNow(id);
      deletion = work;
      this.#deleting.set(id, work);
      void work
        .finally(() => {
          if (this.#deleting.get(id) === work) this.#deleting.delete(id);
        })
        .catch(() => undefined);
    }
    await deletion;
    return { id, deleted: true };
  }

  async #deleteNow(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (entry) {
      entry.deleted = true;
      entry.prepareAbort?.abort();
      const holder = entry.holder;
      if (holder?.kind === "run") {
        await holder.cancel().catch(() => undefined);
      }
      const waits: Promise<unknown>[] = [];
      if (entry.released) waits.push(entry.released);
      if (entry.preparing) waits.push(entry.preparing.catch(() => undefined));
      if (waits.length) {
        await Promise.race([Promise.all(waits), delay(this.#deleteGraceMs)]);
      }
    }
    killProcessesIn(this.#workspaceDir(id));
    try {
      await rm(this.#workspaceDir(id), { recursive: true, force: true });
    } finally {
      if (entry && this.#entries.get(id) === entry) this.#entries.delete(id);
    }
  }

  // -------------------------------------------------------------------- lock

  acquireForRun(
    workspaceId: string,
    runId: string,
    cancel: () => Promise<unknown>,
  ): RunWorkspaceLease {
    const entry = this.#require(workspaceId);
    const releaseLock = this.#acquire(entry, { kind: "run", runId, cancel });
    const directory = this.#workspaceDir(entry.record.id);
    return {
      workspace: {
        id: entry.record.id,
        repoPath: entry.record.repoPath,
        handoffPath: entry.record.handoffPath,
        branch: entry.record.branch,
      },
      // Called on the run's terminal state: stop anything the agent left
      // running in the workspace before another run or a publish may start.
      release: () => {
        try {
          killProcessesIn(directory);
        } finally {
          releaseLock();
        }
      },
    };
  }

  #acquire(entry: WorkspaceEntry, holder: LockHolder): () => void {
    if (entry.record.status === "busy" || entry.holder) {
      throw new RunnerError(
        "WORKSPACE_BUSY",
        "Workspace is in use by another run or publish",
        409,
      );
    }
    if (entry.record.status !== "ready" || entry.deleted) {
      throw new RunnerError("WORKSPACE_NOT_READY", "Workspace is not ready", 409);
    }
    let resolveReleased!: () => void;
    entry.released = new Promise((resolve) => (resolveReleased = resolve));
    entry.holder = holder;
    entry.record.status = "busy";
    entry.record.updatedAt = now();
    this.#persist(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.holder = null;
      entry.released = null;
      if (!entry.deleted) {
        entry.record.status = "ready";
        entry.record.updatedAt = now();
        this.#persist(entry);
        void this.#refreshHead(entry);
      }
      resolveReleased();
    };
  }

  async #refreshHead(entry: WorkspaceEntry): Promise<void> {
    try {
      const head = await this.#revParse(entry, "HEAD");
      if (entry.deleted || head === entry.record.headSha) return;
      entry.record.headSha = head;
      entry.record.updatedAt = now();
      this.#persist(entry);
    } catch {
      // A broken checkout keeps the last known head.
    }
  }

  // ----------------------------------------------------------------- handoff

  listHandoff(id: string): HandoffEntry[] {
    const entry = this.#require(id);
    const directory = this.#openHandoffDir(entry);
    if (directory === null) return [];
    try {
      const result: HandoffEntry[] = [];
      for (const name of readdirSync(directory.path)) {
        if (!HANDOFF_NAME_PATTERN.test(name)) continue;
        const file = this.#openHandoffFile(directory.path, name);
        if (!file) continue; // symlinks, hardlinks, directories, devices, ...
        closeSync(file.fd);
        result.push({ name, size: file.stats.size, updatedAt: file.stats.mtime.toISOString() });
      }
      return result.sort((a, b) => a.name.localeCompare(b.name));
    } finally {
      closeSync(directory.fd);
    }
  }

  readHandoff(
    id: string,
    name: string,
  ): { name: string; content: string; updatedAt: string } {
    const entry = this.#require(id);
    this.#assertHandoffName(name);
    const directory = this.#openHandoffDir(entry);
    if (directory === null) throw this.#handoffNotFound();
    try {
      const file = this.#openHandoffFile(directory.path, name);
      if (!file) throw this.#handoffNotFound();
      try {
        const tooLarge = new RunnerError(
          "INVALID_REQUEST",
          "Handoff file exceeds the 2 MB limit",
          413,
        );
        if (file.stats.size > HANDOFF_MAX_BYTES) throw tooLarge;
        // Read from the verified descriptor, never by path again; bounded in
        // case the file grows after fstat.
        const buffer = Buffer.alloc(HANDOFF_MAX_BYTES + 1);
        let length = 0;
        for (;;) {
          const read = readSync(file.fd, buffer, length, buffer.length - length, null);
          if (read === 0) break;
          length += read;
          if (length > HANDOFF_MAX_BYTES) throw tooLarge;
        }
        return {
          name,
          content: buffer.subarray(0, length).toString("utf8"),
          updatedAt: file.stats.mtime.toISOString(),
        };
      } finally {
        closeSync(file.fd);
      }
    } finally {
      closeSync(directory.fd);
    }
  }

  writeHandoff(id: string, name: string, content: string): HandoffEntry {
    const entry = this.#require(id);
    this.#assertHandoffName(name);
    const size = Buffer.byteLength(content, "utf8");
    if (size > HANDOFF_MAX_BYTES) {
      throw new RunnerError(
        "INVALID_REQUEST",
        "Handoff content exceeds the 2 MB limit",
        413,
      );
    }
    let directory = this.#openHandoffDir(entry);
    if (directory === null && this.#lstat(entry.record.handoffPath) === null) {
      // Missing (e.g. removed by the agent): recreate it, without following
      // symlinks in the final component.
      try {
        mkdirSync(entry.record.handoffPath, { mode: 0o700 });
      } catch {
        // Fall through to the check below.
      }
      directory = this.#openHandoffDir(entry);
    }
    if (directory === null) {
      throw new RunnerError(
        "WORKSPACE_STATE_MISMATCH",
        "The handoff directory is not a regular directory",
        409,
      );
    }
    try {
      // Write a private temporary file inside the verified directory, then
      // rename it over the destination (rename replaces a symlink or hardlink
      // instead of writing through it). Dot-names are never listed.
      const temporary = join(directory.path, `.tmp-${randomBytes(8).toString("hex")}`);
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
        0o644,
      );
      try {
        const data = Buffer.from(content, "utf8");
        let offset = 0;
        while (offset < data.length) offset += writeSync(fd, data, offset);
      } catch (error) {
        closeSync(fd);
        unlinkSync(temporary);
        throw error;
      }
      closeSync(fd);
      const destination = join(directory.path, name);
      renameSync(temporary, destination);
      const stats = lstatSync(destination);
      return { name, size: stats.size, updatedAt: stats.mtime.toISOString() };
    } finally {
      closeSync(directory.fd);
    }
  }

  #lstat(path: string): Stats | null {
    try {
      return lstatSync(path);
    } catch {
      return null;
    }
  }

  /**
   * Open the handoff directory without following symlinks (neither the
   * workspace directory nor the handoff directory may be one). On Linux the
   * returned path goes through `/proc/self/fd`, so later lookups resolve
   * relative to the verified directory even if the path is swapped meanwhile.
   */
  #openHandoffDir(entry: WorkspaceEntry): { fd: number; path: string } | null {
    const path = entry.record.handoffPath;
    const workspaceStats = this.#lstat(this.#workspaceDir(entry.record.id));
    const handoffStats = this.#lstat(path);
    if (!workspaceStats?.isDirectory() || !handoffStats?.isDirectory()) return null;
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    } catch {
      return null;
    }
    try {
      const stats = fstatSync(fd);
      if (
        !stats.isDirectory() ||
        stats.ino !== handoffStats.ino ||
        stats.dev !== handoffStats.dev
      ) {
        closeSync(fd);
        return null;
      }
    } catch {
      closeSync(fd);
      return null;
    }
    const viaFd = `/proc/self/fd/${fd}`;
    return { fd, path: existsSync(viaFd) ? viaFd : path };
  }

  /** Opens a handoff file only if it is a regular, singly-linked file. */
  #openHandoffFile(directory: string, name: string): { fd: number; stats: Stats } | null {
    let fd: number;
    try {
      fd = openSync(
        join(directory, name),
        constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
      );
    } catch {
      return null;
    }
    try {
      const stats = fstatSync(fd);
      if (stats.isFile() && stats.nlink === 1) return { fd, stats };
    } catch {
      // fall through
    }
    closeSync(fd);
    return null;
  }

  #assertHandoffName(name: string): void {
    if (!HANDOFF_NAME_PATTERN.test(name)) {
      throw new RunnerError(
        "INVALID_REQUEST",
        "Handoff names must match ^[a-z0-9][a-z0-9._-]{0,80}$",
        400,
      );
    }
  }

  #handoffNotFound(): RunnerError {
    return new RunnerError("HANDOFF_NOT_FOUND", "Handoff file was not found", 404);
  }

  // -------------------------------------------------------------------- diff

  async diff(id: string): Promise<WorkspaceDiff> {
    const entry = this.#require(id);
    const status = entry.record.status;
    const baseSha = entry.record.baseSha;
    if ((status !== "ready" && status !== "busy") || !baseSha) {
      throw new RunnerError("WORKSPACE_NOT_READY", "Workspace is not ready", 409);
    }
    const repo = entry.record.repoPath;
    // Stop processes the agent left behind so they cannot race the diff; never
    // while a run holds the workspace (it is still working there).
    if (!entry.holder) killProcessesIn(this.#workspaceDir(id));
    const scratch = mkdtempSync(join(this.#tmpDir, "diff-"));
    try {
      // Stage the working tree into a private copy of the index so the
      // agent's own index is never touched.
      const indexPath = (
        await git(["rev-parse", "--path-format=absolute", "--git-path", "index"], this.#opts(repo))
      ).stdout.trim();
      const temporaryIndex = join(scratch, "index");
      if (existsSync(indexPath)) copyFileSync(indexPath, temporaryIndex);
      const options = this.#opts(repo, { GIT_INDEX_FILE: temporaryIndex });
      await git(["add", "-A"], options);
      const tree = (await git(["write-tree"], options)).stdout.trim();
      const headSha = await this.#revParse(entry, "HEAD");
      const headTree = await this.#revParse(entry, "HEAD^{tree}");
      const diffArgs = ["diff", "--cached", "-M", "--no-color", "--no-ext-diff", "--no-textconv"];
      const [nameStatus, numstat, patch, log] = await Promise.all([
        git([...diffArgs, "--name-status", "-z", baseSha], options),
        git([...diffArgs, "--numstat", "-z", baseSha], options),
        git([...diffArgs, baseSha], { ...options, maxStdoutBytes: DIFF_PATCH_MAX_BYTES }),
        git(["log", "--format=%H%x1f%s%x1e", `${baseSha}..HEAD`], options),
      ]);
      const files = mergeDiffFiles(parseNameStatus(nameStatus.stdout), parseNumstat(numstat.stdout));
      return {
        baseSha,
        headSha,
        files,
        insertions: files.reduce((sum, file) => sum + file.insertions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        uncommitted: tree !== headTree,
        commits: parseLog(log.stdout),
        patch: patch.stdout,
        truncated: patch.stdoutTruncated,
      };
    } catch (error) {
      throw this.#gitFailure(error, "Could not compute the workspace diff");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ----------------------------------------------------------------- publish

  async publish(id: string, input: PublishInput): Promise<PublishResult> {
    const entry = this.#require(id);
    if (!isAllowedRemoteUrl(input.remoteUrl, this.#allowFileRemotes)) {
      throw new RunnerError(
        "INVALID_REQUEST",
        "remoteUrl must be https://github.com/<owner>/<repo>(.git)",
        400,
      );
    }
    const release = this.#acquire(entry, { kind: "publish" });
    const record = entry.record;
    const repo = record.repoPath;
    let scratch: string | null = null;
    try {
      if (!record.baseSha) {
        throw new RunnerError("WORKSPACE_NOT_READY", "Workspace is not ready", 409);
      }
      // The caller's view of the workspace is authoritative; the record may
      // have been reloaded from agent-writable metadata.
      if (input.branch !== record.branch || input.baseSha !== record.baseSha) {
        throw new RunnerError(
          "WORKSPACE_STATE_MISMATCH",
          "branch and baseSha do not match the workspace",
          409,
        );
      }
      const { branch, baseSha } = input;
      killProcessesIn(this.#workspaceDir(id));

      // 1. Commit pending changes inside the workspace. No credential is in
      //    the environment and hooks are disabled; whatever the agent's repo
      //    config does here gains it nothing.
      const options = this.#opts(repo);
      try {
        await git(["add", "-A"], options);
        const staged = await git(["diff", "--cached", "--quiet", "--no-ext-diff"], {
          ...options,
          okExitCodes: [0, 1],
        });
        if (staged.exitCode === 1) {
          await git(
            [
              "-c",
              `user.name=${record.gitIdentity.name}`,
              "-c",
              `user.email=${record.gitIdentity.email}`,
              "commit",
              "--no-verify",
              "--quiet",
              "-m",
              input.commitMessage,
            ],
            options,
          );
        }
      } catch (error) {
        throw this.#gitFailure(error, "Could not commit workspace changes");
      }

      // 2. Copy the result into a fresh runner-created bare repository (local
      //    fetch, no credentials). Everything after this point only reads
      //    from that repository, never from the agent's gitdir.
      scratch = mkdtempSync(join(this.#tmpDir, "publish-"));
      const clean = join(scratch, "repo.git");
      const cleanOptions = this.#opts(scratch, { GIT_DIR: clean });
      await git(["init", "--bare", "--quiet", "--template=", clean], this.#opts(scratch));
      const fetchOptions = {
        ...cleanOptions,
        env: gitEnv({
          allowFileRemotes: this.#allowFileRemotes,
          allowProtocol: "file",
          extra: { GIT_DIR: clean },
        }),
      };
      const fetchArgs = ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", repo];
      try {
        await git([...fetchArgs, "+HEAD:refs/heads/publish"], fetchOptions);
      } catch (error) {
        throw this.#gitFailure(error, "Could not read the workspace commits");
      }
      try {
        await git([...fetchArgs, `+${baseSha}:refs/heads/base`], fetchOptions);
      } catch {
        throw new RunnerError(
          "WORKSPACE_STATE_MISMATCH",
          "baseSha is not present in the workspace repository",
          409,
        );
      }
      const headSha = (
        await git(["rev-parse", "--verify", "--quiet", "refs/heads/publish^{commit}"], cleanOptions)
      ).stdout.trim();

      // 3. Forbidden paths: every commit in baseSha..head (an intermediate
      //    commit is pushed even if a later one reverts it), plus the
      //    end-to-end difference.
      const violations = await this.#forbiddenChanges(
        cleanOptions,
        baseSha,
        headSha,
        input.forbiddenPaths,
      );
      if (violations.length > 0) {
        throw new RunnerError(
          "PUBLISH_POLICY_VIOLATION",
          "The changes touch paths that may not be published",
          422,
          { details: violations },
        );
      }

      // 4. Push exactly the verified commit to exactly refs/heads/<branch>.
      //    The clean repository's config is rewritten right before the push.
      const configFile = join(clean, "config");
      rmSync(configFile, { force: true });
      writeFileSync(
        configFile,
        "[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
        { flag: "wx", mode: 0o600 },
      );
      const token = input.pushToken;
      this.#useSecret(token);
      try {
        await git(
          [
            ...credentialArgs(),
            "push",
            "--force",
            "--no-verify",
            "--quiet",
            input.remoteUrl,
            `${headSha}:refs/heads/${branch}`,
          ],
          {
            cwd: scratch,
            env: gitEnv({
              allowFileRemotes: this.#allowFileRemotes,
              token,
              extra: { GIT_DIR: clean },
            }),
            timeoutMs: this.#pushTimeoutMs,
            secrets: [token],
          },
        );
      } catch (error) {
        const message =
          error instanceof GitCommandError
            ? sanitizeGitOutput(error.message, [token])
            : "git push failed";
        throw new RunnerError("GIT_PUSH_FAILED", this.#redact(message), 502);
      } finally {
        this.#releaseSecret(token);
      }
      const [count, numstat] = await Promise.all([
        git(["rev-list", "--count", `${baseSha}..${headSha}`], cleanOptions),
        git(["diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", baseSha, headSha], cleanOptions),
      ]);
      const stats = parseNumstat(numstat.stdout);
      record.headSha = headSha;
      return {
        branch,
        headSha,
        baseSha,
        commits: Number.parseInt(count.stdout.trim(), 10) || 0,
        insertions: stats.reduce((sum, file) => sum + file.insertions, 0),
        deletions: stats.reduce((sum, file) => sum + file.deletions, 0),
        files: stats.length,
      };
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      throw this.#gitFailure(error, "Could not publish the workspace");
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      release();
    }
  }

  async #forbiddenChanges(
    options: GitRunOptions,
    baseSha: string,
    headSha: string,
    forbiddenPaths: readonly string[],
  ): Promise<string[]> {
    const touched = new Set<string>();
    const collect = (result: { stdout: string; stdoutTruncated: boolean }) => {
      if (result.stdoutTruncated) {
        throw new RunnerError(
          "UNKNOWN_RUNTIME_ERROR",
          "The changes are too large to verify for publishing",
          500,
        );
      }
      for (const path of result.stdout.split("\0")) if (path) touched.add(path);
    };
    const commits = (await git(["rev-list", `${baseSha}..${headSha}`], options)).stdout
      .split("\n")
      .filter(Boolean);
    if (commits.length > 0) {
      // -m: merges are compared with every parent; --root: a root commit
      // lists its whole tree.
      collect(
        await git(
          ["diff-tree", "--stdin", "--no-commit-id", "--no-renames", "-r", "-m", "--root", "--name-only", "-z"],
          { ...options, input: `${commits.join("\n")}\n` },
        ),
      );
    }
    collect(
      await git(["diff-tree", "--no-renames", "-r", "--name-only", "-z", baseSha, headSha], options),
    );
    return [...touched]
      .filter((path) =>
        forbiddenPaths.some((prefix) => path.startsWith(prefix) || `${path}/` === prefix),
      )
      .sort();
  }

  async #configureIdentity(entry: WorkspaceEntry): Promise<void> {
    const options = this.#opts(entry.record.repoPath);
    await git(["config", "user.name", entry.record.gitIdentity.name], options);
    await git(["config", "user.email", entry.record.gitIdentity.email], options);
  }

  // ----------------------------------------------------------------- prepare

  async #prepare(entry: WorkspaceEntry, input: CreateWorkspaceInput): Promise<void> {
    const record = entry.record;
    const signal = entry.prepareAbort?.signal;
    const token = input.fetchToken ?? null;
    try {
      if (token) this.#useSecret(token);
      try {
        await git(
          [
            // The token reaches git only through the command-line credential
            // helper; nothing on disk is trusted with it.
            ...(token ? credentialArgs() : []),
            "clone",
            "--quiet",
            "--template=",
            "--single-branch",
            "--branch",
            record.baseRef,
            "--",
            record.repository.cloneUrl,
            record.repoPath,
          ],
          {
            cwd: this.#workspaceDir(record.id),
            env: gitEnv({ allowFileRemotes: this.#allowFileRemotes, token }),
            timeoutMs: this.#cloneTimeoutMs,
            secrets: [token],
            ...(signal ? { signal } : {}),
          },
        );
      } finally {
        if (token) this.#releaseSecret(token);
      }
      const options = { ...this.#opts(record.repoPath), ...(signal ? { signal } : {}) };
      const baseSha = await this.#revParse(entry, "HEAD");
      await git(["switch", "--quiet", "-c", record.branch], options);
      await git(["remote", "remove", "origin"], options);
      await this.#configureIdentity(entry);
      if (entry.deleted) return;
      record.baseSha = baseSha;
      record.headSha = baseSha;
      record.updatedAt = now();
      this.#persist(entry);
      if (input.setupCommand) {
        await this.#runSetup(entry, input.setupCommand, input.setupTimeoutSeconds, signal);
      }
      if (entry.deleted) return;
      record.status = "ready";
      record.updatedAt = now();
      this.#persist(entry);
      this.#logger?.info("workspace ready", {
        workspaceId: record.id,
        setup: record.setup.status,
      });
    } catch (error) {
      if (entry.deleted) return;
      const message =
        error instanceof GitCommandError || error instanceof Error
          ? error.message
          : "Workspace preparation failed";
      record.status = "failed";
      record.error = this.#redact(sanitizeGitOutput(message, [token]));
      record.updatedAt = now();
      this.#persist(entry);
      this.#logger?.warn("workspace preparation failed", { workspaceId: record.id });
    }
  }

  async #runSetup(
    entry: WorkspaceEntry,
    command: string,
    timeoutSeconds: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const record = entry.record;
    record.setup = { status: "running", exitCode: null, logTail: "" };
    record.updatedAt = now();
    this.#persist(entry);
    const workspaceDir = this.#workspaceDir(record.id);
    const result = await new Promise<{ exitCode: number | null; output: string; timedOut: boolean }>(
      (resolvePromise) => {
        let output = "";
        let timedOut = false;
        let settled = false;
        const child = spawn("sh", ["-c", command], {
          cwd: record.repoPath,
          env: childBaseEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        const append = (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.length > SETUP_LOG_TAIL_CHARS * 4) {
            output = output.slice(-SETUP_LOG_TAIL_CHARS * 2);
          }
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const killGroup = () => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          killGroup();
        }, timeoutSeconds * 1_000);
        timer.unref();
        signal?.addEventListener("abort", killGroup, { once: true });
        const finish = (exitCode: number | null, extra = "") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", killGroup);
          resolvePromise({ exitCode, output: output + extra, timedOut });
        };
        child.once("error", (error) => finish(null, `\n${error.message}`));
        // Resolve on process exit, not on pipe close: a background child that
        // inherited stdout must not turn a finished setup into a timeout.
        child.once("exit", (exitCode) => {
          clearTimeout(timer);
          // Kill whatever the setup left running (same process group, or any
          // process still working inside the workspace).
          killGroup();
          killProcessesIn(workspaceDir);
          if (child.stdout.readableEnded && child.stderr.readableEnded) {
            finish(exitCode);
            return;
          }
          const drain = setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            finish(exitCode);
          }, SETUP_DRAIN_MS);
          drain.unref();
          child.once("close", () => {
            clearTimeout(drain);
            finish(exitCode);
          });
        });
      },
    );
    const suffix = result.timedOut ? `\n[setup timed out after ${timeoutSeconds}s]` : "";
    record.setup = {
      status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
      exitCode: result.timedOut ? null : result.exitCode,
      logTail: this.#tail(this.#redact(result.output + suffix)),
    };
    record.updatedAt = now();
    this.#persist(entry);
  }

  // ----------------------------------------------------------------- helpers

  #opts(cwd: string, extra?: Record<string, string>): GitRunOptions {
    return {
      cwd,
      env: gitEnv({
        allowFileRemotes: this.#allowFileRemotes,
        ...(extra ? { extra } : {}),
      }),
      timeoutMs: GIT_TIMEOUT_MS,
    };
  }

  async #revParse(entry: WorkspaceEntry, ref: string): Promise<string> {
    return (
      await git(["rev-parse", "--verify", "--quiet", ref], this.#opts(entry.record.repoPath))
    ).stdout.trim();
  }

  #gitFailure(error: unknown, fallback: string): RunnerError {
    if (error instanceof RunnerError) return error;
    const message =
      error instanceof GitCommandError ? `${fallback}: ${error.message}` : fallback;
    return new RunnerError("UNKNOWN_RUNTIME_ERROR", this.#redact(sanitizeGitOutput(message)), 500);
  }

  #useSecret(secret: string): void {
    this.#secretUses.set(secret, (this.#secretUses.get(secret) ?? 0) + 1);
    this.#redactor?.add(secret);
  }

  #releaseSecret(secret: string): void {
    const uses = (this.#secretUses.get(secret) ?? 1) - 1;
    if (uses > 0) {
      this.#secretUses.set(secret, uses);
      return;
    }
    this.#secretUses.delete(secret);
    this.#redactor?.remove(secret);
  }

  #redact(text: string): string {
    return this.#redactor ? this.#redactor.text(text) : text;
  }

  #tail(text: string): string {
    return text.length > SETUP_LOG_TAIL_CHARS ? text.slice(-SETUP_LOG_TAIL_CHARS) : text;
  }

  #require(id: string): WorkspaceEntry {
    if (!WORKSPACE_ID_PATTERN.test(id)) throw notFound();
    const entry = this.#entries.get(id);
    if (!entry || entry.deleted) throw notFound();
    return entry;
  }

  #workspaceDir(id: string): string {
    return join(this.#workspacesDir, id);
  }

  #repoPath(id: string): string {
    return join(this.#workspaceDir(id), "repo");
  }

  #handoffPath(id: string): string {
    return join(this.#workspaceDir(id), "handoff");
  }

  #persist(entry: WorkspaceEntry): void {
    if (entry.deleted) return;
    const directory = this.#workspaceDir(entry.record.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, "workspace.json");
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(entry.record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  #view(entry: WorkspaceEntry): Workspace {
    const record = entry.record;
    return {
      id: record.id,
      status: record.status,
      repository: { ...record.repository },
      branch: record.branch,
      baseSha: record.baseSha,
      headSha: record.headSha,
      repoPath: record.repoPath,
      handoffPath: record.handoffPath,
      setup: { ...record.setup },
      error: record.error,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

// ------------------------------------------------------------------ parsing

function mapStatus(code: string): DiffFile["status"] {
  switch (code[0]) {
    case "A":
    case "C":
      return "A";
    case "D":
      return "D";
    case "R":
      return "R";
    default:
      return "M";
  }
}

export function parseNameStatus(output: string): Array<{ path: string; status: DiffFile["status"] }> {
  const tokens = output.split("\0");
  const files: Array<{ path: string; status: DiffFile["status"] }> = [];
  for (let index = 0; index < tokens.length; ) {
    const code = tokens[index++];
    if (!code) continue;
    if (code.startsWith("R") || code.startsWith("C")) {
      index++; // source path
      const path = tokens[index++];
      if (path) files.push({ path, status: mapStatus(code) });
    } else {
      const path = tokens[index++];
      if (path) files.push({ path, status: mapStatus(code) });
    }
  }
  return files;
}

export function parseNumstat(output: string): Array<{ path: string; insertions: number; deletions: number }> {
  const tokens = output.split("\0");
  const files: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index++];
    if (!token) continue;
    const [added = "-", removed = "-", inlinePath = ""] = token.split("\t");
    let path = inlinePath;
    if (!path) {
      index++; // rename source
      path = tokens[index++] ?? "";
    }
    if (!path) continue;
    files.push({
      path,
      insertions: added === "-" ? 0 : Number.parseInt(added, 10) || 0,
      deletions: removed === "-" ? 0 : Number.parseInt(removed, 10) || 0,
    });
  }
  return files;
}

function mergeDiffFiles(
  statuses: Array<{ path: string; status: DiffFile["status"] }>,
  numstat: Array<{ path: string; insertions: number; deletions: number }>,
): DiffFile[] {
  const counts = new Map(numstat.map((file) => [file.path, file]));
  return statuses.map(({ path, status }) => ({
    path,
    status,
    insertions: counts.get(path)?.insertions ?? 0,
    deletions: counts.get(path)?.deletions ?? 0,
  }));
}

function parseLog(output: string): Array<{ sha: string; subject: string }> {
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", subject = ""] = record.split("\x1f");
      return { sha, subject };
    });
}
