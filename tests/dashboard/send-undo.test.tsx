import { afterEach, expect, jest, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupMessageCard } from "../../src/dashboard/components/GroupMessageCard";
import { MessageCard, onNumberKey } from "../../src/dashboard/components/MessageCard";
import { Toast } from "../../src/dashboard/components/Toast";
import { SEND_DELAY_MS, sendWithUndo } from "../../src/dashboard/pending-send";
import { currentToast, dismissToast } from "../../src/dashboard/toast";
import type { State } from "../../src/engine/state";
import { ids } from "../tui/fixtures";

const approval = (): State["approvals"][number] => ({
  id: "apr_sam", spaceId: ids.jobHunt, taskId: null, kind: "question", title: "Send a text to Sam?", detail: "", status: "pending",
  note: null, branchHead: null, fingerprint: null, decidedBy: "you", ruleId: null, undoneAt: null, alwaysAsk: "send_message", topic: null, subject: null,
  createdAt: Date.now(), resolvedAt: null,
});
const action = (over: Partial<State["messageActions"][number]> = {}): State["messageActions"][number] => ({
  id: "msa_sam", approvalId: "apr_sam", spaceId: ids.jobHunt, taskId: null, toName: "Sam", handle: "+15550100142", handleSource: "you",
  candidates: null, service: "iMessage", text: "See you at 7", group: null, lastError: null, contactsReady: true, ...over,
});
const chat = { id: "iMessage;+;chat-1", name: "Hike crew", service: "iMessage" as const, participants: [{ name: "Sam", handle: "+1 ••• ••• 0142" }] };

afterEach(() => {
  jest.useRealTimers();
  dismissToast();
});

test("neither text card has a form or a submit button, so Enter can't send", () => {
  for (const html of [
    renderToStaticMarkup(<MessageCard approval={approval()} action={action()} />),
    renderToStaticMarkup(<GroupMessageCard approval={approval()} action={action({ group: { name: "Hike crew", people: [], chat } })} />),
  ]) {
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="submit"');
  }
});

test("Enter in the number field runs Look up and nothing else", () => {
  let lookups = 0;
  let prevented = 0;
  const key = (k: string) => onNumberKey({ key: k, preventDefault: () => prevented++ }, () => lookups++);
  key("5");
  key("Tab");
  expect(lookups).toBe(0);
  key("Enter");
  expect(lookups).toBe(1);
  expect(prevented).toBe(1);
});

test("Send waits five seconds behind an Undo toast before it calls the send API", () => {
  jest.useFakeTimers();
  let sent = 0;
  sendWithUndo("Sam", () => sent++, () => {});
  expect(currentToast()?.text).toBe("Sending to Sam…");
  const html = renderToStaticMarkup(<Toast />);
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain(">Undo</button>");
  jest.advanceTimersByTime(SEND_DELAY_MS - 1);
  expect(sent).toBe(0);
  jest.advanceTimersByTime(1);
  expect(sent).toBe(1);
  expect(currentToast()).toBeNull();
});

test("Undo inside the window cancels the send and hands the card back", async () => {
  jest.useFakeTimers();
  let sent = 0;
  let undone = 0;
  sendWithUndo("Hike crew", () => sent++, () => undone++);
  jest.advanceTimersByTime(3000);
  expect(await currentToast()!.undo!()).toEqual({ ok: true });
  jest.advanceTimersByTime(SEND_DELAY_MS * 2);
  expect(sent).toBe(0);
  expect(undone).toBe(1);
});
