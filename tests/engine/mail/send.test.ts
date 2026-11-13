import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getApproval, onApprovalResolved, resolveApproval, RULE_NEVER_DECIDES } from "../../../src/engine/approvals";
import { openDb } from "../../../src/engine/db";
import { createMail, type Mail } from "../../../src/engine/mail";
import { APPLE_EVENT_COPY, draftEvent, draftMail, explicitReasons, getMailAction, type MailAction, pendingMailActions, updateMailDraft } from "../../../src/engine/mail/drafts";
import { mailKeychain } from "../../../src/engine/mail/google/oauth";
import { PIM_COPY } from "../../../src/engine/mail/pim";
import { createMailActions, NO_RSVP_COPY, OPEN_IN_MAIL_COPY, recoverMailActions, STOPPED_COPY } from "../../../src/engine/mail/send";
import { googleSource } from "../../../src/engine/mail/google/source";
import { appleSource, NO_GUESTS_COPY } from "../../../src/engine/mail/apple";
import { inboxSpace } from "../../../src/engine/mail/space";
import { ingestMessages, listAccounts, listCalendars, listEvents, listThreads, replaceEvents, setPreferred, threadMessages, upsertAccount } from "../../../src/engine/mail/store";
import { createTask, getTask } from "../../../src/engine/tasks";
import { tempHome } from "../../helpers";
import { approveInBrowser, CLIENT_ID, FAKE_SECURITY, useFakes } from "./fakes";
import { msg, SAM, T0 } from "./helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let fakes: ReturnType<typeof useFakes>;
let mail: Mail;
let unhook: () => void;
const NOW = T0 + 5 * 86_400_000;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  fakes = useFakes();
  mail = createMail({ db, keychain: mailKeychain(FAKE_SECURITY), now: () => NOW });
  unhook = onApprovalResolved(mail.actions.onDecision);
});
afterEach(async () => {
  unhook();
  await mail.actions.settle();
  mail.sync.stop();
  delete process.env.FAKE_PIM_MODE;
  fakes.undo();
  db.close();
  home.cleanup();
});

async function connectGoogle() {
  const flow = await mail.auth.start({ clientId: CLIENT_ID });
  await approveInBrowser(flow.url);
  const r = await flow.done;
  if (!r.ok) throw new Error(r.error);
  await mail.sync.syncNow();
}

const space = () => inboxSpace(db).id;
const lease = () => listThreads(db).find((t) => t.subject === "Lease renewal")!;
// Gmail lists attachment names only with a body, which opening the thread fetches.
const openLease = () => mail.sync.fetchBodies(threadMessages(db, lease().id).map((m) => m.id));
const google = () => listAccounts(db).find((a) => a.source === "google")!;
// What the card's Send does: the user's own yes on the draft's approval. The send runs after it.
async function pressSend(a: MailAction) {
  resolveApproval(db, a.approvalId, "approve");
  await mail.actions.settle();
  return getMailAction(db, a.id)!;
}
const sends = () => fakes.google.writes.filter((w) => w.path.endsWith("/messages/send"));

