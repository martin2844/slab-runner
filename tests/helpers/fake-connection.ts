import {
  BaseAppServerConnection,
  type RpcId,
  type RpcNotification,
  type RpcRequestOptions,
  type RpcServerRequest,
} from "../../src/app-server/connection.js";

export interface CapturedRequest {
  method: string;
  params: unknown;
}

export class FakeAppServerConnection extends BaseAppServerConnection {
  ready = true;
  requests: CapturedRequest[] = [];
  notifications: CapturedRequest[] = [];
  responses: Array<{ id: RpcId; result: unknown }> = [];
  requestHandler: (method: string, params: unknown) => Promise<unknown> = (
    method,
  ) => {
    if (method === "thread/start" || method === "thread/resume") {
      return Promise.resolve({ thread: { id: "thread-1" } });
    }
    if (method === "turn/start") {
      return Promise.resolve({ turn: { id: "turn-1" } });
    }
    return Promise.resolve({});
  };

  start(): Promise<void> {
    this.ready = true;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.ready = false;
    return Promise.resolve();
  }

  request(
    method: string,
    params: unknown = {},
    options: RpcRequestOptions = {},
  ): Promise<unknown> {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(new Error("Request aborted"));
    this.requests.push({ method, params });
    const response = this.requestHandler(method, params);
    if (!signal) return response;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Request aborted"));
      signal.addEventListener("abort", abort, { once: true });
      response.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error instanceof Error ? error : new Error("Request failed"));
        },
      );
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.notifications.push({ method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.responses.push({ id, result });
  }

  serverNotification(message: RpcNotification): void {
    this.emit("notification", message);
  }

  serverRequest(message: RpcServerRequest): void {
    this.emit("serverRequest", message);
  }

  crash(): void {
    this.ready = false;
    this.emit("crash", new Error("crashed"));
  }
}
