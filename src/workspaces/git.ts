import { spawn } from "node:child_process";

/** Name of the env var that carries a GitHub token to the credential helper. */
export const GIT_TOKEN_ENV = "SLAB_GIT_TOKEN";

/**
 * A credential helper defined entirely on the command line. It reads the token
 * from the git child's environment, so nothing on disk (where the agent could
 * plant or modify a script) is ever executed with a credential. Only `get`
 * requests are answered.
 */
const CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$${GIT_TOKEN_ENV}"; }; f`;

/** `-c` arguments that install the command-line credential helper. */
export function credentialArgs(): string[] {
  // The empty value first resets any helper list inherited from config.
  return ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`];
}

// Config overrides applied to every git invocation. The repository config is
// agent-writable, so never let it run hooks, fsmonitor commands or credential
// helpers inside a runner-owned git process.
const SAFE_CONFIG_ARGS = [
  "-c",
  "credential.helper=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.sshCommand=false",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
];

const INHERITED_ENV_DENYLIST = new Set([
  "RUNNER_TOKEN",
  GIT_TOKEN_ENV,
  "GIT_ASKPASS",
  "SSH_ASKPASS",
]);

/** Environment for runner-owned child processes, without runner secrets. */
export function childBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (INHERITED_ENV_DENYLIST.has(key)) continue;
    // GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_* etc. from the runner's own
    // environment must never leak into workspace commands.
    if (key.startsWith("GIT_")) continue;
    env[key] = value;
  }
  return env;
}

export interface GitEnvironmentOptions {
  allowFileRemotes: boolean;
  /** Exposed to the command-line credential helper (see `credentialArgs`). */
  token?: string | null;
  /** Overrides the default `GIT_ALLOW_PROTOCOL`. */
  allowProtocol?: string;
  extra?: Record<string, string>;
}

/**
 * Sanitized environment for every runner-owned git process: no inherited
 * `GIT_*` variables, no system/global config, no replace objects, no prompts.
 */
export function gitEnv(options: GitEnvironmentOptions): Record<string, string> {
  const env: Record<string, string> = {
    ...childBaseEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL:
      options.allowProtocol ?? (options.allowFileRemotes ? "https:file" : "https"),
    LC_ALL: "C",
    ...options.extra,
  };
  if (options.token) env[GIT_TOKEN_ENV] = options.token;
  return env;
}

/**
 * Remove anything that may carry a credential from git output: explicit
 * tokens, URL userinfo, and GitHub token shapes.
 */
export function sanitizeGitOutput(
  text: string,
  secrets: ReadonlyArray<string | null | undefined> = [],
): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/x-access-token:[^@\s]*@/gi, "[REDACTED]@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "[REDACTED]");
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /** Stop buffering stdout after this many bytes (the process keeps running). */
  maxStdoutBytes?: number;
  signal?: AbortSignal;
  /** Written to stdin (otherwise stdin is closed). */
  input?: string;
}

const MAX_STDERR_BYTES = 64 * 1024;

export function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    const maxStdout = options.maxStdoutBytes ?? 32 * 1024 * 1024;
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxStdout) {
        stdoutTruncated = true;
        return;
      }
      const remaining = maxStdout - stdoutBytes;
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        stdoutTruncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > MAX_STDERR_BYTES) {
        stderr = stderr.subarray(stderr.length - MAX_STDERR_BYTES);
      }
    });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;
    timer?.unref();
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutTruncated,
        timedOut,
      });
    });
  });
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly result: CommandResult,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export interface GitOptions extends RunCommandOptions {
  /** Exit codes treated as success (default `[0]`). */
  okExitCodes?: number[];
  secrets?: ReadonlyArray<string | null | undefined>;
}

export async function git(
  args: readonly string[],
  options: GitOptions,
): Promise<CommandResult> {
  const result = await runCommand("git", [...SAFE_CONFIG_ARGS, ...args], options);
  const ok = options.okExitCodes ?? [0];
  if (result.exitCode === null || !ok.includes(result.exitCode)) {
    const detail = sanitizeGitOutput(
      result.stderr.trim() || result.stdout.trim(),
      options.secrets,
    ).slice(-1_000);
    throw new GitCommandError(
      `git ${args[0] ?? ""} failed${result.timedOut ? " (timed out)" : ""}${detail ? `: ${detail}` : ""}`,
      result,
    );
  }
  return result;
}

const GITHUB_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}?(?:\.git)?$/;

export function isAllowedRemoteUrl(
  value: string,
  allowFileRemotes: boolean,
): boolean {
  if (GITHUB_URL.test(value)) {
    const repo = value.split("/")[4] ?? "";
    return repo !== "." && repo !== ".." && !repo.startsWith(".git");
  }
  if (allowFileRemotes && value.startsWith("file:///")) {
    return !/[\s]/.test(value) && !value.includes("/../");
  }
  return false;
}

/** Conservative subset of `git check-ref-format --branch` rules. */
export function isSafeRefName(value: string): boolean {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(value)) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/"))
    return false;
  if (value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("//")) return false;
  return value
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}
