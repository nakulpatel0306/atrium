import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EventCard } from "../../src/dashboard/components/inbox/EventCard";
import { MailCard } from "../../src/dashboard/components/inbox/MailCard";
import { SendTray } from "../../src/dashboard/components/SendTray";
import { cancelAll, SEND_DELAY_MS } from "../../src/dashboard/pending-send";
import type { State } from "../../src/engine/state";

type Draft = State["mailActions"][number];

const approval = (id: string, title: string): State["approvals"][number] => ({
  id, spaceId: "spc_inbox", taskId: null, kind: "question", title, detail: "", status: "pending", note: null, branchHead: null,
  fingerprint: null, decidedBy: "you", ruleId: null, undoneAt: null, alwaysAsk: "send_message", topic: null, subject: null, createdAt: Date.now(), resolvedAt: null,
});
const draft = (over: Partial<Draft> = {}): Draft => ({
  id: "mla_1", approvalId: "apr_1", spaceId: "spc_inbox", taskId: null, kind: "reply", status: "draft", draftedBy: "claude", accountId: "mac_sam", threadId: "mth_1",
  subject: "Re: Lease renewal", body: "Thursday works.", quoted: "On Mon, Robin Vale <robin@example.net> wrote:\n> Can we sign Thursday?",
  to: [
    { name: "Robin Vale", address: "robin@example.net", added: false },
    { name: "Kit Moreno", address: "kit@example.org", added: true },
  ],
  cc: [], attachments: [], event: null, reasons: [{ kind: "first_time", key: "first_time:kit@example.org", text: "First time emailing Kit Moreno <kit@example.org>" }], lastError: null, ...over,
});

let calls: { url: string; body: unknown }[] = [];
let roots: Root[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      const overview = { accounts: [{ id: "mac_sam", address: "sam@example.com", preferred: true, enabled: true }], calendars: [{ id: "cal_1", title: "Sam", enabled: true, hidden: null, writable: true }] };
      return new Response(JSON.stringify(overview), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  jest.useFakeTimers();
});
afterEach(() => {
  act(() => cancelAll());
  for (const r of roots) act(() => r.unmount());
  roots = [];
  document.body.replaceChildren();
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});
openDom();
afterAll(() => closeDom());

function render(node: ReactNode): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  act(() => root.render(node));
  return el;
}
const button = (within: ParentNode, label: string) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no ${label} button`);
  return b;
};
const click = (el: HTMLElement) => act(() => el.click());
async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

test("the card shows every person, who Claude added, why it needs your Send, and the quoted text that goes too", () => {
  const card = render(<MailCard approval={approval("apr_1", "Send a reply to Robin Vale and Kit Moreno?")} action={draft()} />);
  const text = card.textContent!;
  expect(text).toContain("Needs your Send");
  expect(text).toContain("First time emailing Kit Moreno <kit@example.org>");
  expect(card.querySelector(".mail-notes")!.textContent).toContain("Added by Claude Kit Moreno <kit@example.org>");
  expect((card.querySelectorAll("input")[0] as HTMLInputElement).value).toBe("Robin Vale <robin@example.net>, Kit Moreno <kit@example.org>");
  expect(card.querySelector(".mail-quoted-out pre")!.textContent).toContain("> Can we sign Thursday?");
  // A reply keeps the thread's subject.
  expect((card.querySelectorAll("input")[2] as HTMLInputElement).readOnly).toBe(true);
});

test("Send waits in the tray for five seconds with Undo, then posts the card's fields and the notes it showed", async () => {
  const card = render(<MailCard approval={approval("apr_1", "Send a reply?")} action={draft()} />);
  const tray = render(<SendTray />);
  click(button(card, "Send"));
  expect(tray.textContent).toContain("Sending to Robin Vale <robin@example.net> and Kit Moreno <kit@example.org> in 5s…");
  click(button(tray, "Undo"));
  await wait(SEND_DELAY_MS * 2);
  expect(calls).toEqual([]);
  click(button(card, "Send"));
  await wait(SEND_DELAY_MS);
  expect(calls).toEqual([
    {
      url: "/api/mail/actions/mla_1/send",
      body: {
        accountId: "mac_sam",
        to: [
          { name: "Robin Vale", address: "robin@example.net" },
          { name: "Kit Moreno", address: "kit@example.org" },
        ],
        cc: [],
        subject: "Re: Lease renewal",
        body: "Thursday works.",
        seen: ["first_time:kit@example.org"],
      },
    },
  ]);
});

test("a forward lists the attachments that go with it", () => {
  const card = render(<MailCard approval={approval("apr_1", "Send a forward?")} action={draft({ kind: "forward", attachments: [{ name: "lease.pdf", size: 2048, index: 0 }], quoted: "---------- Forwarded message ---------\nFrom: Robin" })} />);
  expect(card.querySelector('[aria-label="Attachments sent with it"]')!.textContent).toContain("lease.pdf");
  expect(card.textContent).toContain("Forwarded below your words");
});

test("an invite card names its button for what it does, and goes through the same tray", async () => {
  const start = new Date("2026-11-13T12:00").getTime();
  const event = { calendarId: "cal_1", eventId: null, title: "Lunch with Priya", start, end: start + 3600_000, allDay: false, location: "", attendees: [{ name: "Priya", address: "priya@example.org", added: true }], notify: true };
  const card = render(<EventCard approval={approval("apr_1", 'Create "Lunch with Priya" and invite Priya?')} action={draft({ kind: "event_create", event, quoted: "", to: [], reasons: [{ kind: "first_time", key: "first_time:priya@example.org", text: "First time inviting Priya <priya@example.org>" }] })} />);
  expect(card.textContent).toContain("Added by Claude Priya <priya@example.org>");
  click(button(card, "Create and invite"));
  await wait(SEND_DELAY_MS);
  expect(calls[0]).toMatchObject({ url: "/api/mail/actions/mla_1/send", body: { title: "Lunch with Priya", start, end: start + 3600_000, attendees: [{ name: "Priya", address: "priya@example.org" }], seen: ["first_time:priya@example.org"] } });
});

test("a cancel card names the event's day and time", () => {
  const start = new Date("2026-11-13T12:00").getTime();
  const event = { calendarId: "cal_1", eventId: "evt_1", title: "Dentist", start, end: start + 3600_000, allDay: false, location: "", attendees: [], notify: false };
  const card = render(<EventCard approval={approval("apr_1", 'Cancel "Dentist"?')} action={draft({ kind: "event_cancel", event, quoted: "", to: [], reasons: [] })} />);
  expect(card.querySelector(".msg-to")!.textContent).toContain(new Date(start).toLocaleString([], { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
});
