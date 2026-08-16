import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const loopbackHosts = ["127.0.0.1", "::1", "localhost"] as const;

const envSchema = z.object({
  RUNNER_HOST: z.enum(loopbackHosts).default("127.0.0.1"),
  RUNNER_PORT: z.coerce.number().int().min(1).max(65_535).default(6990),
  CODEX_BIN: z.string().trim().min(1).default("codex"),
  RUNNER_TOKEN: z.string().min(16).optional(),
});

export interface RunnerConfig {
  host: (typeof loopbackHosts)[number];
  port: number;
  codexBin: string;
  runnerToken?: string;
  safeCwd: string;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RunnerConfig {
  const parsed = envSchema.parse(environment);
  const safeCwd = join(tmpdir(), "slab-runner-workspace");
  mkdirSync(safeCwd, { recursive: true, mode: 0o700 });
  return {
    host: parsed.RUNNER_HOST,
    port: parsed.RUNNER_PORT,
    codexBin: parsed.CODEX_BIN,
    ...(parsed.RUNNER_TOKEN ? { runnerToken: parsed.RUNNER_TOKEN } : {}),
    safeCwd,
  };
}
