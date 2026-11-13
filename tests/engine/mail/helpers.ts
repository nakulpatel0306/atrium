import type { SourceMessage } from "../../../src/engine/mail/types";

export const SAM = "sam@example.com";
export const T0 = Date.parse("2026-11-02T15:00:00Z");

export function msg(over: Partial<SourceMessage> & { sourceId: string }): SourceMessage {
  return {
    messageId: null,
    inReplyTo: null,
    references: [],
    subject: "Lease renewal",
    from: { name: "Robin Vale", address: "robin@example.net" },
    to: [{ name: "Sam", address: SAM }],
    cc: [],
    date: T0,
    snippet: "",
    unread: true,
    sent: false,
    labels: [],
    attachments: [],
    ...over,
  };
}
