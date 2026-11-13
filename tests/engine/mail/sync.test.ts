import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { appleAccounts, appleSource } from "../../../src/engine/mail/apple";
import { PIM_COPY } from "../../../src/engine/mail/pim";
import { listAccounts, listEvents, listThreads, threadMessages } from "../../../src/engine/mail/store";
import { appleProblem, createMailSync } from "../../../src/engine/mail/sync";
import type { MailSource } from "../../../src/engine/mail/types";
import { tempHome } from "../../helpers";
import { useFakes } from "./fakes";
import { T0 } from "./helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let fakes: ReturnType<typeof useFakes>;
const NOW = T0 + 5 * 86_400_000;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  fakes = useFakes();
});
afterEach(() => {
  delete process.env.FAKE_PIM_MODE;
  fakes.undo();
  db.close();
  home.cleanup();
});

// A source that counts its calls and returns nothing.
function counting(): MailSource & { calls: number } {
  const s = {
    kind: "apple" as const,
    calls: 0,
    async messages() {
      s.calls++;
      return { messages: [], versions: {} };
    },
    body: async () => ({ text: "", html: null, attachments: [] }),
    attachment: async () => "",
    async calendars() {
      s.calls++;
      return [];
    },
    events: async () => [],
  };
  return s;
}

const appleSync = () => createMailSync({ db, google: counting(), apple: appleSource(), appleAccounts, now: () => NOW });

describe("Apple ingest through the helper", () => {
  test("Mail.app accounts, threads built from headers, and Calendar.app events", async () => {
    const s = appleSync();
    s.appleOnNow("mail");
    s.appleOnNow("calendar");
    await s.syncNow();
    expect(listAccounts(db).map((a) => a.address).sort()).toEqual(["sam.rivera@example.org", "sam@example.com"]);
    const trip = listThreads(db).find((t) => t.subject === "Trip plan")!;
    expect(trip.count).toBe(2);
    expect(trip.unread).toBe(1);
    const first = threadMessages(db, trip.id)[0]!;
    expect(first.attachments).toEqual([{ name: "tickets.pdf", size: 2048, openable: true }]);
    await s.fetchBodies([first.id]);
    expect(threadMessages(db, trip.id)[0]!.body).toBe("Train at 9?");
    // No Google here, so Calendar.app's copy of the Google calendar is the one shown; the duplicate invite shows once.
    const events = listEvents(db, NOW - 30 * 86_400_000, NOW + 90 * 86_400_000).map((e) => e.title).sort();
    expect(events).toEqual(["Dentist", "Planning with Kit"]);
  });

  test("Mail permission off is a plain problem, and calendars still sync", async () => {
    process.env.FAKE_PIM_MODE = "mail_denied";
    const s = appleSync();
    s.appleOnNow("mail");
    s.appleOnNow("calendar");
    await s.syncNow();
    expect(appleProblem(db, "mail")).toBe(PIM_COPY.automation_denied);
    expect(appleProblem(db, "calendar")).toBeNull();
    expect(listEvents(db, NOW - 30 * 86_400_000, NOW + 90 * 86_400_000).length).toBe(2);
  });

  test("a missing helper says to run atrium app install", async () => {
    process.env.ATRIUM_PIM_BIN = "/nonexistent/atrium-pim";
    try {
      const s = appleSync();
      s.appleOnNow("calendar");
      await s.syncNow();
      expect(appleProblem(db, "calendar")).toBe(PIM_COPY.not_installed);
    } finally {
      delete process.env.ATRIUM_PIM_BIN;
      process.env.ATRIUM_PIM_BIN = `${import.meta.dir}/../../fixtures/fake-pim.ts`;
    }
  });

  test("turning Mail.app off forgets its accounts and their mail", async () => {
    const s = appleSync();
    s.appleOnNow("mail");
    await s.syncNow();
    s.appleOff("mail");
    expect(listAccounts(db)).toEqual([]);
    expect(listThreads(db)).toEqual([]);
  });
});

