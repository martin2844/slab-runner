import { request as httpRequest } from "node:http";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
  AnthropicCredentialProxy,
  type AnthropicUpstreamRequest,
} from "../src/adapters/anthropic-credential-proxy.js";

class StalledUpstream extends PassThrough {
  timeoutMs: number | null = null;

  setTimeout(timeoutMs: number, callback?: () => void): this {
    this.timeoutMs = timeoutMs;
    if (callback) this.once("test-timeout", callback);
    return this;
  }
}

function clientRequest(baseUrl: string, credential: string) {
  const url = new URL("/v1/messages", baseUrl);
  const request = httpRequest(url, {
    method: "POST",
    headers: { "x-api-key": credential },
  });
  request.on("error", () => {});
  request.end("{}");
  return request;
}

it("destroys stalled upstream requests when the downstream disconnects", async () => {
  const upstreams: StalledUpstream[] = [];
  const requestUpstream: AnthropicUpstreamRequest = (() => {
    const upstream = new StalledUpstream();
    upstreams.push(upstream);
    return upstream;
  }) as unknown as AnthropicUpstreamRequest;
  const proxy = new AnthropicCredentialProxy(requestUpstream, 1_000);
  await proxy.start();
  const lease = proxy.register("sk-ant-test-secret");
  const client = clientRequest(lease.baseUrl, lease.credential);
  await expect.poll(() => upstreams.length).toBe(1);

  client.destroy();

  await expect.poll(() => upstreams[0]?.destroyed).toBe(true);
  lease.release();
  await proxy.stop();
});

it("bounds shutdown by destroying active upstream requests", async () => {
  const upstreams: StalledUpstream[] = [];
  const requestUpstream: AnthropicUpstreamRequest = (() => {
    const upstream = new StalledUpstream();
    upstreams.push(upstream);
    return upstream;
  }) as unknown as AnthropicUpstreamRequest;
  const proxy = new AnthropicCredentialProxy(requestUpstream, 1_000);
  await proxy.start();
  const lease = proxy.register("sk-ant-test-secret");
  const client = clientRequest(lease.baseUrl, lease.credential);
  await expect.poll(() => upstreams.length).toBe(1);

  await expect(proxy.stop()).resolves.toBeUndefined();

  expect(upstreams[0]?.destroyed).toBe(true);
  client.destroy();
  lease.release();
});
