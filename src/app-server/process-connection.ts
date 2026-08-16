import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { BaseAppServerConnection, type RpcId } from "./connection.js";
import { RunnerError } from "../runtime/errors.js";
import type { Logger } from "../lib/logger.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface RpcResponse {
  id: RpcId;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface RpcIncomingRequest {
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
}

export class AppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "AppServerRpcError";
  }
}

export class ProcessAppServerConnection extends BaseAppServerConnection {
  #child: ChildProcessWithoutNullStreams | null = null;
  #reader: ReadLineInterface | null = null;
  #pending = new Map<RpcId, PendingRequest>();
  #nextId = 1;
  #ready = false;
  #desired = false;
  #restartTimer: NodeJS.Timeout | null = null;
  #restartAttempts = 0;
  #launching: Promise<void> | null = null;

  constructor(
    private readonly codexBin: string,
    private readonly logger: Logger,
  ) {
    super();
  }

  get ready(): boolean {
    return this.#ready;
  }

  async start(): Promise<void> {
    this.#desired = true;
    try {
      await this.launch();
    } catch (error) {
      this.scheduleRestart();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#desired = false;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#ready = false;
    const child = this.#child;
    this.#child = null;
    this.#reader?.close();
    this.#reader = null;
    this.rejectPending(
      new RunnerError("RUNTIME_UNAVAILABLE", "Codex runtime is unavailable", 503),
    );
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      timeout.unref();
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (!this.#ready && method !== "initialize") {
      return Promise.reject(
        new RunnerError("RUNTIME_UNAVAILABLE", "Codex runtime is unavailable", 503),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.send({ method, id, params });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("RPC write failed"));
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.send({ method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.send({ id, result });
  }

  private async launch(): Promise<void> {
    if (this.#ready) return;
    if (this.#launching) return this.#launching;
    this.#launching = this.doLaunch().finally(() => {
      this.#launching = null;
    });
    return this.#launching;
  }

  private async doLaunch(): Promise<void> {
    await this.probeCodex();
    if (!this.#desired) return;
    const child = spawn(
      this.codexBin,
      ["app-server", "--stdio", "-c", "mcp_servers={}"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.runtimeEnvironment(),
      },
    );
    this.#child = child;
    child.stderr.on("data", () => {
      // Drain stderr without forwarding it. Runtime diagnostics can contain user data.
    });
    this.#reader = createInterface({ input: child.stdout });
    this.#reader.on("line", (line) => this.handleLine(line));
    child.once("error", (error) => this.handleExit(child, error));
    child.once("exit", (code, signal) => {
      this.handleExit(
        child,
        new Error(`Codex app-server exited (${signal ?? String(code ?? "unknown")})`),
      );
    });

    try {
      await this.requestDuringInitialization("initialize", {
        clientInfo: {
          name: "slab_runner",
          title: "Slab Runner",
          version: "0.1.0",
        },
        capabilities: null,
      });
      this.notify("initialized", {});
      this.#ready = true;
      this.#restartAttempts = 0;
      this.logger.info("runtime startup", { runtime: "codex" });
      this.emit("ready");
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  }

  private requestDuringInitialization(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.send({ method, id, params });
    });
  }

  private probeCodex(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.codexBin, ["--version"], {
        stdio: "ignore",
      });
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(
          new RunnerError(
            "RUNTIME_UNAVAILABLE",
            "Codex runtime is unavailable",
            503,
          ),
        );
      }, 5_000);
      timeout.unref();
      child.once("error", () => {
        clearTimeout(timeout);
        reject(
          new RunnerError(
            "RUNTIME_UNAVAILABLE",
            "Codex runtime is unavailable",
            503,
          ),
        );
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else
          reject(
            new RunnerError(
              "RUNTIME_UNAVAILABLE",
              "Codex runtime is unavailable",
              503,
            ),
          );
      });
    });
  }

  private runtimeEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    delete environment.RUNNER_TOKEN;
    return environment;
  }

  private send(message: Record<string, unknown>): void {
    const child = this.#child;
    if (!child?.stdin.writable) {
      throw new RunnerError(
        "RUNTIME_UNAVAILABLE",
        "Codex runtime is unavailable",
        503,
      );
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcIncomingRequest & RpcResponse;
    try {
      message = JSON.parse(line) as RpcIncomingRequest & RpcResponse;
    } catch {
      this.logger.warn("runtime emitted an invalid protocol message", {
        runtime: "codex",
      });
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new AppServerRpcError(
            message.error.message ?? "Codex app-server request failed",
            message.error.code,
          ),
        );
      } else pending.resolve(message.result);
      return;
    }

    if (!message.method) return;
    if (message.id !== undefined) {
      this.emit("serverRequest", {
        id: message.id,
        method: message.method,
        ...(message.params ? { params: message.params } : {}),
      });
    } else {
      this.emit("notification", {
        method: message.method,
        ...(message.params ? { params: message.params } : {}),
      });
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#child !== child) return;
    const shouldReportCrash = this.#desired && (this.#ready || this.#pending.size > 0);
    this.#ready = false;
    this.#child = null;
    this.#reader?.close();
    this.#reader = null;
    this.rejectPending(
      new RunnerError("RUNTIME_CRASHED", "Codex runtime crashed", 502, {
        cause: error,
      }),
    );
    if (shouldReportCrash) {
      this.logger.error("runtime crash", { runtime: "codex" });
      this.emit("crash", error);
    }
    this.scheduleRestart();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  private scheduleRestart(): void {
    if (!this.#desired || this.#restartTimer) return;
    const delay = Math.min(1_000 * 2 ** this.#restartAttempts, 30_000);
    this.#restartAttempts += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.launch().catch(() => this.scheduleRestart());
    }, delay);
    this.#restartTimer.unref();
  }
}