describe("replies", () => {
  test("recipients and threading come from the thread's headers; Send goes out once through Gmail and shows in the thread", async () => {
    await connectGoogle();
    const { action, approval } = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: lease().id, body: "Thursday at 10 works." });
    // The last message is Sam's own, so the reply goes to whom Sam wrote to.
    expect(action.to).toEqual([{ name: "", address: "robin@example.net", added: false }]);
    expect(action.subject).toBe("Re: Lease renewal");
    expect(approval).toMatchObject({ alwaysAsk: "send_message", title: "Send a reply to robin@example.net?", status: "pending" });
    expect(action.reasons).toEqual([]);

    // Nothing goes out while it waits, and no rule can decide it.
    expect((await mail.actions.send(action.id)).status).toBe("draft");
    expect(() => resolveApproval(db, approval.id, "approve", undefined, { id: "rul_x", label: "x" })).toThrow(RULE_NEVER_DECIDES);
    expect(sends()).toEqual([]);

    const sent = await pressSend(action);
    expect(sent.error).toBeNull();
    expect(sent.status).toBe("sent");
    expect(sends()).toHaveLength(1);
    const w = sends()[0]!;
    expect(w.body.threadId).toBe("gt-lease");
    expect(w.raw).toContain("In-Reply-To: <lease-2@example.com>");
    expect(w.raw).toContain("References: <lease-1@example.net> <lease-2@example.com>");
    expect(w.raw).toContain("To: robin@example.net");
    expect(w.raw).toContain("Subject: Re: Lease renewal");
    expect(w.raw).toMatch(/Message-ID: <atrium\.[0-9a-f]+@example\.com>/);
    const body = Buffer.from(w.raw!.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(body).toStartWith("Thursday at 10 works.\r\n\r\nOn ");
    expect(body).toContain("> Thanks! Can we sign Thursday?");

    // The sent message is in the thread at once, with its words.
    const shown = threadMessages(db, lease().id);
    expect(shown).toHaveLength(3);
    expect(shown.at(-1)).toMatchObject({ from: { address: SAM }, body: expect.stringContaining("Thursday at 10 works.") });
    expect(getApproval(db, approval.id)!.status).toBe("approved");
  });

  test("the sent copy gives way to Gmail's own on the next sync, so it shows once", async () => {
    await connectGoogle();
    const { action } = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: lease().id, body: "Thursday works." });
    await pressSend(action);
    expect(threadMessages(db, lease().id)).toHaveLength(3);
    await mail.sync.syncNow();
    const after = threadMessages(db, lease().id);
    expect(after).toHaveLength(3);
    expect(after.at(-1)!.sourceId).toMatch(/^sent-/);
  });

  test("reply all keeps everyone on the thread but you; a second Send, or two at once, sends once", async () => {
    await connectGoogle();
    const first = threadMessages(db, lease().id)[0]!;
    const { action } = draftMail(db, { spaceId: space(), kind: "reply_all", draftedBy: "you", threadId: lease().id, messageId: first.id, body: "Yes." });
    expect(action.to.map((p) => p.address)).toEqual(["robin@example.net"]);
    resolveApproval(db, action.approvalId, "approve");
    await Promise.all([mail.actions.send(action.id), mail.actions.send(action.id)]);
    await mail.actions.settle();
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.raw).toContain("In-Reply-To: <lease-1@example.net>");
    expect(() => resolveApproval(db, action.approvalId, "approve")).toThrow();
    expect(sends()).toHaveLength(1);
  });

  test("Claude can add people to a reply, and each one it added is marked and noted as new", async () => {
    await connectGoogle();
    const { action } = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "claude", threadId: lease().id, to: [{ name: "Kit Moreno", address: "kit@example.org" }], body: "Looping in Kit." });
    expect(action.to).toEqual([
      { name: "", address: "robin@example.net", added: false },
      { name: "Kit Moreno", address: "kit@example.org", added: true },
    ]);
    expect(action.reasons).toEqual([{ kind: "first_time", key: "first_time:kit@example.org", text: "first time emailing Kit Moreno <kit@example.org>" }]);
    // The user's edits keep Kit marked; someone the user types isn't.
    const edited = updateMailDraft(db, action.id, { accountId: google().id, to: [...action.to, { name: "", address: "lee@example.org" }], cc: [], subject: "", body: "Looping in Kit and Lee." });
    expect(edited.to.map((p) => [p.address, p.added])).toEqual([["robin@example.net", false], ["kit@example.org", true], ["lee@example.org", false]]);
    expect(edited.reasons.map((r) => r.text)).toEqual(["first time emailing Kit Moreno <kit@example.org>", "first time emailing lee@example.org"]);
  });
});

