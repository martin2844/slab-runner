#!/usr/bin/env node

import { createServer, type Server } from "node:http";
import { CodexAdapter } from "./adapters/codex-adapter.js";
import { ProcessAppServerConnection } from "./app-server/process-connection.js";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./http/app.js";
import { JsonLogger } from "./lib/logger.js";
import { Redactor } from "./lib/redactor.js";
import { RunManager } from "./runtime/run-manager.js";

async function listen(server: Server, port: number, host: string): Promise<void> {
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
  const connection = new ProcessAppServerConnection(config.codexBin, logger);
  const adapter = new CodexAdapter(connection, config.safeCwd);
  try {
    await adapter.start();
  } catch {
    logger.warn("runtime unavailable at startup", { runtime: "codex" });
  }
  const runManager = new RunManager(new Map([[adapter.id, adapter]]), logger);
  const app = createHttpApp({
    runManager,
    adapters: [adapter],
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
    await adapter.shutdown();
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
