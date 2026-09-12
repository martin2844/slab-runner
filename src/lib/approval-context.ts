import type { Redactor } from "./redactor.js";

const EMAIL_WRITE_TOOLS = new Set(["email_send", "email_reply"]);

export function requiresExactWriteContext(server: string | undefined, tool: string | undefined) {
  return (server === "email" && !!tool && EMAIL_WRITE_TOOLS.has(tool)) ||
    (server?.startsWith("whatsapp_") === true && tool === "whatsapp_send_text");
}

export function writeApprovalContext(
  server: string | undefined,
  tool: string | undefined,
  argumentsValue: unknown,
  redactor: Redactor,
): Record<string, unknown> {
  if (!requiresExactWriteContext(server, tool)) return {};
  return {
    server,
    tool,
    toolArguments: redactor.value(argumentsValue),
  };
}
