import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGoogleEnv, type FakeData, startFakeGoogle } from "../../fixtures/fake-google";
import { SAM, T0 } from "./helpers";

export const FAKE_SECURITY = join(import.meta.dir, "..", "..", "fixtures", "fake-security.ts");
export const CLIENT_ID = "test-client.apps.googleusercontent.com";

// Made-up mail and calendar for sam@example.com: a two-message lease thread, a newsletter, one calendar with a
// meeting that Calendar.app also has.
export function googleData(): FakeData {
  return {
    [SAM]: {
      threads: [
        {
          id: "gt-lease",
          historyId: "100",
          messages: [
            { id: "gm-1", threadId: "gt-lease", from: "Robin Vale <robin@example.net>", to: SAM, subject: "Lease renewal", date: T0, messageId: "<lease-1@example.net>", text: "Hi Sam, the lease renews on Dec 1. Rent stays the same." },
            {
              id: "gm-2",
              threadId: "gt-lease",
              from: `Sam Rivera <${SAM}>`,
              to: "robin@example.net",
              subject: "Re: Lease renewal",
              date: T0 + 3600_000,
              messageId: "<lease-2@example.com>",
              inReplyTo: "<lease-1@example.net>",
              references: "<lease-1@example.net>",
              text: "Thanks! Can we sign Thursday?\n\nOn Mon, Robin wrote:\n> Hi Sam, the lease renews on Dec 1.",
              attachments: [{ name: "lease.pdf", size: 15, data: "%PDF-1.4 fake" }],
            },
          ],
        },
        {
          id: "gt-news",
          historyId: "200",
          messages: [{ id: "gm-3", threadId: "gt-news", from: "Shop <updates@shop.example.com>", to: SAM, subject: "This week's deals", date: T0 + 7200_000, messageId: "<deal@shop.example.com>", html: "<p>Deals!</p><img src='https://shop.example.com/p.gif'>", labels: ["INBOX", "CATEGORY_PROMOTIONS", "UNREAD"] }],
        },
      ],
      calendars: [{ id: SAM, summary: "Sam", backgroundColor: "#5e9fe0" }],
      events: {
        [SAM]: [
          {
            id: "ge-1",
            iCalUID: "standup-1@example.com",
            summary: "Planning with Kit",
            start: { dateTime: new Date(T0 + 86_400_000).toISOString() },
            end: { dateTime: new Date(T0 + 86_400_000 + 1800_000).toISOString() },
            attendees: [
              { email: SAM, self: true, responseStatus: "accepted" },
              { email: "kit@example.org", displayName: "Kit Moreno", responseStatus: "needsAction" },
            ],
            organizer: { email: "kit@example.org" },
          },
          { id: "ge-2", iCalUID: "holiday@example.com", summary: "Day off", start: { date: "2026-11-05" }, end: { date: "2026-11-06" } },
          { id: "ge-3", iCalUID: "gone@example.com", summary: "Cancelled thing", status: "cancelled", start: { dateTime: new Date(T0).toISOString() }, end: { dateTime: new Date(T0 + 1).toISOString() } },
        ],
      },
    },
  };
}

// Mail.app with the same Gmail address plus an iCloud one; Calendar.app with the same Google calendar and a home one.
export function pimData() {
  return {
    accounts: [
      { id: "acct-gmail", name: "Google", addresses: [SAM], fullName: "Sam Rivera" },
      { id: "acct-icloud", name: "iCloud", addresses: ["sam.rivera@example.org"], fullName: "Sam Rivera" },
    ],
    messages: {
      "acct-gmail": [
        { id: "ap-1", messageId: "<lease-1@example.net>", inReplyTo: null, references: null, subject: "Lease renewal", from: "Robin Vale <robin@example.net>", to: SAM, cc: "", date: new Date(T0).toISOString(), read: true, snippet: "Hi Sam", attachments: [] },
      ],
      "acct-icloud": [
        { id: "ap-2", messageId: "<trip-1@example.org>", inReplyTo: null, references: null, subject: "Trip plan", from: "Kit Moreno <kit@example.org>", to: "sam.rivera@example.org", cc: "", date: new Date(T0).toISOString(), read: false, snippet: "Train at 9?", attachments: [{ name: "tickets.pdf", size: 2048 }] },
        { id: "ap-3", messageId: "<trip-2@example.org>", inReplyTo: "<trip-1@example.org>", references: "<trip-1@example.org>", subject: "Re: Trip plan", from: "Sam Rivera <sam.rivera@example.org>", to: "kit@example.org", cc: "", date: new Date(T0 + 60_000).toISOString(), read: true, snippet: "Yes", attachments: [] },
      ],
    },
    bodies: { "ap-2": { text: null, html: "<p>Train at 9?</p>", attachments: [{ name: "tickets.pdf", size: 2048 }] } },
    calendars: [
      { id: "cal-google", title: "Sam", color: "#5e9fe0", writable: true, source: "Google", account: SAM },
      { id: "cal-home", title: "Home", color: "#4cb782", writable: true, source: "iCloud", account: null },
    ],
    events: {
      "cal-google": [{ id: "ae-1", icalUid: "standup-1@example.com", recurrenceId: null, title: "Planning with Kit", start: new Date(T0 + 86_400_000).toISOString(), end: new Date(T0 + 86_400_000 + 1800_000).toISOString(), allDay: false, location: "", attendees: [], organizer: null, myStatus: null, recurrence: null }],
      "cal-home": [
        { id: "ae-2", icalUid: "dentist@example.org", recurrenceId: null, title: "Dentist", start: new Date(T0 + 2 * 86_400_000).toISOString(), end: new Date(T0 + 2 * 86_400_000 + 3600_000).toISOString(), allDay: false, location: "Main St", attendees: [], organizer: null, myStatus: null, recurrence: null },
        // The same invite also on the home calendar: still one event.
        { id: "ae-3", icalUid: "standup-1@example.com", recurrenceId: null, title: "Planning with Kit", start: new Date(T0 + 86_400_000).toISOString(), end: new Date(T0 + 86_400_000 + 1800_000).toISOString(), allDay: false, location: "", attendees: [], organizer: null, myStatus: null, recurrence: null },
      ],
    },
  };
}

// Points the engine's Google endpoints and Keychain at fakes; returns the server and an undo.
export function useFakes(data = googleData()) {
  const google = startFakeGoogle(data);
  const env: Record<string, string> = { ...fakeGoogleEnv(google.url) };
  const dir = mkdtempSync(join(tmpdir(), "atrium-mail-"));
  env.FAKE_SECURITY_STORE = join(dir, "keychain.json");
  env.FAKE_PIM_DATA = join(dir, "pim.json");
  writeFileSync(env.FAKE_PIM_DATA, JSON.stringify(pimData()));
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  return {
    google,
    dir,
    keychainFile: env.FAKE_SECURITY_STORE,
    pimFile: env.FAKE_PIM_DATA,
    undo() {
      google.stop();
      rmSync(dir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

// What a browser does with the sign-in URL: follow Google's redirect to the loopback listener.
export async function approveInBrowser(url: string, mutate?: (u: URL) => void): Promise<Response> {
  const consent = await fetch(url, { redirect: "manual" });
  const back = new URL(consent.headers.get("location")!);
  mutate?.(back);
  return fetch(back);
}