describe("what needs the explicit Send", () => {
  test("Claude's drafts meet the recipient rules when they're made, not only at Send", async () => {
    await connectGoogle();
    expect(() => draftMail(db, { spaceId: space(), kind: "new", draftedBy: "claude", subject: "Hi", body: "Hello" })).toThrow("Add who this goes to first.");
    const many = Array.from({ length: 51 }, (_, i) => ({ name: "", address: `p${i}@example.org` }));
    expect(() => draftMail(db, { spaceId: space(), kind: "new", draftedBy: "claude", to: many, subject: "Hi", body: "Hello" })).toThrow("at most 50 people");
    expect(pendingMailActions(db)).toEqual([]);
  });

  test("titles and notes name the address, so a borrowed name can't pass as the real person", async () => {
    await connectGoogle();
    const { action, approval } = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "claude", threadId: lease().id, to: [{ name: "Robin Vale", address: "robin.vale@example.net" }], body: "Looping in." });
    expect(approval.title).toBe("Send a reply to robin@example.net and Robin Vale <robin.vale@example.net>?");
    expect(action.reasons).toEqual([{ kind: "first_time", key: "first_time:robin.vale@example.net", text: "first time emailing Robin Vale <robin.vale@example.net>" }]);
  });

  test("only people you've written to count as known; being on someone else's email doesn't", async () => {
    await connectGoogle();
    const acct = google();
    // A stranger mails you and Cc's an address of their choosing.
    ingestMessages(db, acct, [msg({ sourceId: "s1", messageId: "<win@example.org>", subject: "Win", from: { name: "Promo", address: "promo@example.org" }, cc: [{ name: "", address: "drop@example.net" }], date: NOW - 1000 })]);
    const reasons = (address: string) =>
      explicitReasons(db, { kind: "new", accountId: acct.id, threadId: null, threadAccountId: null, to: [{ name: "", address, added: true }], cc: [], attachments: [], event: null }, NOW).map((r) => r.kind);
    expect(reasons("drop@example.net")).toEqual(["first_time"]);
    expect(reasons("promo@example.org")).toEqual(["first_time"]);
    // Robin got mail from you on the lease thread, which Gmail filed as sent.
    expect(reasons("robin@example.net")).toEqual([]);
    // Mail that only claims to be from you, but wasn't filed as sent, doesn't count.
    ingestMessages(db, acct, [msg({ sourceId: "s2", messageId: "<spoof@example.org>", subject: "Hi", from: { name: "Sam", address: SAM }, to: [{ name: "", address: "spoofed@example.net" }], date: NOW - 900 })]);
    expect(reasons("spoofed@example.net")).toEqual(["first_time"]);
  });

  test("replying to people already on the thread is never first time; someone new on it is", async () => {
    await connectGoogle();
    const acct = google();
    // Kit writes to Sam for the first time; Sam has never written to Kit.
    ingestMessages(db, acct, [msg({ sourceId: "k1", threadKey: "gt-kit", messageId: "<kit-1@example.org>", subject: "Hello", from: { name: "Kit Moreno", address: "kit@example.org" }, date: NOW - 1000 })]);
    const kit = listThreads(db).find((t) => t.subject === "Hello")!;
    const reply = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: kit.id, body: "Hi Kit" });
    expect(reply.action.reasons).toEqual([]);
    const forward = draftMail(db, { spaceId: space(), kind: "forward", draftedBy: "you", threadId: kit.id, to: [{ name: "", address: "lee@example.org" }], body: "" });
    expect(forward.action.reasons.map((r) => r.kind)).toEqual(["first_time", "outside_thread"]);
  });

  test("a forward with attachments, another From account, and more than ten people", async () => {
    await connectGoogle();
    await openLease();
    const icloud = upsertAccount(db, { address: "sam.rivera@example.org", name: "Sam Rivera", source: "apple", ref: "acct-icloud" });
    const { action } = draftMail(db, { spaceId: space(), kind: "forward", draftedBy: "you", threadId: lease().id, to: [{ name: "Robin Vale", address: "robin@example.net" }], body: "" });
    expect(action.subject).toBe("Fwd: Re: Lease renewal");
    expect(action.attachments).toEqual([{ name: "lease.pdf", size: 15, index: 0 }]);
    expect(action.reasons).toEqual([{ kind: "attachments", key: "attachments:1", text: "1 attachment" }]);
    expect(action.inReplyTo).toBeNull();

    const many = Array.from({ length: 11 }, (_, i) => ({ name: "", address: `p${i}@example.org` }));
    const other = updateMailDraft(db, action.id, { accountId: icloud.id, to: [{ name: "Robin Vale", address: "robin@example.net" }, ...many], cc: [], subject: "", body: "FYI" });
    const kinds = other.reasons.map((r) => r.kind);
    expect(kinds).toContain("other_account");
    expect(kinds).toContain("many");
    expect(other.reasons.find((r) => r.kind === "other_account")!.text).toBe(`from sam.rivera@example.org, not ${SAM}`);
    expect(other.reasons.find((r) => r.kind === "many")!.text).toBe("12 people");
  });

  test("the approval shows everything that goes out: the quoted reply, or the forwarded message and its attachments", async () => {
    await connectGoogle();
    await openLease();
    const reply = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: lease().id, body: "Thursday works." });
    expect(reply.approval.detail).toContain("> Thursday works.");
    expect(reply.approval.detail).toContain("The message you're answering is quoted below it:");
    expect(reply.approval.detail).toContain("> > Thanks! Can we sign Thursday?");
    const fwd = draftMail(db, { spaceId: space(), kind: "forward", draftedBy: "claude", threadId: lease().id, to: [{ name: "", address: "robin@example.net" }], body: "FYI" });
    const d = fwd.approval.detail;
    expect(d).toContain("The forwarded message goes below it:");
    expect(d).toContain(`> From: Sam Rivera <${SAM}>`);
    expect(d).toContain("> Subject: Re: Lease renewal");
    expect(d).toMatch(/> Date: Mon, Nov 2, 2026/);
    expect(d).toContain("> Thanks! Can we sign Thursday?");
    expect(d).toContain("Attachments: lease.pdf");
  });

  test("forwarding to anyone who wasn't on the thread needs the explicit Send, whoever drafted it", async () => {
    await connectGoogle();
    const kit = { name: "Kit Moreno", address: "kit@example.org" };
    const note = { kind: "outside_thread" as const, key: "outside_thread:kit@example.org", text: "forwards to Kit Moreno <kit@example.org>, who wasn't on the thread" };
    for (const draftedBy of ["you", "claude"] as const) {
      const { action, approval } = draftMail(db, { spaceId: space(), kind: "forward", draftedBy, threadId: lease().id, to: [kit], body: "" });
      expect(action.reasons).toContainEqual(note);
      expect(approval.detail).toContain(`Note: ${note.text}`);
    }
    // Someone on the thread gets no such note, and adding Kit by hand later brings it back.
    const onThread = draftMail(db, { spaceId: space(), kind: "forward", draftedBy: "you", threadId: lease().id, to: [{ name: "", address: "robin@example.net" }], body: "" }).action;
    expect(onThread.reasons.filter((r) => r.kind === "outside_thread")).toEqual([]);
    const edited = updateMailDraft(db, onThread.id, { accountId: google().id, to: [{ name: "", address: "robin@example.net" }], cc: [kit], subject: "", body: "" });
    expect(edited.reasons).toContainEqual(note);
  });

  test("a forward sends the original's attachment along, read from the source that holds it", async () => {
    await connectGoogle();
    await openLease();
    const { action } = draftMail(db, { spaceId: space(), kind: "forward", draftedBy: "you", threadId: lease().id, to: [{ name: "", address: "robin@example.net" }], body: "See attached." });
    expect((await pressSend(action)).status).toBe("sent");
    const raw = sends()[0]!.raw!;
    expect(raw).toContain('Content-Disposition: attachment; filename="lease.pdf"');
    expect(raw).toContain(Buffer.from("%PDF-1.4 fake").toString("base64"));
    expect(raw).not.toContain("In-Reply-To");
    expect(sends()[0]!.body.threadId).toBeUndefined();
  });
});

