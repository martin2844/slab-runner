import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  request as httpsRequest,
  type RequestOptions,
} from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { RunnerError } from "../runtime/errors.js";

export interface AnthropicCredentialLease {
  readonly baseUrl: string;
  readonly credential: string;
  release(): void;
}

export type AnthropicUpstreamRequest = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

/**
 * Keeps Anthropic API keys outside the spawned agent process. The child sees a
 * short-lived surrogate and a loopback-only API origin; this proxy replaces
 * the surrogate with the real key on requests to Anthropic's fixed origin.
 */
export class AnthropicCredentialProxy {
  readonly #credentials = new Map<string, string>();
  readonly #activeRequests = new Set<ClientRequest>();
  #server: Server | null = null;
  #baseUrl: string | null = null;

  constructor(
    private readonly requestUpstream: AnthropicUpstreamRequest = httpsRequest,
    private readonly requestTimeoutMs = 30_000,
  ) {}

  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((request, response) => {
      const supplied = this.suppliedCredential(request.headers);
      const apiKey = supplied ? this.#credentials.get(supplied) : undefined;
      if (!apiKey) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Unauthorized" } }));
        return;
      }
      const path = request.url ?? "/";
      if (!path.startsWith("/v1/")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Not found" } }));
        return;
      }

      const headers = { ...request.headers };
      delete headers.host;
      delete headers.authorization;
      delete headers["x-api-key"];
      headers["x-api-key"] = apiKey;
      const upstream = this.requestUpstream(
        {
          protocol: "https:",
          hostname: "api.anthropic.com",
          port: 443,
          method: request.method,
          path,
          headers,
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.headers,
          );
          upstreamResponse.pipe(response);
        },
      );
      this.#activeRequests.add(upstream);
      upstream.once("close", () => this.#activeRequests.delete(upstream));
      upstream.setTimeout(this.requestTimeoutMs, () => {
        upstream.destroy(new Error("Anthropic API request timed out"));
      });
      request.once("aborted", () => {
        upstream.destroy(new Error("Downstream request was aborted"));
      });
      response.once("close", () => {
        if (!response.writableEnded) {
          upstream.destroy(new Error("Downstream response was closed"));
        }
      });
      upstream.on("error", () => {
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "application/json" });
        }
        response.end(
          JSON.stringify({ error: { message: "Anthropic API unavailable" } }),
        );
      });
      request.pipe(upstream);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new RunnerError(
        "RUNTIME_UNAVAILABLE",
        "Claude credential boundary could not start",
        503,
      );
    }
    this.#server = server;
    this.#baseUrl = `http://127.0.0.1:${address.port}`;
  }

  register(apiKey: string): AnthropicCredentialLease {
    if (!this.#baseUrl) {
      throw new RunnerError(
        "RUNTIME_UNAVAILABLE",
        "Claude credential boundary is unavailable",
        503,
      );
    }
    const credential = randomBytes(32).toString("base64url");
    this.#credentials.set(credential, apiKey);
    let released = false;
    return {
      baseUrl: this.#baseUrl,
      credential,
      release: () => {
        if (released) return;
        released = true;
        this.#credentials.delete(credential);
      },
    };
  }

  async stop(): Promise<void> {
    this.#credentials.clear();
    const server = this.#server;
    this.#server = null;
    this.#baseUrl = null;
    if (!server) return;
    for (const request of this.#activeRequests) {
      request.destroy(new Error("Claude credential boundary is stopping"));
    }
    this.#activeRequests.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  get ready(): boolean {
    return this.#server !== null;
  }

  private suppliedCredential(
    headers: Record<string, string | string[] | undefined>,
  ): string | null {
    const apiKey = headers["x-api-key"];
    if (typeof apiKey === "string") return apiKey;
    const authorization = headers.authorization;
    if (typeof authorization !== "string") return null;
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    return match?.[1] ?? null;
  }
}
