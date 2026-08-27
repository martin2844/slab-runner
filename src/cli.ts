#!/usr/bin/env node

import { createServer, type Server } from "node:http";
import { CodexAdapter } from "./adapters/codex-adapter.js";
import { ClaudeAdapter } from "./adapters/claude-adapter.js";
import { DirectApiAdapter } from "./adapters/direct-api-adapter.js";
import { GeminiAdapter } from "./adapters/gemini-adapter.js";
import { OpenRouterAdapter } from "./adapters/openrouter-adapter.js";
import { CodexAuthManager } from "./auth/codex-auth-manager.js";
import { prepareIsolatedCodexHome } from "./app-server/codex-home.js";
import { ProcessAppServerConnection } from "./app-server/process-connection.js";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./http/app.js";
import { JsonLogger } from "./lib/logger.js";
import { Redactor } from "./lib/redactor.js";
import { RuntimeActivityGate } from "./runtime/activity-gate.js";
import { RunManager } from "./runtime/run-manager.js";

async function listen(
  server: Server,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  if (command !== "start") {
    process.stderr.write("Usage: slab-runner start\n");
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const redactor = new Redactor();
  redactor.add(config.runnerToken);
  const logger = new JsonLogger(redactor);
  prepareIsolatedCodexHome({
    codexHome: config.codexHome,
    authSourceFile: config.codexAuthSourceFile,
  });
  const connection = new ProcessAppServerConnection(
    config.codexBin,
    logger,
    config.codexHome,
  );
  const adapters = [
    new CodexAdapter(connection, config.safeCwd),
    new ClaudeAdapter(config.safeCwd),
    new DirectApiAdapter(),
    new GeminiAdapter(config.safeCwd, config.geminiHome, config.geminiBin),
    new OpenRouterAdapter(),
  ];
  for (const adapter of adapters) {
    try {
      await adapter.start();
    } catch {
      logger.warn("runtime unavailable at startup", {
        runtime: adapter.definition.id,
      });
    }
  }
  const codexActivityGate = new RuntimeActivityGate();
  const runManager = new RunManager(
    new Map(adapters.map((adapter) => [adapter.definition.id, adapter])),
    logger,
    undefined,
    config.runJournalFile,
    undefined,
    new Map([["codex", codexActivityGate]]),
  );
  const codexAuth = new CodexAuthManager(connection, codexActivityGate);
  const app = createHttpApp({
    runManager,
    codexAuth,
    ...(config.runnerToken ? { runnerToken: config.runnerToken } : {}),
  });
  const server = createServer(app);
  await listen(server, config.port, config.host);
  logger.info("runner startup", { host: config.host, port: config.port });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled(adapters.map((adapter) => adapter.shutdown()));
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main().catch((error: unknown) => {
  void error;
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "Runner startup failed",
    })}\n`,
  );
  process.exitCode = 1;
});
