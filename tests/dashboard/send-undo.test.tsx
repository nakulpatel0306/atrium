import { closeDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GroupMessageCard } from "../../src/dashboard/components/GroupMessageCard";
import { LiveRegion } from "../../src/dashboard/components/LiveRegion";
import { MessageCard } from "../../src/dashboard/components/MessageCard";
import { SendTray } from "../../src/dashboard/components/SendTray";
import { cancelAll, SEND_DELAY_MS, useCancelOnRouteChange } from "../../src/dashboard/pending-send";
import { navigate, usePath } from "../../src/dashboard/route";
import type { State } from "../../src/engine/state";
import { ids } from "../tui/fixtures";

type Action = State["messageActions"][number];

const approval = (id: string, name: string): State["approvals"][number] => ({
  id, spaceId: ids.jobHunt, taskId: null, kind: "question", title: `Send a text to ${name}?`, detail: "", status: "pending",
  note: null, branchHead: null, fingerprint: null, decidedBy: "you", ruleId: null, undoneAt: null, alwaysAsk: "send_message", topic: null, subject: null,
  createdAt: Date.now(), resolvedAt: null,
});
const action = (id: string, name: string, over: Partial<Action> = {}): Action => ({
  id, approvalId: `apr_${id}`, spaceId: ids.jobHunt, taskId: null, toName: name, handle: "+15550100142", handleSource: "you",
  candidates: null, service: "iMessage", text: "See you at 7", group: null, lastError: null, contactsReady: true, ...over,
});
const chat = { id: "iMessage;+;chat-hike", name: "Hike crew", service: "iMessage" as const, participants: [{ name: "Sam Lee", handle: "+1 ••• ••• 0142" }] };

