import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { normalizeSubject, parseAddressList } from "../../../src/engine/mail/addresses";
import {
  activeAccounts,
  getAccount,
  ingestMessages,
  listAccounts,
  listCalendars,
  listEvents,
  listThreads,
  needsReply,
  removeAccount,
  replaceEvents,
  setPreferred,
  threadMessages,
  upsertAccount,
  upsertCalendar,
  updateAccount,
} from "../../../src/engine/mail/store";
import { canonicalRecurrence } from "../../../src/engine/mail/recurrence";
import type { SourceEvent } from "../../../src/engine/mail/types";
import { msg, SAM, T0 } from "./helpers";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});



describe("addresses", () => {
  test("parses quoted names with commas and normalises case", () => {
    expect(parseAddressList('"Vale, Robin" <Robin@Example.net>, sam@EXAMPLE.com')).toEqual([
      { name: "Vale, Robin", address: "robin@example.net" },
      { name: "", address: "sam@example.com" },
    ]);
  });
  test("strips reply and forward prefixes", () => {
    expect(normalizeSubject("Re: FWD: re[2]: Lease  renewal")).toBe("lease renewal");
  });
});

describe("accounts and crossovers", () => {
  test("the first row for an address is preferred; Google takes over from Mail.app by default", () => {
    const apple = upsertAccount(db, { address: "Sam@Example.com", name: "Sam", source: "apple", ref: "acct-1" });
    expect(apple.preferred).toBe(true);
    expect(apple.address).toBe(SAM);
    const google = upsertAccount(db, { address: SAM, name: "", source: "google", ref: null });
    expect(google.preferred).toBe(true);
    expect(getAccount(db, apple.id)!.preferred).toBe(false);
    expect(activeAccounts(db).map((a) => a.id)).toEqual([google.id]);
    // Both rows share the address's colour.
    expect(google.color).toBe(apple.color);
  });

  test("a user's switch to Mail.app sticks, and the other source's cached mail goes", () => {
    const google = upsertAccount(db, { address: SAM, name: "", source: "google", ref: null });
    const apple = upsertAccount(db, { address: SAM, name: "", source: "apple", ref: "acct-1" });
    expect(apple.preferred).toBe(false);
    ingestMessages(db, google, [msg({ sourceId: "g1", threadKey: "t1", messageId: "<a@x>" })]);
    setPreferred(db, apple.id);
    expect(listThreads(db)).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM mail_messages").get()).toEqual({ n: 0 });
    // Reconnecting Google later doesn't override the choice.
    removeAccount(db, google.id);
    const again = upsertAccount(db, { address: SAM, name: "", source: "google", ref: null });
    expect(again.preferred).toBe(false);
    expect(getAccount(db, apple.id)!.preferred).toBe(true);
  });

  test("the same message from Google and from Mail.app shows once", () => {
    const google = upsertAccount(db, { address: SAM, name: "", source: "google", ref: null });
    const apple = upsertAccount(db, { address: SAM, name: "", source: "apple", ref: "acct-1" });
    const m = { messageId: "<lease-1@example.net>", subject: "Lease renewal" };
    ingestMessages(db, google, [msg({ sourceId: "g1", threadKey: "gt1", ...m })]);
    ingestMessages(db, apple, [msg({ sourceId: "apple-9", ...m })]);
    const threads = listThreads(db);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.account.id).toBe(google.id);
    expect(threadMessages(db, threads[0]!.id)).toHaveLength(1);
  });

  test("reading the same message twice updates it rather than adding another", () => {
    const a = upsertAccount(db, { address: SAM, name: "", source: "google", ref: null });
    ingestMessages(db, a, [msg({ sourceId: "g1", threadKey: "t", messageId: "<a@x>", unread: true })]);
    ingestMessages(db, a, [msg({ sourceId: "g1", threadKey: "t", messageId: "<a@x>", unread: false })]);
    const [t] = listThreads(db);
    expect(t!.count).toBe(1);
    expect(t!.unread).toBe(0);
  });

  test("removing the preferred row hands the address to its other row", () => {
    const google = upsertAccount(db, { address: SAM, name: "", source: "google", ref: null });
    const apple = upsertAccount(db, { address: SAM, name: "", source: "apple", ref: "acct-1" });
    removeAccount(db, google.id);
    expect(listAccounts(db).map((a) => [a.id, a.preferred])).toEqual([[apple.id, true]]);
  });
});

