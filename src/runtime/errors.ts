export const runnerErrorCodes = [
  "RUNTIME_UNAVAILABLE",
  "RUNTIME_AUTHENTICATION_REQUIRED",
  "RUNTIME_USAGE_LIMIT_EXCEEDED",
  "RUNTIME_MODEL_UNSUPPORTED",
  "RUNTIME_CRASHED",
  "RUNTIME_BUDGET_EXCEEDED",
  "RUNTIME_BUDGET_UNSUPPORTED",
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
  if (/you(?:'|’)ve hit your usage limit|usage limit (?:has been )?(?:reached|exceeded)|insufficient_quota/i.test(message)) {
    // Only copy a recognized date, never an arbitrary provider error or URL.
    const retryAt = message.match(
      /try again at ((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?) \d{1,2}(?:st|nd|rd|th)?, \d{4} \d{1,2}:\d{2} (?:AM|PM))\b/i,
    )?.[1];
    return new RunnerError(
      "RUNTIME_USAGE_LIMIT_EXCEEDED",
      "The runtime account has reached its usage limit. Check the connected account and its plan or credits in runtime settings." +
        (retryAt ? ` The provider reports that you can retry at ${retryAt}.` : " Retry after quota is restored."),
      429,
    );
  }
  if (/model.*(?:is not supported|unsupported|does not exist|not available)|model_not_found/i.test(message)) {
    return new RunnerError(
      "RUNTIME_MODEL_UNSUPPORTED",
      "The selected model is unavailable for the connected runtime account. Choose a supported model in the agent settings.",
      400,
    );
  }
  if (/refresh_token_(?:reused|expired|invalid)|(?:access|refresh|authentication) token.*(?:expired|invalid)|(?:authentication|login|sign.in) required|incorrect api key|invalid_api_key/i.test(message)) {
    return new RunnerError(
      "RUNTIME_AUTHENTICATION_REQUIRED",
      "The runtime credentials are missing, expired, or invalid. Reconnect the account or update its API key in runtime settings.",
      401,
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
