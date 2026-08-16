import { EventEmitter } from "node:events";

export type RpcId = string | number;

export interface RpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcServerRequest extends RpcNotification {
  id: RpcId;
}

export interface AppServerConnection {
  readonly ready: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  respond(id: RpcId, result: unknown): void;
  on(event: "notification", listener: (message: RpcNotification) => void): this;
  on(event: "serverRequest", listener: (message: RpcServerRequest) => void): this;
  on(event: "crash", listener: (error: Error) => void): this;
  on(event: "ready", listener: () => void): this;
}

export abstract class BaseAppServerConnection
  extends EventEmitter
  implements AppServerConnection
{
  abstract readonly ready: boolean;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract request(method: string, params?: unknown): Promise<unknown>;
  abstract notify(method: string, params?: unknown): void;
  abstract respond(id: RpcId, result: unknown): void;
}