describe("threading from headers", () => {
  const apple = () => upsertAccount(db, { address: SAM, name: "", source: "apple", ref: "acct-1" });

  test("a reply joins its parent through In-Reply-To and References", () => {
    const a = apple();
    ingestMessages(db, a, [
      msg({ sourceId: "1", messageId: "<root@x>", date: T0 }),
      msg({ sourceId: "2", messageId: "<r1@x>", inReplyTo: "<root@x>", references: ["<root@x>"], subject: "Re: Lease renewal", from: { name: "Sam", address: SAM }, to: [{ name: "", address: "robin@example.net" }], date: T0 + 1000 }),
      msg({ sourceId: "3", messageId: "<r2@x>", inReplyTo: "<r1@x>", references: ["<root@x>", "<r1@x>"], subject: "Re: Lease renewal", date: T0 + 2000 }),
    ]);
    const threads = listThreads(db);
    expect(threads).toHaveLength(1);
    expect(threadMessages(db, threads[0]!.id).map((m) => m.sourceId)).toEqual(["1", "2", "3"]);
    expect(threads[0]!.participants).toEqual([{ name: "Robin Vale", address: "robin@example.net" }]);
  });

  test("a reply read before its parent still lands in one thread", () => {
    const a = apple();
    ingestMessages(db, a, [msg({ sourceId: "2", messageId: "<r1@x>", inReplyTo: "<root@x>", references: ["<root@x>"], subject: "Re: Lease renewal", date: T0 + 1000 })]);
    ingestMessages(db, a, [msg({ sourceId: "1", messageId: "<root@x>", date: T0 })]);
    expect(listThreads(db)).toHaveLength(1);
  });

  test("a reply with no headers joins by subject only when the people match", () => {
    const a = apple();
    ingestMessages(db, a, [msg({ sourceId: "1", messageId: "<root@x>", date: T0 })]);
    ingestMessages(db, a, [msg({ sourceId: "2", messageId: "<r@x>", subject: "RE: Lease renewal", date: T0 + 1000 })]);
    expect(listThreads(db)).toHaveLength(1);
    ingestMessages(db, a, [msg({ sourceId: "3", messageId: "<other@x>", subject: "Re: Lease renewal", from: { name: "Kit", address: "kit@example.org" }, date: T0 + 2000 })]);
    expect(listThreads(db)).toHaveLength(2);
    // Two separate first messages with the same subject stay apart.
    ingestMessages(db, a, [msg({ sourceId: "4", messageId: "<new@x>", subject: "Lease renewal", date: T0 + 3000 })]);
    expect(listThreads(db)).toHaveLength(3);
  });

  test("a Message-ID with LIKE wildcards in it only matches itself", () => {
    const a = apple();
    ingestMessages(db, a, [
      msg({ sourceId: "x", messageId: "<CAxyy@mail.example.com>", subject: "Other", from: { name: "", address: "x@example.net" } }),
      msg({ sourceId: "y", messageId: "<late@x>", references: ["<CAxyy@mail.example.com>"], subject: "Re: Other", from: { name: "", address: "x@example.net" }, date: T0 + 1 }),
    ]);
    // A message whose own id differs only where "_" would be a LIKE wildcard joins nothing.
    ingestMessages(db, a, [msg({ sourceId: "z", messageId: "<CA_yy@mail.example.com>", subject: "Separate", date: T0 + 2 })]);
    expect(listThreads(db).map((t) => t.subject).sort()).toEqual(["Other", "Separate"]);
  });

  test("Gmail's threadId wins over the headers", () => {
    const g = upsertAccount(db, { address: SAM, name: "", source: "google", ref: null });
    ingestMessages(db, g, [msg({ sourceId: "1", threadKey: "A", messageId: "<root@x>" }), msg({ sourceId: "2", threadKey: "B", messageId: "<r@x>", inReplyTo: "<root@x>" })]);
    expect(listThreads(db)).toHaveLength(2);
  });
});

describe("needs a reply", () => {
  test("direct mail from a person needs a reply; lists, robots and his own mail don't", () => {
    const person = { from: { name: "Robin", address: "robin@example.net" }, to: [{ name: "", address: SAM }], labels: [] };
    expect(needsReply(SAM, person)).toBe(true);
    expect(needsReply(SAM, { ...person, from: { name: "", address: "no-reply@shop.example.com" } })).toBe(false);
    expect(needsReply(SAM, { ...person, labels: ["CATEGORY_PROMOTIONS"] })).toBe(false);
    expect(needsReply(SAM, { ...person, to: [{ name: "", address: "team@example.net" }] })).toBe(false);
    expect(needsReply(SAM, { ...person, from: { name: "", address: SAM } })).toBe(false);
  });

  test("the Inbox filters on it", () => {
    const a = upsertAccount(db, { address: SAM, name: "", source: "google", ref: null });
    ingestMessages(db, a, [msg({ sourceId: "1", threadKey: "A" }), msg({ sourceId: "2", threadKey: "B", from: { name: "", address: "updates@shop.example.com" } })]);
    expect(listThreads(db, { filter: "needs_reply" }).map((t) => t.snippet)).toHaveLength(1);
  });
});