describe("Apple Mail details", () => {
  test("a helper answering without its list gets the plain copy, not a JavaScript error", async () => {
    process.env.FAKE_PIM_MODE = "malformed";
    const s = appleSync();
    s.appleOnNow("mail");
    await s.syncNow();
    expect(appleProblem(db, "mail")).toBe(PIM_COPY.other);
  });

  test("an account removed from Mail.app is removed here too, with its mail", async () => {
    const s = appleSync();
    s.appleOnNow("mail");
    await s.syncNow();
    expect(listThreads(db).map((t) => t.subject)).toContain("Trip plan");
    const data = JSON.parse(readFileSync(fakes.pimFile, "utf8"));
    data.accounts = data.accounts.filter((a: { id: string }) => a.id !== "acct-icloud");
    writeFileSync(fakes.pimFile, JSON.stringify(data));
    await s.syncNow();
    expect(listAccounts(db).map((a) => a.address)).toEqual(["sam@example.com"]);
    expect(listThreads(db).map((t) => t.subject)).not.toContain("Trip plan");
  });

  test("an empty account list from Mail.app removes nothing", async () => {
    const s = appleSync();
    s.appleOnNow("mail");
    await s.syncNow();
    const data = JSON.parse(readFileSync(fakes.pimFile, "utf8"));
    writeFileSync(fakes.pimFile, JSON.stringify({ ...data, accounts: [] }));
    await s.syncNow();
    expect(listThreads(db).map((t) => t.subject)).toContain("Trip plan");
  });

  test("the listing has no snippets; a fetched body supplies one, and encoded sender names are decoded", async () => {
    const data = JSON.parse(readFileSync(fakes.pimFile, "utf8"));
    data.messages["acct-icloud"][0].from = "=?UTF-8?Q?Ren=C3=A9e?= Moreno <kit@example.org>";
    data.messages["acct-icloud"][0].subject = "=?ISO-8859-1?Q?Caf=E9?= plan";
    writeFileSync(fakes.pimFile, JSON.stringify(data));
    const s = appleSync();
    s.appleOnNow("mail");
    await s.syncNow();
    const trip = listThreads(db).find((t) => t.subject === "Café plan")!;
    const first = threadMessages(db, trip.id)[0]!;
    expect(first.from.name).toBe("Renée Moreno");
    expect(first.snippet).toBe("");
    await s.fetchBodies([first.id]);
    expect(threadMessages(db, trip.id)[0]!.snippet).toBe("Train at 9?");
  });

  test("Sent keeps its own limit however busy the Inbox is", async () => {
    const data = JSON.parse(readFileSync(fakes.pimFile, "utf8"));
    const at = (i: number) => new Date(T0 + i * 60_000).toISOString();
    data.messages["acct-icloud"] = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `in${i}`, messageId: `<in${i}@x>`, inReplyTo: null, references: null, subject: `In ${i}`, from: "Kit <kit@example.org>", to: "sam.rivera@example.org", cc: "", date: at(10 + i), read: true, snippet: "x", attachments: [] })),
      { id: "out", mailbox: "Sent", messageId: "<out@x>", inReplyTo: null, references: null, subject: "Out", from: "Sam <sam.rivera@example.org>", to: "kit@example.org", cc: "", date: at(0), read: true, snippet: "x", attachments: [] },
    ];
    writeFileSync(fakes.pimFile, JSON.stringify(data));
    process.env.FAKE_PIM_INBOX_LIMIT = "3";
    try {
      const s = appleSync();
      s.appleOnNow("mail");
      await s.syncNow();
      const subjects = listThreads(db).map((t) => t.subject);
      expect(subjects).toContain("Out");
      expect(subjects.filter((x) => x.startsWith("In ")).sort()).toEqual(["In 2", "In 3", "In 4"]);
    } finally {
      delete process.env.FAKE_PIM_INBOX_LIMIT;
    }
  });
});