describe("crossovers and Mail.app", () => {
  // The card's Open in Mail: the user's edits, then a filled-in Mail window he sends from himself.
  const openInMail = (a: MailAction, over: Partial<{ body: string }> = {}) =>
    mail.actions.openInMail(a.id, { accountId: a.accountId!, to: a.to, cc: a.cc, subject: a.subject, body: over.body ?? a.body });

  test("an address read both ways goes out through its preferred source only, and follows a switch", async () => {
    await connectGoogle();
    mail.sync.appleOnNow("mail");
    await mail.sync.syncNow();
    expect(listAccounts(db).filter((a) => a.address === SAM).map((a) => [a.source, a.preferred])).toEqual([
      ["google", true],
      ["apple", false],
    ]);
    const one = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: lease().id, body: "Via Google." }).action;
    await pressSend(one);
    expect(sends()).toHaveLength(1);
    expect(fakes.pimWrites()).toEqual([]);

    // Drafted while Google was preferred; after the switch Atrium won't send it, and Gmail never sees it.
    const two = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: lease().id, body: "Via Mail." }).action;
    setPreferred(db, listAccounts(db).find((a) => a.address === SAM && a.source === "apple")!.id);
    expect(await pressSend(two)).toMatchObject({ status: "failed", error: OPEN_IN_MAIL_COPY });
    expect(sends()).toHaveLength(1);
    expect(fakes.pimWrites()).toEqual([]);
  });

  test("Open in Mail fills in a Mail window, threaded on the message it answers, and never sends", async () => {
    mail.sync.appleOnNow("mail");
    await mail.sync.syncNow();
    const trip = listThreads(db).find((t) => t.subject === "Trip plan")!;
    const first = threadMessages(db, trip.id)[0]!;
    const { action, approval } = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: trip.id, messageId: first.id, body: "" });
    expect(action.to.map((p) => p.address)).toEqual(["kit@example.org"]);
    const opened = await openInMail(action, { body: "9 is good." });
    expect(opened.status).toBe("opened");
    expect(fakes.pimWrites()).toEqual([{ cmd: "mail.compose", input: expect.objectContaining({ account: "acct-icloud", from: "sam.rivera@example.org", replyTo: "ap-2", text: expect.stringMatching(/^9 is good\./) }) }]);
    expect(getApproval(db, approval.id)).toMatchObject({ status: "rejected", note: "Opened in Mail for you to send." });
    // Nothing was sent, so nothing appears in the thread until Mail's own Sent copy syncs.
    expect(threadMessages(db, trip.id)).toHaveLength(2);
  });

  test("a reply drafted through Google and opened after a switch to Mail.app still threads", async () => {
    await connectGoogle();
    mail.sync.appleOnNow("mail");
    await mail.sync.syncNow();
    const first = threadMessages(db, lease().id)[0]!;
    const { action } = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: lease().id, messageId: first.id, body: "Via Mail." });
    const apple = listAccounts(db).find((a) => a.address === SAM && a.source === "apple")!;
    setPreferred(db, apple.id);
    await mail.sync.syncNow();
    await mail.actions.openInMail(action.id, { accountId: apple.id, to: action.to, cc: [], subject: "", body: "Via Mail." });
    expect(fakes.pimWrites()[0]!.input).toMatchObject({ replyTo: "ap-1" });
  });

  test("Mail permission off is the plain Automation copy, and the card stays", async () => {
    mail.sync.appleOnNow("mail");
    await mail.sync.syncNow();
    const trip = listThreads(db).find((t) => t.subject === "Trip plan")!;
    const { action } = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: trip.id, body: "Hi" });
    process.env.FAKE_PIM_MODE = "mail_denied";
    expect(openInMail(action)).rejects.toThrow(PIM_COPY.automation_denied);
    await mail.actions.settle();
    expect(pendingMailActions(db).map((a) => a.id)).toEqual([action.id]);
  });
});

