export const runnerErrorCodes = [
  "RUNTIME_UNAVAILABLE",
  "RUNTIME_CRASHED",
  "THREAD_NOT_FOUND",
  "MCP_CONNECTION_FAILED",
  "RUN_CANCELLED",
  "APPROVAL_FAILED",
  "UNKNOWN_RUNTIME_ERROR",
  "RUN_NOT_FOUND",
  "RUN_ALREADY_EXISTS",
  "RUN_HISTORY_EXPIRED",
  "RUN_INTERRUPTED",
  "INVALID_REQUEST",
] as const;

export type RunnerErrorCode = (typeof runnerErrorCodes)[number];

export class RunnerError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string,
    readonly httpStatus = 500,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunnerError";
  }
}

export function isThreadNotFoundMessage(message: string): boolean {
  return /thread.*(?:not found|does not exist)|rollout.*not found/i.test(
    message,
  );
}

export function isMcpFailureMessage(message: string): boolean {
  return /mcp.*(?:failed|connection|initialize|timed out|unavailable)/i.test(
    message,
  );
}

export function normalizeRuntimeError(error: unknown): RunnerError {
  if (error instanceof RunnerError) return error;
  const message =
    error instanceof Error ? error.message : "Unknown runtime error";
  if (isThreadNotFoundMessage(message)) {
    return new RunnerError(
      "THREAD_NOT_FOUND",
      "Runtime thread was not found",
      404,
    );
  }
  if (isMcpFailureMessage(message)) {
    return new RunnerError(
      "MCP_CONNECTION_FAILED",
      "An allowed MCP server could not be reached",
      502,
    );
  }
  return new RunnerError(
    "UNKNOWN_RUNTIME_ERROR",
    "The runtime could not complete the run",
    502,
  );
}

export function publicError(error: unknown): {
  code: RunnerErrorCode;
  message: string;
} {
  const normalized =
    error instanceof RunnerError ? error : normalizeRuntimeError(error);
  return { code: normalized.code, message: normalized.message };
}
