import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { candidateLine, MessageCard } from "../../src/dashboard/components/MessageCard";
import { contactsLine, sendingLine } from "../../src/dashboard/components/MessagingSettings";
import { NeedsYou } from "../../src/dashboard/components/NeedsYou";
import { SentList, sentLine } from "../../src/dashboard/components/SentMessages";
import { spaceStatus } from "../../src/dashboard/summary";
import type { MessageAction } from "../../src/engine/messaging/store";
import type { State } from "../../src/engine/state";
import { ids, makeState } from "../tui/fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const approval = (): State["approvals"][number] => ({
  id: "apr_msg", spaceId: ids.jobHunt, taskId: null, kind: "question", title: "Send a text to Dana?", detail: "To: Dana · number needed", status: "pending",
  note: null, branchHead: null, fingerprint: null, decidedBy: "you", ruleId: null, undoneAt: null, alwaysAsk: "send_message", topic: null, subject: null,
  createdAt: Date.now(), resolvedAt: null,
});
const action = (over: Partial<State["messageActions"][number]> = {}): State["messageActions"][number] => ({
  id: "msa_1", approvalId: "apr_msg", spaceId: ids.jobHunt, taskId: null, toName: "Dana", handle: "+15550100134", handleSource: "contacts",
  candidates: null, service: "iMessage", text: "you free sat?", group: null, lastError: null, contactsReady: true, ...over,
});

test("the card shows who, how, the exact words and what Send does", () => {
  const html = renderToStaticMarkup(<MessageCard approval={approval()} action={action()} />);
  const t = text(html);
  expect(t).toContain("Send a text to Dana?");
  // The number shows once, in the field that edits it.
  expect(t).toContain("To Dana · from Contacts");
  expect(html.split("+1 555 010 0134").length - 1).toBe(1);
  expect(html).toContain('value="+1 555 010 0134"');
  expect(html).toContain(">you free sat?</textarea>");
  expect(t).toContain("13/2000");
  expect(t).toContain("iMessage");
  expect(t).toContain("SMS");
  expect(t).toContain("Don't send");
  expect(html).toMatch(/<button class="btn p"[^>]*>Send<\/button>/);
  expect(t).toContain("Sends from Messages on this Mac. Atrium can't confirm delivery.");
});

test("with no number, Send waits and the card offers a lookup", () => {
  const html = renderToStaticMarkup(<MessageCard approval={approval()} action={action({ handle: null, handleSource: null, contactsReady: false })} />);
  expect(html).toMatch(/<button class="btn p" disabled=""[^>]*>Send<\/button>/);
  expect(text(html)).toContain('Look up "Dana" in Contacts');
  expect(html).toContain('placeholder="Phone number or email"');
  expect(text(html)).toContain("number needed");
});

test("several matches are offered, none picked", () => {
  const candidates = [
    { personId: "p1", name: "Dana Rivera", kind: "phone" as const, label: "Mobile", handle: "+15550100134" },
    { personId: "p2", name: "Dana Moreno", kind: "email" as const, label: null, handle: "dana@example.com" },
  ];
  const html = renderToStaticMarkup(<MessageCard approval={approval()} action={action({ handle: null, handleSource: null, candidates })} />);
  expect(text(html)).toContain("Dana Rivera · Mobile · +1 555 010 0134");
  expect(text(html)).toContain("Dana Moreno · dana@example.com");
  expect(html).not.toContain('checked=""');
  expect(candidateLine(candidates[1]!)).toBe("Dana Moreno · dana@example.com");
});

test("a redraft leads with the last failure and offers System Settings", () => {
  const err = "Atrium isn't allowed to control Messages yet. Open System Settings, go to Privacy & Security › Automation, turn on Messages under \"bun\" (Atrium's engine), then press Send again.";
  const t = text(renderToStaticMarkup(<MessageCard approval={approval()} action={action({ lastError: err })} />));
  expect(t.indexOf("Last try failed:")).toBeLessThan(t.indexOf("To Dana"));
  expect(t).toContain("Open System Settings");
});

test("Needs you folds a text to one line until Review opens its card", () => {
  const s = makeState();
  s.approvals.unshift(approval());
  s.messageActions = [action({ text: "See you at 7 by the north entrance, bring the tickets" })];
  const html = renderToStaticMarkup(<NeedsYou state={s} />);
  expect(text(html)).toContain("Text to Dana ‘See you at 7 by the north entrance, bri…’ Review");
  expect(html).not.toContain("<textarea");
  // Opened, it's the full card with the first-send note.
  const open = text(renderToStaticMarkup(<MessageCard approval={approval()} action={action()} firstSend />));
  expect(open).toContain("Sends from Messages on this Mac.");
  expect(open).toContain("The first send asks macOS whether Atrium may control Messages.");
});

test("a folded text whose last try failed opens on its own", () => {
  const html = renderToStaticMarkup(<MessageCard approval={approval()} action={action({ lastError: "Messages didn't answer." })} folded />);
  expect(text(html)).toContain("Last try failed:");
  expect(text(html)).toContain("Hide");
});

test("sent history", () => {
  const base: MessageAction = {
    id: "m", approvalId: "a", spaceId: "s", taskId: null, toName: "Dana", handle: "+15550100134", handleSource: "you", candidates: null,
    service: "iMessage", text: "hi", group: null, status: "sent", error: null, sentAt: Date.now() - 60_000, createdAt: 1, updatedAt: Date.now(),
  };
  expect(sentLine(base)).toBe("Sent to Dana · 1m ago");
  expect(sentLine({ ...base, status: "failed", error: "Messages didn't answer." })).toBe("Didn't send · Messages didn't answer.");
  expect(sentLine({ ...base, status: "rejected" })).toBe("Not sent · you chose not to send it");
  expect(renderToStaticMarkup(<SentList messages={[]} />)).toBe("");
  expect(text(renderToStaticMarkup(<SentList messages={[base]} />))).toContain("Texts");
});

test("settings lines", () => {
  expect(sendingLine("untested").text).toBe("Not tried yet. The first send asks macOS whether Atrium may control Messages.");
  expect(sendingLine("needs_automation").tone).toBe("bad");
  expect(contactsLine(null).text).toBe("Not tried yet. Atrium only looks after you press Look up on a text.");
});

test("M5: a number picked from Contacts names the contact it came from", () => {
  const candidates = [{ personId: "p9", name: "Dana's Landlord", kind: "phone" as const, label: "Mobile", handle: "+15550100134" }];
  const t = text(renderToStaticMarkup(<MessageCard approval={approval()} action={action({ candidates })} />));
  expect(t).toContain("from Contacts · Dana's Landlord, Mobile");
});

test("space card counts a text waiting to send apart from reviews", () => {
  const s = makeState();
  s.approvals.unshift(approval());
  const space = s.spaces.find((x) => x.id === ids.jobHunt)!;
  const jobTasks = s.tasks.filter((x) => x.spaceId === ids.jobHunt && x.status !== "blocked");
  expect(spaceStatus(space, jobTasks, s).text).toBe("1 text ready to send");
});
