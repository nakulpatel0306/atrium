import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { chatMembers, GroupMessageCard } from "../../src/dashboard/components/GroupMessageCard";
import { NeedsYou } from "../../src/dashboard/components/NeedsYou";
import { sentLine } from "../../src/dashboard/components/SentMessages";
import type { GroupChat, MessageAction } from "../../src/engine/messaging/store";
import type { State } from "../../src/engine/state";
import { ids, makeState } from "../tui/fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const HIKE: GroupChat = {
  id: "iMessage;+;chat-hike",
  name: "Hike crew",
  service: "iMessage",
  participants: [
    { name: "Sam Lee", handle: "+1 ••• ••• 0134" },
    { name: "Priya Shah", handle: "p••@example.com" },
    { name: "Jo Park", handle: "+1 ••• ••• 0199" },
    { name: null, handle: "+1 ••• ••• 0177" },
  ],
};
const approval = (): State["approvals"][number] => ({
  id: "apr_grp", spaceId: ids.jobHunt, taskId: null, kind: "question", title: "Send a text to Hike crew?", detail: "", status: "pending",
  note: null, branchHead: null, fingerprint: null, decidedBy: "you", ruleId: null, undoneAt: null, alwaysAsk: "send_message", topic: null, subject: null,
  createdAt: Date.now(), resolvedAt: null,
});
const action = (group: NonNullable<State["messageActions"][number]["group"]>, over: Partial<State["messageActions"][number]> = {}): State["messageActions"][number] => ({
  id: "msa_g", approvalId: "apr_grp", spaceId: ids.jobHunt, taskId: null, toName: group.name ?? "Sam and Priya", handle: null, handleSource: null,
  candidates: null, service: "iMessage", text: "lock in saturday?", group, lastError: null, contactsReady: true, ...over,
});

test("with its chat: the group, the people, the editable words, the service, and Send", () => {
  const html = renderToStaticMarkup(<GroupMessageCard approval={approval()} action={action({ name: "hikers", people: [], chat: HIKE })} />);
  const t = text(html);
  expect(t).toContain("Send a text to Hike crew?");
  // H1: what Messages calls the chat is labelled as such, beside what the agent asked for, above the real members.
  expect(t).toContain("To Hike crew chat name from Messages");
  expect(t).toContain('You asked for "hikers"');
  expect(t).toContain("In this chat (4) Sam Lee +1 ••• ••• 0134 Priya Shah p••@example.com Jo Park +1 ••• ••• 0199 No name in Contacts +1 ••• ••• 0177");
  expect(html).toContain('<div class="msg-members">');
  expect(html).toContain(">lock in saturday?</textarea>");
  expect(t).toContain("Via iMessage");
  expect(t).toContain("Don't send");
  expect(html).toMatch(/<button class="btn p"[^>]*>Send<\/button>/);
  expect(html).not.toMatch(/<button class="btn p" disabled=""/);
  expect(t).toContain("Find a different group chat");
  expect(t).toContain("Sends to the existing group chat from Messages on this Mac. Atrium can't confirm delivery.");
  expect(html).not.toContain("4165550134");
});

test("with no chat yet: Send waits, Find is offered with what it reads, and Send separately when people are known", () => {
  const html = renderToStaticMarkup(<GroupMessageCard approval={approval()} action={action({ name: "Hike crew", people: ["Sam", "Priya"], chat: null })} />);
  const t = text(html);
  expect(html).toMatch(/<button class="btn p" disabled=""[^>]*>Send<\/button>/);
  expect(t).toContain("group chat needed");
  expect(t).toContain("People Sam Priya");
  expect(t).toContain('You asked for "Hike crew" with Sam and Priya');
  expect(t).toContain("Find group chat");
  expect(t).toContain("Send separately");
  expect(t).toContain("Find reads only your Messages chat names and who's in them, never what was said, and only when you press it.");
  expect(t).toContain("Send separately makes one text each for Sam and Priya, and each still waits for your Send.");
  const bare = text(renderToStaticMarkup(<GroupMessageCard approval={approval()} action={action({ name: "Hike crew", people: [], chat: null })} />));
  expect(bare).not.toContain("Send separately");
  expect(bare).toContain("Not known until you find the chat.");
});

test("a chat that went away leads with why", () => {
  const err = "That group chat isn't in Messages on this Mac anymore. Press Find group chat on the card to pick it again, or send the text to each person separately.";
  const t = text(renderToStaticMarkup(<GroupMessageCard approval={approval()} action={action({ name: "Hike crew", people: ["Sam"], chat: null }, { lastError: err })} />));
  expect(t.indexOf("Last try failed:")).toBeLessThan(t.indexOf("To Hike crew"));
});

test("M2: the picker puts a chat's members in their own element, not after a separator a name could copy", () => {
  expect(chatMembers(HIKE)).toBe("Sam Lee, Priya Shah, Jo Park, +1 ••• ••• 0177");
});

test("M6: Send separately names exactly who gets a text and who can't, and why", () => {
  const t = text(renderToStaticMarkup(<GroupMessageCard approval={approval()} action={action({ name: "hikers", people: ["Sam", "Priya"], chat: HIKE })} />));
  expect(t).toContain("Send separately makes one text each for Sam Lee, Priya Shah and Jo Park, and each still waits for your Send.");
  expect(t).toContain("Not included: +1 ••• ••• 0177. Messages has no Contacts name for them, so Atrium can't look up their number. Text them yourself.");
  const nobody = { ...HIKE, participants: HIKE.participants.map((p) => ({ ...p, name: null })) };
  expect(text(renderToStaticMarkup(<GroupMessageCard approval={approval()} action={action({ name: "hikers", people: [], chat: nobody })} />))).not.toContain("Send separately");
});

test("Needs you routes a group text to the group card and a person text to the person card", () => {
  const s = makeState();
  s.approvals.unshift(approval());
  s.messageActions = [action({ name: "Hike crew", people: [], chat: HIKE })];
  const t = text(renderToStaticMarkup(<NeedsYou state={s} />));
  expect(t).toContain("Sends to the existing group chat");
  expect(t).not.toContain("Phone number or email");
});

test("sent history names the group and its size, and a split", () => {
  const base: MessageAction = {
    id: "m", approvalId: "a", spaceId: "s", taskId: null, toName: "hikers", handle: null, handleSource: null, candidates: null,
    service: "iMessage", text: "hi", group: { name: "hikers", people: [], chat: HIKE }, status: "sent", error: null, sentAt: Date.now() - 60_000, createdAt: 1, updatedAt: Date.now(),
  };
  expect(sentLine(base)).toBe("Sent to Hike crew (4 people) · 1m ago");
  expect(sentLine({ ...base, status: "split", group: { name: "Book club", people: ["Sam", "Priya"], chat: null }, toName: "Book club" })).toBe("Split into one text per person · Book club");
});