describe("calendar", () => {
  const ev = (over: Partial<SourceEvent> = {}): SourceEvent => ({
    sourceId: "e1",
    icalUid: "uid-1@example.com",
    recurrenceId: null,
    title: "Lunch with Priya",
    start: T0,
    end: T0 + 3600_000,
    allDay: false,
    location: "",
    attendees: [],
    organizer: null,
    myStatus: null,
    recurrence: null,
    ...over,
  });

  test("the same event from Google and from Calendar.app shows once", () => {
    const g = upsertAccount(db, { address: SAM, name: "", source: "google", ref: null });
    const gc = upsertCalendar(db, "google", { sourceId: SAM, title: "Sam", color: "#5e9fe0", writable: true, accountAddress: SAM }, g.id);
    const ac = upsertCalendar(db, "apple", { sourceId: "apple-cal-1", title: "Work", color: "#d9825b", writable: true, accountAddress: null }, null);
    replaceEvents(db, gc, [ev({ sourceId: "g-e1" })], T0 - 1, T0 + 1e9);
    replaceEvents(db, ac, [ev({ sourceId: "a-e1" })], T0 - 1, T0 + 1e9);
    const events = listEvents(db, T0 - 1, T0 + 1e9);
    expect(events).toHaveLength(1);
    expect(events[0]!.calendar.source).toBe("google");
  });

  test("an Apple calendar that syncs from a Google-preferred address is hidden; recurring instances stay apart", () => {
    upsertAccount(db, { address: SAM, name: "", source: "google", ref: null });
    const ac = upsertCalendar(db, "apple", { sourceId: "apple-cal-2", title: "Sam (Google)", color: "#d9825b", writable: true, accountAddress: "SAM@example.com" }, null);
    expect(listCalendars(db).find((c) => c.id === ac)!.hidden).toBe("Google reads this calendar directly.");
    const other = upsertCalendar(db, "apple", { sourceId: "apple-cal-3", title: "Home", color: "#4cb782", writable: true, accountAddress: null }, null);
    replaceEvents(db, other, [ev({ recurrenceId: "2026-11-02T15:00:00Z" }), ev({ sourceId: "e2", recurrenceId: "2026-11-09T15:00:00Z", start: T0 + 7 * 864e5, end: T0 + 7 * 864e5 + 1 })], T0 - 1, T0 + 1e10);
    expect(listEvents(db, T0 - 1, T0 + 1e10)).toHaveLength(2);
  });

  test("a sync drops events that left the window's source list", () => {
    const ac = upsertCalendar(db, "apple", { sourceId: "c", title: "Home", color: "#4cb782", writable: true, accountAddress: null }, null);
    replaceEvents(db, ac, [ev(), ev({ icalUid: "uid-2", sourceId: "e2" })], T0 - 1, T0 + 1e9);
    replaceEvents(db, ac, [ev()], T0 - 1, T0 + 1e9);
    expect(listEvents(db, T0 - 1, T0 + 1e9).map((e) => e.title)).toEqual(["Lunch with Priya"]);
  });

  test("hiding a Google account keeps its Calendar.app copy hidden, and says it's hidden", () => {
    const g = upsertAccount(db, { address: SAM, name: "", source: "google", ref: null });
    const gc = upsertCalendar(db, "google", { sourceId: SAM, title: "Sam", color: "#5e9fe0", writable: true, accountAddress: SAM }, g.id);
    const ac = upsertCalendar(db, "apple", { sourceId: "apple-cal-9", title: "Sam (Google)", color: "#d9825b", writable: true, accountAddress: SAM }, null);
    updateAccount(db, g.id, { enabled: false });
    const cals = listCalendars(db);
    expect(cals.find((c) => c.id === gc)!.hidden).toBe("Its account is hidden.");
    expect(cals.find((c) => c.id === ac)!.hidden).toBe("Google reads this calendar directly.");
  });

  test("occurrence ids from both sources come out the same", () => {
    expect(canonicalRecurrence("2026-11-12T10:00:00-05:00")).toBe(canonicalRecurrence("2026-11-12T15:00:00Z"));
    expect(canonicalRecurrence("2026-11-12")).toBe(String(new Date("2026-11-12T00:00:00").getTime()));
    expect(canonicalRecurrence(null)).toBeNull();
  });
});