describe("errors", () => {
  test("a send the source accepted stays sent, whatever goes wrong after it", async () => {
    await connectGoogle();
    const google = googleSource(mail.auth);
    // Gmail takes it, then the copy for the thread can't be stored.
    const send = google.send!;
    const breaking = { ...google, send: async (acct: Parameters<typeof send>[0], m: Parameters<typeof send>[1]) => {
      const r = await send(acct, m);
      db.exec("DROP TABLE mail_bodies");
      return r;
    } };
    unhook();
    const actions = createMailActions({ db, google: breaking, apple: appleSource() });
    unhook = onApprovalResolved(actions.onDecision);
    const { action } = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: lease().id, body: "Hi" });
    resolveApproval(db, action.approvalId, "approve");
    await actions.settle();
    expect(sends()).toHaveLength(1);
    expect(getMailAction(db, action.id)).toMatchObject({ status: "sent", error: null });
    expect(pendingMailActions(db)).toEqual([]);
  });

  test("an answer Gmail gave that can't be read is unsure: no redraft, and it says to check Sent", async () => {
    await connectGoogle();
    const google = googleSource(mail.auth, { fetch: (async (url: string, init?: RequestInit) => (init?.method === "POST" ? new Response("<html>gateway</html>", { status: 200 }) : fetch(url, init))) as typeof fetch });
    unhook();
    const actions = createMailActions({ db, google, apple: appleSource() });
    unhook = onApprovalResolved(actions.onDecision);
    const { action } = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: lease().id, body: "Hi" });
    resolveApproval(db, action.approvalId, "approve");
    await actions.settle();
    const after = getMailAction(db, action.id)!;
    expect(after.status).toBe("unsure");
    expect(after.error).toContain("may have gone out");
    expect(after.error).toContain("Check");
    expect(pendingMailActions(db)).toEqual([]);
  });

  test("Google not reachable at all is offline: nothing went out, and the card comes back", async () => {
    await connectGoogle();
    const google = googleSource(mail.auth, { fetch: (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw Object.assign(new Error("Unable to connect."), { code: "ConnectionRefused" });
      return fetch(url, init);
    }) as typeof fetch });
    unhook();
    const actions = createMailActions({ db, google, apple: appleSource() });
    unhook = onApprovalResolved(actions.onDecision);
    const { action } = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: lease().id, body: "Hi" });
    resolveApproval(db, action.approvalId, "approve");
    await actions.settle();
    expect(getMailAction(db, action.id)!.status).toBe("failed");
    expect(pendingMailActions(db)[0]!.error).toContain("nothing went out");
  });

  test("a server error is unsure: the card doesn't come back, so nothing invites a second send", async () => {
    await connectGoogle();
    fakes.google.failWrites = 503;
    const { action } = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: lease().id, body: "Hi" });
    const unsure = await pressSend(action);
    expect(unsure.status).toBe("unsure");
    expect(unsure.error).toContain("may have gone out");
    expect(pendingMailActions(db)).toEqual([]);
  });

  test("a refused send says nothing went out; signed out says to connect again", async () => {
    await connectGoogle();
    fakes.google.failWrites = 400;
    const a = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: lease().id, body: "Hi" }).action;
    expect((await pressSend(a)).error).toBe("Google didn't accept this, so nothing went out. Check the card, then try again.");
    fakes.google.failWrites = null;
    fakes.google.expireAccessTokens();
    fakes.google.revokeAccount(SAM);
    const b = pendingMailActions(db)[0]!;
    const failed = await pressSend(b);
    expect(failed.error).toContain("connect again in Settings");
  });

  test("a send cut off by a restart comes back as a draft that says to check first, and never resends", async () => {
    await connectGoogle();
    const { action } = draftMail(db, { spaceId: space(), kind: "reply", draftedBy: "you", threadId: lease().id, body: "Hi" });
    db.query("UPDATE approvals SET status = 'approved', decided_by = 'you' WHERE id = ?").run(action.approvalId);
    db.query("UPDATE mail_actions SET status = 'sending' WHERE id = ?").run(action.id);
    const leftover = join(home.home, "mail-outgoing", action.id);
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, "lease.pdf"), "x");
    expect(recoverMailActions(db)).toBe(1);
    expect(existsSync(join(home.home, "mail-outgoing"))).toBe(false);
    expect(getMailAction(db, action.id)!.status).toBe("failed");
    expect(pendingMailActions(db)[0]!.error).toBe(STOPPED_COPY);
    expect(sends()).toEqual([]);
  });
});

