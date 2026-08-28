function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 2_000
    ? value
    : null;
}

export function toolTargetMetadata(
  server: string,
  tool: string,
  argumentsValue: unknown,
  redactor: Pick<Redactor, "text">,
): Record<string, string> {
  if (server !== "email" || tool !== "email_reply") return {};
  const args = record(argumentsValue);
  const targetAccountId = boundedIdentifier(args.accountId);
  const targetMessageId = boundedIdentifier(args.messageId);
  const safeAccountId = targetAccountId
    ? redactor.text(targetAccountId)
    : null;
  const safeMessageId = targetMessageId
    ? redactor.text(targetMessageId)
    : null;
  return {
    ...(targetAccountId && safeAccountId === targetAccountId
      ? { targetAccountId }
      : {}),
    ...(targetMessageId && safeMessageId === targetMessageId
      ? { targetMessageId }
      : {}),
  };
}
import type { Redactor } from "./redactor.js";
