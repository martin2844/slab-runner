import type { Redactor } from "./redactor.js";

const EMAIL_WRITE_TOOLS = new Set(["email_send", "email_reply"]);

export function emailApprovalContext(
  server: string | undefined,
  tool: string | undefined,
  argumentsValue: unknown,
  redactor: Redactor,
): Record<string, unknown> {
  if (server !== "email" || !tool || !EMAIL_WRITE_TOOLS.has(tool)) return {};
  return {
    server,
    tool,
    toolArguments: redactor.value(argumentsValue),
  };
}
