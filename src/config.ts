import { mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const runnerHosts = ["127.0.0.1", "::1", "localhost", "0.0.0.0"] as const;
const loopbackHosts = new Set<string>(["127.0.0.1", "::1", "localhost"]);

const envSchema = z.object({
  RUNNER_HOST: z.enum(runnerHosts).default("127.0.0.1"),
  RUNNER_PORT: z.coerce.number().int().min(1).max(65_535).default(6990),
  CODEX_BIN: z.string().trim().min(1).default("codex"),
  RUNNER_CODEX_HOME: z.string().trim().min(1).optional(),
  RUNNER_TOKEN: z.string().min(16).optional(),
  RUNNER_TOKEN_FILE: z.string().trim().min(1).optional(),
}).superRefine((value, context) => {
  if (value.RUNNER_TOKEN && value.RUNNER_TOKEN_FILE) {
    context.addIssue({
      code: "custom",
      path: ["RUNNER_TOKEN_FILE"],
      message: "Configure only one of RUNNER_TOKEN or RUNNER_TOKEN_FILE.",
    });
  }
});

export interface RunnerConfig {
  host: (typeof runnerHosts)[number];
  port: number;
  codexBin: string;
  codexHome: string;
  codexAuthSourceFile: string;
  runnerToken?: string;
  safeCwd: string;
}

function readRunnerToken(filename: string): string {
  const token = readFileSync(resolve(filename), "utf8").replace(/\r?\n$/, "");
  if (token.length < 16) {
    throw new Error("RUNNER_TOKEN_FILE must contain at least 16 characters.");
  }
  return token;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RunnerConfig {
  const parsed = envSchema.parse(environment);
  const runnerToken = parsed.RUNNER_TOKEN_FILE
    ? readRunnerToken(parsed.RUNNER_TOKEN_FILE)
    : parsed.RUNNER_TOKEN;
  if (!loopbackHosts.has(parsed.RUNNER_HOST) && !runnerToken) {
    throw new Error(
      "A non-loopback RUNNER_HOST requires RUNNER_TOKEN or RUNNER_TOKEN_FILE.",
    );
  }
  const safeCwd = join(tmpdir(), "slab-runner-workspace");
  const primaryCodexHome = environment.CODEX_HOME?.trim()
    ? resolve(environment.CODEX_HOME)
    : join(homedir(), ".codex");
  const codexHome = parsed.RUNNER_CODEX_HOME
    ? resolve(parsed.RUNNER_CODEX_HOME)
    : join(homedir(), ".local", "state", "slab-runner", "codex");
  mkdirSync(safeCwd, { recursive: true, mode: 0o700 });
  return {
    host: parsed.RUNNER_HOST,
    port: parsed.RUNNER_PORT,
    codexBin: parsed.CODEX_BIN,
    codexHome,
    codexAuthSourceFile: join(primaryCodexHome, "auth.json"),
    ...(runnerToken ? { runnerToken } : {}),
    safeCwd,
  };
}