let calls: { url: string; body: unknown }[] = [];
let roots: Root[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const data = url.endsWith("/lookup") ? { candidates: [], picked: null, message: "No match in Contacts." } : {};
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
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
// Focused first, as a person's key press would be: React's change tracking in this DOM follows the focused field.
const press = (el: HTMLElement, key: string) =>
  act(() => {
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
const type = (el: HTMLTextAreaElement, value: string) =>
  act(() => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
// Lets the timer's send reach fetch and its answer come back.
async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}
const sends = () => calls.filter((c) => c.url.endsWith("/send"));

function Router() {
  useCancelOnRouteChange(usePath());
  return null;
}

test("Send waits five seconds, then posts exactly what the card showed", async () => {
  const card = render(<MessageCard approval={approval("apr_a", "Sam")} action={action("a", "Sam")} />);
  click(button(card, "Send"));
  expect(card.textContent).toContain("Sending…");
  await wait(SEND_DELAY_MS - 1);
  expect(calls).toHaveLength(0);
  await wait(1);
  expect(sends()).toEqual([{ url: "/api/message-actions/a/send", body: { text: "See you at 7", handle: "+1 555 010 0142", service: "iMessage" } }]);
});

test("Undo on the card or in the tray sends nothing and hands the card back", async () => {
  const card = render(<MessageCard approval={approval("apr_a", "Sam")} action={action("a", "Sam")} />);
  const tray = render(<SendTray />);
  click(button(card, "Send"));
  click(button(card, "Undo"));
  expect(button(card, "Send").disabled).toBe(false);
  click(button(card, "Send"));
  expect(tray.textContent).toContain("Sending to Sam in 5s…");
  expect([...tray.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Undo"]);
  click(button(tray, "Undo"));
  await wait(SEND_DELAY_MS * 2);
  expect(calls).toHaveLength(0);
  expect(tray.textContent).toBe("");
});

test("Enter in the number field looks up and Enter in the message never sends", async () => {
  const card = render(<MessageCard approval={approval("apr_a", "Sam")} action={action("a", "Sam")} />);
  press(card.querySelector("input")!, "Enter");
  press(card.querySelector("textarea")!, "Enter");
  await wait(SEND_DELAY_MS * 2);
  expect(calls.map((c) => c.url)).toEqual(["/api/message-actions/a/lookup"]);
});

test("two sends each keep their own Undo: undoing the first leaves only the second to post", async () => {
  const sam = render(<MessageCard approval={approval("apr_a", "Sam")} action={action("a", "Sam")} />);
  const priya = render(<MessageCard approval={approval("apr_b", "Priya")} action={action("b", "Priya", { handle: "+15550100177" })} />);
  const tray = render(<SendTray />);
  click(button(sam, "Send"));
  await wait(1000);
  click(button(priya, "Send"));
  expect(tray.querySelectorAll(".send-row")).toHaveLength(2);
  click(button(tray.querySelector(".send-row")!, "Undo"));
  await wait(SEND_DELAY_MS);
  expect(sends().map((c) => c.url)).toEqual(["/api/message-actions/b/send"]);
});

test("while a send waits, the person, number, words and service can't change", async () => {
  const candidates = [
    { personId: "p1", name: "Sam Lee", kind: "phone" as const, label: "Mobile", handle: "+15550100142" },
    { personId: "p2", name: "Sam Lee", kind: "phone" as const, label: "Work", handle: "+15550100143" },
  ];
  const card = render(<MessageCard approval={approval("apr_a", "Sam")} action={action("a", "Sam", { candidates })} />);
  click(button(card, "Send"));
  const radios = [...card.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(radios.map((r) => r.disabled)).toEqual([true, true]);
  click(radios[1]!);
  expect(card.querySelector<HTMLInputElement>('input[aria-label="Phone number or email"]')!.value).toBe("+1 555 010 0142");
  expect(button(card, "SMS").disabled).toBe(true);
  expect(card.querySelector("textarea")!.readOnly).toBe(true);
  expect(button(card, 'Look up "Sam" in Contacts').disabled).toBe(true);
  await wait(SEND_DELAY_MS);
  expect(sends()[0]!.body).toMatchObject({ handle: "+1 555 010 0142" });
});

test("changing pages cancels every waiting send and says it's still drafted", async () => {
  history.replaceState(null, "", "/needs-you");
  const live = render(<LiveRegion />);
  render(<Router />);
  const card = render(<MessageCard approval={approval("apr_a", "Sam")} action={action("a", "Sam")} />);
  click(button(card, "Send"));
  act(() => navigate("/activity"));
  await wait(SEND_DELAY_MS * 2);
  expect(calls).toHaveLength(0);
  expect(live.textContent).toBe("Didn't send to Sam. It's still drafted.");
  expect(button(card, "Send").disabled).toBe(false);
});

test("a card that remounts mid-send shows the send: Sending…, Undo, locked fields, the words being sent", async () => {
  const first = render(<MessageCard approval={approval("apr_a", "Sam")} action={action("a", "Sam")} />);
  type(first.querySelector("textarea")!, "See you at 8");
  click(button(first, "Send"));
  act(() => roots.shift()!.unmount());
  const again = render(<MessageCard approval={approval("apr_a", "Sam")} action={action("a", "Sam")} folded />);
  expect(again.textContent).toContain("Sending…");
  expect(again.querySelector("textarea")!.value).toBe("See you at 8");
  expect(again.querySelector("textarea")!.readOnly).toBe(true);
  click(button(again, "Undo"));
  await wait(SEND_DELAY_MS);
  expect(calls).toHaveLength(0);
  expect(again.querySelector("textarea")!.value).toBe("See you at 8");
});

test("a group text waits the same way, locks its chat picks, and Undo sends nothing", async () => {
  const group = { name: "Hike crew", people: [], chat };
  const card = render(<GroupMessageCard approval={approval("apr_g", "Hike crew")} action={action("g", "Hike crew", { handle: null, group })} />);
  click(button(card, "Send"));
  expect(button(card, "Find a different group chat").disabled).toBe(true);
  expect(card.querySelector("textarea")!.readOnly).toBe(true);
  click(button(card, "Undo"));
  await wait(SEND_DELAY_MS);
  expect(calls).toHaveLength(0);
  press(card.querySelector("textarea")!, "Enter");
  click(button(card, "Send"));
  await wait(SEND_DELAY_MS - 1);
  expect(calls).toHaveLength(0);
  await wait(1);
  expect(sends()).toEqual([{ url: "/api/message-actions/g/send", body: { text: "See you at 7", chatId: chat.id } }]);
});
