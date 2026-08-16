import { Redactor } from "./redactor.js";

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export class JsonLogger implements Logger {
  constructor(private readonly redactor = new Redactor()) {}

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write("error", message, fields);
  }

  private write(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown>,
  ): void {
    const safeFields = this.redactor.value(fields) as Record<string, unknown>;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: this.redactor.text(message),
      ...safeFields,
    };
    const serialized = JSON.stringify(entry);
    if (level === "error") process.stderr.write(`${serialized}\n`);
    else process.stdout.write(`${serialized}\n`);
  }
}

export class SilentLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}