describe("when sync runs", () => {
  test("an empty home syncs nothing and asks no source anything", async () => {
    const google = counting();
    const apple = counting();
    const s = createMailSync({ db, google, apple, appleAccounts: async () => [], intervalMs: 10 });
    await s.syncNow();
    s.setClients(1);
    await Bun.sleep(40);
    s.setClients(0);
    expect(google.calls + apple.calls).toBe(0);
    expect(listThreads(db)).toEqual([]);
  });

  test("the timer runs only while a client is connected", async () => {
    const apple = counting();
    const s = createMailSync({ db, google: counting(), apple, appleAccounts: async () => [], intervalMs: 20 });
    s.appleOnNow("calendar");
    expect(s.timerRunning()).toBe(false);
    s.setClients(2);
    expect(s.timerRunning()).toBe(true);
    await Bun.sleep(90);
    const whileOpen = apple.calls;
    expect(whileOpen).toBeGreaterThanOrEqual(2);
    s.setClients(0);
    expect(s.timerRunning()).toBe(false);
    await Bun.sleep(80);
    expect(apple.calls).toBe(whileOpen);
  });

  test("opening the Inbox syncs once, not again within a minute", async () => {
    const apple = counting();
    const s = createMailSync({ db, google: counting(), apple, appleAccounts: async () => [] });
    s.appleOnNow("calendar");
    s.onOpen();
    await s.syncNow();
    s.onOpen();
    await s.syncNow().catch(() => {});
    // The second syncNow above is the explicit one; onOpen itself added nothing.
    expect(apple.calls).toBe(2);
  });
});

describe("bodies", () => {
  // A source whose body() is slow, counts its calls and can be made to fail.
  function slowBodies() {
    const s = { ...counting(), calls: 0, concurrent: 0, peak: 0, fail: false };
    s.body = async () => {
      s.calls++;
      s.concurrent++;
      s.peak = Math.max(s.peak, s.concurrent);
      await Bun.sleep(20);
      s.concurrent--;
      if (s.fail) throw new Error("Mail isn't open.");
      return { text: "hello", html: null, attachments: [] };
    };
    return s;
  }
  async function seeded(n: number) {
    const { upsertAccount, ingestMessages } = await import("../../../src/engine/mail/store");
    const a = upsertAccount(db, { address: "sam.rivera@example.org", name: "", source: "apple", ref: "acct" });
    const { msg } = await import("./helpers");
    ingestMessages(db, a, Array.from({ length: n }, (_, i) => msg({ sourceId: `b${i}`, messageId: `<b${i}@x>`, subject: `S${i}`, date: T0 + i })));
    return listThreads(db).flatMap((t) => threadMessages(db, t.id).map((m) => m.id));
  }

  test("a body being fetched is joined, not fetched twice, and three are fetched at a time", async () => {
    const apple = slowBodies();
    const s = createMailSync({ db, google: counting(), apple, appleAccounts: async () => [], now: () => NOW });
    const ids = await seeded(7);
    await Promise.all([s.fetchBodies(ids), s.fetchBodies(ids), s.fetchBodies([ids[0]!])]);
    expect(apple.calls).toBe(7);
    expect(apple.peak).toBe(3);
    // Cached now: nothing more is fetched.
    await s.fetchBodies(ids);
    expect(apple.calls).toBe(7);
  });

  test("a failed body waits ten minutes before it's tried again, unless the user retries", async () => {
    const apple = slowBodies();
    apple.fail = true;
    let clock = NOW;
    const s = createMailSync({ db, google: counting(), apple, appleAccounts: async () => [], now: () => clock });
    const ids = await seeded(1);
    expect(await s.fetchBodies(ids)).toBe("Mail isn't open.");
    expect(s.bodyState(ids)).toEqual({ loading: false, problem: "Mail isn't open." });
    await s.fetchBodies(ids);
    expect(apple.calls).toBe(1);
    clock += 9 * 60_000;
    await s.fetchBodies(ids);
    expect(apple.calls).toBe(1);
    await s.fetchBodies(ids, { retry: true });
    expect(apple.calls).toBe(2);
    apple.fail = false;
    clock += 11 * 60_000;
    expect(await s.fetchBodies(ids)).toBeNull();
    expect(apple.calls).toBe(3);
    expect(s.bodyState(ids)).toEqual({ loading: false, problem: null });
  });
});

describe("doctor", () => {
  test("a denied permission is reported plainly, with where to turn it on", async () => {
    const { mailReport } = await import("../../../src/engine/mail/report");
    process.env.FAKE_PIM_MODE = "calendar_denied";
    const s = appleSync();
    s.appleOnNow("calendar");
    await s.syncNow();
    const line = mailReport(db).sources.find((x) => x.id === "apple_calendar")!;
    expect(line).toMatchObject({ ready: false, message: "Permission is off. Turn it on in System Settings › Privacy & Security › Calendars, then sync again." });
  });
});
