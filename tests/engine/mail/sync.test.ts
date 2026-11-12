import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
    expect(first.attachments).toEqual([{ name: "tickets.pdf", size: 2048 }]);
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
