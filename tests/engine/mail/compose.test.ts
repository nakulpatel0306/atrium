import { describe, expect, test } from "bun:test";
import { bodyProblem, BODY_HIDDEN_COPY, markAdded, parseRecipients, replyRecipients, subjectFor } from "../../../src/engine/mail/compose";
import { buildMime, encodeWord } from "../../../src/engine/mail/mime";
import type { Outgoing } from "../../../src/engine/mail/types";
import { SAM } from "./helpers";

const own = new Set([SAM]);
const robin = { name: "Robin Vale", address: "robin@example.net" };
const kit = { name: "Kit", address: "kit@example.org" };

describe("who a reply goes to", () => {
  test("someone else's message: its sender, or for reply all everyone on it but you", () => {
    const m = { from: robin, to: [{ name: "Sam", address: SAM }, kit], cc: [{ name: "", address: "lee@example.org" }, { name: "Sam", address: SAM }] };
    expect(replyRecipients(own, m, "reply")).toEqual({ to: [robin], cc: [] });
    expect(replyRecipients(own, m, "reply_all")).toEqual({ to: [robin, kit], cc: [{ name: "", address: "lee@example.org" }] });
  });

  test("your own message: whom you sent it to", () => {
    expect(replyRecipients(own, { from: { name: "Sam", address: SAM }, to: [robin], cc: [kit] }, "reply")).toEqual({ to: [robin], cc: [] });
  });

  test("subjects don't stack prefixes", () => {
    expect(subjectFor("reply", "Re: Lease")).toBe("Re: Lease");
    expect(subjectFor("forward", "Lease")).toBe("Fwd: Lease");
  });

  test("Claude's marks follow the person through the user's edits", () => {
    expect(markAdded([kit, robin], [{ ...kit, added: true }, { ...robin, added: false }])).toEqual([
      { ...kit, added: true },
      { ...robin, added: false },
    ]);
  });

  test("typed recipients must be addresses; hidden characters in the body are refused", () => {
    expect(parseRecipients("Robin <robin@example.net>, kit@example.org").people).toHaveLength(2);
    expect(parseRecipients("Robin, kit@example.org").problem).toContain("isn't an email address");
    expect(bodyProblem("Pay ‮txet", "reply")).toBe(BODY_HIDDEN_COPY);
    expect(bodyProblem("", "forward")).toBeNull();
  });
});

describe("the message Gmail is handed", () => {
  const out: Outgoing = {
    from: { name: "Sam", address: SAM },
    to: [{ name: "Robin\r\nBcc: evil@example.net", address: "robin@example.net" }],
    cc: [],
    subject: "Lunch\r\nBcc: evil@example.net",
    text: "Hi",
    messageId: "<atrium.1@example.com>",
    inReplyTo: "<a@example.net>",
    references: ["<root@example.net>", "<a@example.net>"],
    threadKey: null,
    replyToSourceId: null,
    attachments: [],
  };

  test("no name or subject can add a header", () => {
    const raw = buildMime(out);
    const headers = raw.split("\r\n\r\n")[0]!.split("\r\n");
    expect(headers.filter((h) => h.startsWith("Bcc"))).toEqual([]);
    expect(headers).toContain('To: "Robin Bcc: evil@example.net" <robin@example.net>');
    expect(headers).toContain("In-Reply-To: <a@example.net>");
    expect(headers).toContain("References: <root@example.net> <a@example.net>");
  });

  test("non-ASCII subjects and names become encoded words", () => {
    expect(encodeWord("Café")).toBe(`=?UTF-8?B?${Buffer.from("Café").toString("base64")}?=`);
    const raw = buildMime({ ...out, subject: "Résumé", to: [{ name: "Renée", address: "renee@example.org" }] });
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Résumé").toString("base64")}?=`);
  });
});
