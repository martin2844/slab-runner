import { describe, expect, it } from "vitest";
import { requiresExactWriteContext, writeApprovalContext } from "../src/lib/approval-context.js";
import { Redactor } from "../src/lib/redactor.js";

describe("WhatsApp write approvals", () => {
  it("keeps the exact account, recipient and text while redacting credentials", () => {
    const redactor = new Redactor();
    redactor.add("connector-secret");
    expect(writeApprovalContext("whatsapp_personal", "whatsapp_send_text", {
      account: "34600000000@c.us", chatId: "34611111111@c.us", text: "  Hello\n", token: "connector-secret",
    }, redactor)).toEqual({ server: "whatsapp_personal", tool: "whatsapp_send_text", toolArguments: {
      account: "34600000000@c.us", chatId: "34611111111@c.us", text: "  Hello\n", token: "[REDACTED]",
    } });
  });
  it("does not attach chat histories to read approvals or trust unrelated server names", () => {
    expect(requiresExactWriteContext("whatsapp_personal", "whatsapp_get_messages")).toBe(false);
    expect(requiresExactWriteContext("custom_mcp_personal", "whatsapp_send_text")).toBe(false);
    expect(requiresExactWriteContext("email", "email_send")).toBe(true);
  });
  it("flags message redaction so hidden bytes cannot be approved as exact text", () => {
    const result = writeApprovalContext("whatsapp_personal", "whatsapp_send_text", {
      account: "34600000000@c.us", chatId: "34611111111@c.us", text: "https://example.com/invite?token=private-invite",
    }, new Redactor());
    expect(result.writeContextRedacted).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-invite");
  });
});
