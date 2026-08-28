import { describe, expect, it } from "vitest";
import { toolTargetMetadata } from "../src/lib/tool-event-metadata.js";

describe("tool event target metadata", () => {
  const redactor = { text: (value: string) => value };

  it("retains only the bounded Email reply identity", () => {
    expect(
      toolTargetMetadata("email", "email_reply", {
        accountId: "account-1",
        messageId: "message-1",
        text: "private body",
        expectedFrom: "sender@example.com",
      }, redactor),
    ).toEqual({
      targetAccountId: "account-1",
      targetMessageId: "message-1",
    });
  });

  it("does not project metadata for unrelated tools or malformed targets", () => {
    expect(
      toolTargetMetadata("email", "email_search", {
        accountId: "account-1",
      }, redactor),
    ).toEqual({});
    expect(
      toolTargetMetadata("email", "email_reply", {
        accountId: "account-1",
        messageId: "x".repeat(2_001),
      }, redactor),
    ).toEqual({ targetAccountId: "account-1" });
  });

  it("fails closed when either identifier is redacted", () => {
    expect(
      toolTargetMetadata(
        "email",
        "email_reply",
        { accountId: "account-secret", messageId: "message-1" },
        {
          text: (value) =>
            value === "account-secret" ? "[REDACTED]" : value,
        },
      ),
    ).toEqual({ targetMessageId: "message-1" });
  });
});
