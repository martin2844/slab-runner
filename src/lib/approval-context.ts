import type { Redactor } from "./redactor.js";

const EMAIL_WRITE_TOOLS = new Set(["email_send", "email_reply"]);

export function requiresExactWriteContext(
  server: string | undefined,
  tool: string | undefined,
) {
  return (
    (server === "email" && !!tool && EMAIL_WRITE_TOOLS.has(tool)) ||
    (server?.startsWith("whatsapp_") === true && tool === "whatsapp_send_text")
  );
}

export function writeApprovalContext(
  server: string | undefined,
  tool: string | undefined,
  argumentsValue: unknown,
  redactor: Redactor,
): Record<string, unknown> {
  if (
    server === "docs" &&
    tool &&
    ["create_doc", "update_doc", "archive_doc"].includes(tool)
  )
    return { server, tool };
  if (!requiresExactWriteContext(server, tool)) return {};
  const toolArguments = redactor.value(argumentsValue);
  const original = argumentsValue as Record<string, unknown> | null;
  const safe = toolArguments as Record<string, unknown> | null;
  const redacted =
    server?.startsWith("whatsapp_") &&
    ["account", "chatId", "text"].some(
      (key) => original?.[key] !== safe?.[key],
    );
  return {
    server,
    tool,
    toolArguments,
    ...(redacted ? { writeContextRedacted: true } : {}),
  };
}