describe("save as draft", () => {
  test("puts the message in Gmail Drafts, threaded, sends nothing, and closes the card", async () => {
    await connectGoogle();
    const task = createTask(db, { spaceId: space(), title: "Reply to Robin" });
    const { action } = draftMail(db, { spaceId: space(), taskId: task.id, kind: "reply", draftedBy: "claude", threadId: lease().id, body: "Draft words" });
    const saved = await mail.actions.saveDraft(action.id, { accountId: google().id, to: action.to, cc: [], subject: "", body: "Finished on my phone" });
    expect(saved.status).toBe("saved");
    const w = fakes.google.writes.filter((x) => x.path.endsWith("/drafts"));
    expect(w).toHaveLength(1);
    expect((w[0]!.body.message as { threadId?: string }).threadId).toBe("gt-lease");
    expect(sends()).toEqual([]);
    expect(getApproval(db, action.approvalId)).toMatchObject({ status: "rejected", note: "Saved to drafts instead of sending." });
    expect(getTask(db, task.id)!.outcomeReason).toContain("Gmail Drafts");
  });
});

describe("calendar changes", () => {
  const hour = 3600_000;
  test("an event without guests is created quietly; with guests the invites go out", async () => {
    await connectGoogle();
    const cal = listCalendars(db)[0]!.id;
    const quiet = draftEvent(db, { spaceId: space(), kind: "event_create", draftedBy: "you", calendarId: cal, title: "Focus", start: NOW + hour, end: NOW + 2 * hour });
    expect(quiet.approval.title).toBe('Create "Focus"?');
    await pressSend(quiet.action);
    const lunch = draftEvent(db, { spaceId: space(), kind: "event_create", draftedBy: "claude", calendarId: cal, title: "Lunch with Priya", start: NOW + 3 * hour, end: NOW + 4 * hour, location: "Cafe", attendees: [{ name: "Priya", address: "priya@example.org" }] });
    expect(lunch.approval.title).toBe('Create "Lunch with Priya" and invite Priya <priya@example.org>?');
    expect(lunch.action.event!.attendees).toEqual([{ name: "Priya", address: "priya@example.org", added: true }]);
    expect(lunch.action.reasons).toEqual([{ kind: "first_time", key: "first_time:priya@example.org", text: "first time inviting Priya <priya@example.org>" }]);
    await pressSend(lunch.action);
    const posts = fakes.google.writes.filter((w) => w.method === "POST" && w.path.includes("/events"));
    expect(posts.map((p) => p.sendUpdates)).toEqual(["none", "all"]);
    expect(posts[1]!.body).toMatchObject({ summary: "Lunch with Priya", location: "Cafe", attendees: [{ email: "priya@example.org", displayName: "Priya" }] });
  });

  test("moving or cancelling an event you own tells guests only when the card says so", async () => {
    await connectGoogle();
    const own = listEvents(db, NOW - 30 * 86_400_000, NOW + 30 * 86_400_000).find((e) => e.title === "Day off")!;
    const move = draftEvent(db, { spaceId: space(), kind: "event_move", draftedBy: "you", eventId: own.id, start: own.start + 86_400_000 });
    expect(move.action.event!.notify).toBe(false);
    await pressSend(move.action);
    const cancel = draftEvent(db, { spaceId: space(), kind: "event_cancel", draftedBy: "you", eventId: own.id });
    await pressSend(cancel.action);
    expect(fakes.google.writes.map((w) => [w.method, w.sendUpdates])).toEqual([
      ["PATCH", "none"],
      ["DELETE", "none"],
    ]);
    // Someone else's invite can't be moved.
    const theirs = listEvents(db, NOW - 30 * 86_400_000, NOW + 30 * 86_400_000).find((e) => e.title === "Planning with Kit")!;
    expect(() => draftEvent(db, { spaceId: space(), kind: "event_move", draftedBy: "you", eventId: theirs.id, start: NOW })).toThrow("Only the organizer");
  });

  test("one occurrence of a repeating event can't be moved or cancelled, by Claude or anyone", async () => {
    await connectGoogle();
    const cal = listCalendars(db)[0]!.id;
    replaceEvents(db, cal, [{ sourceId: "abc_20261113T150000Z", icalUid: "abc", recurrenceId: "1794582000000", title: "Weekly sync", start: NOW + 86_400_000, end: NOW + 90_000_000, allDay: false, location: "", attendees: [{ name: "Kit", address: "kit@example.org", status: null }], organizer: SAM, myStatus: "accepted", recurrence: "series:abc" }], NOW, NOW + 2 * 86_400_000);
    const weekly = listEvents(db, NOW, NOW + 2 * 86_400_000).find((e) => e.title === "Weekly sync")!;
    for (const kind of ["event_cancel", "event_move"] as const) {
      expect(() => draftEvent(db, { spaceId: space(), kind, draftedBy: "claude", eventId: weekly.id, start: NOW })).toThrow("Change repeating events in Google Calendar.");
    }
    expect(pendingMailActions(db)).toEqual([]);
  });

  test("RSVP answers through Google and tells the organizer; a Calendar.app invite is answered in Calendar", async () => {
    await connectGoogle();
    const invite = listEvents(db, NOW - 30 * 86_400_000, NOW + 30 * 86_400_000).find((e) => e.title === "Planning with Kit")!;
    await mail.actions.rsvp(invite.id, "declined", "Out that day");
    const w = fakes.google.writes.at(-1)!;
    expect(w).toMatchObject({ method: "PATCH", sendUpdates: "all" });
    expect((w.body.attendees as { email: string; responseStatus: string; comment?: string }[]).find((a) => a.email === SAM)).toMatchObject({ responseStatus: "declined", comment: "Out that day" });
    expect(listEvents(db, NOW - 30 * 86_400_000, NOW + 30 * 86_400_000).find((e) => e.id === invite.id)!.myStatus).toBe("declined");

    mail.sync.appleOnNow("calendar");
    await mail.sync.syncNow();
    const dentist = listEvents(db, NOW - 30 * 86_400_000, NOW + 30 * 86_400_000).find((e) => e.title === "Dentist")!;
    expect(mail.actions.rsvp(dentist.id, "accepted", "")).rejects.toThrow(NO_RSVP_COPY);
  });

  test("Calendar.app events are changed in Calendar, not from Atrium", async () => {
    mail.sync.appleOnNow("mail");
    mail.sync.appleOnNow("calendar");
    await mail.sync.syncNow();
    const dentist = listEvents(db, NOW - 30 * 86_400_000, NOW + 30 * 86_400_000).find((e) => e.title === "Dentist")!;
    for (const kind of ["event_move", "event_cancel"] as const) expect(() => draftEvent(db, { spaceId: space(), kind, draftedBy: "you", eventId: dentist.id, start: NOW })).toThrow(APPLE_EVENT_COPY);
  });

  test("a Calendar.app calendar takes events without guests, and says plainly it can't invite", async () => {
    mail.sync.appleOnNow("calendar");
    await mail.sync.syncNow();
    const home = listCalendars(db).find((c) => c.title === "Home")!;
    const sid = space();
    const solo = draftEvent(db, { spaceId: sid, kind: "event_create", draftedBy: "you", calendarId: home.id, title: "Haircut", start: NOW + 3600_000, end: NOW + 7200_000 });
    expect((await pressSend(solo.action)).status).toBe("sent");
    expect(fakes.pimWrites().map((w) => w.cmd)).toEqual(["cal.create"]);
    const guests = draftEvent(db, { spaceId: sid, kind: "event_create", draftedBy: "you", calendarId: home.id, title: "Dinner", start: NOW + 3600_000, end: NOW + 7200_000, attendees: [{ name: "", address: "kit@example.org" }] });
    expect((await pressSend(guests.action)).error).toBe(NO_GUESTS_COPY);
  });
});
