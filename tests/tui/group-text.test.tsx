import { afterEach, expect, test } from "bun:test";
import type { Key } from "ink";
import { cleanup } from "ink-testing-library";
import type { GroupChat } from "../../src/engine/messaging/store";
import type { State } from "../../src/engine/state";
import { approvalDetail } from "../../src/tui/detail";
import { runIntent, sendFollowUp } from "../../src/tui/effects";
import { type Command, commandsFor } from "../../src/tui/keys";
import { confirmLines } from "../../src/tui/screens/overlays";
import { deriveView } from "../../src/tui/select";
import { initialUi, pin, reduce, type Ui } from "../../src/tui/ui";
import { fakeClient } from "./fake-client";
import { ids, makeState } from "./fixtures";
import { openApp } from "./harness";
import { key } from "./key";

afterEach(() => cleanup());

const rows = { detail: 20, live: 10 };
const APR = "apr_grp";
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

function withGroup(chat: GroupChat | null = HIKE): State {
  const s = makeState();
  s.approvals.unshift({
    id: APR, spaceId: ids.jobHunt, taskId: null, kind: "question", title: "Send a text to Hike crew?", detail: "", status: "pending", note: null,
    branchHead: null, fingerprint: null, decidedBy: "you", ruleId: null, undoneAt: null, alwaysAsk: "send_message", topic: null, subject: null,
    createdAt: Date.now(), resolvedAt: null,
  });
  s.messageActions = [
    {
      id: "msa_g", approvalId: APR, spaceId: ids.jobHunt, taskId: null, toName: "hikers", handle: null, handleSource: null, candidates: null, service: "iMessage",
      text: "lock in saturday?", group: { name: "hikers", people: ["Sam", "Priya"], chat }, lastError: null, contactsReady: true,
    },
  ];
  return s;
}
function play(steps: string[], start: Partial<Ui>, state: State) {
  let ui: Ui = pin({ ...initialUi, ...start }, deriveView(state, { ...initialUi, ...start }));
  const all: Command[] = [];
  for (const input of steps) {
    const cmds = commandsFor(input, key((input === "\r" ? { return: true } : {}) as Partial<Key>), ui, deriveView(state, ui));
    all.push(...cmds);
    for (const c of cmds) {
      if (c.kind !== "ui") continue;
      ui = pin(reduce(ui, c.action, deriveView(state, ui), rows), deriveView(state, ui));
    }
  }
  return { ui, intents: all.flatMap((c) => (c.kind === "intent" ? [c.intent] : [])), flashes: all.flatMap((c) => (c.kind === "ui" && c.action.type === "flash" && c.action.flash ? [c.action.flash.text] : [])) };
}
const onNeed: Partial<Ui> = { selected: { ...initialUi.selected, needs: { id: APR, index: 0 } } };
const text = (lines: { text: string }[][]) => lines.map((l) => l.map((x) => x.text).join("")).join("\n");

test("the card names the group and its people, with s, e and x", async () => {
  const app = openApp(fakeClient(withGroup()));
  const f = await app.frame((f) => f.includes("Group text to Hike crew"));
  expect(f).toContain("group chat · 4 people");
  expect(f).toContain("People: Sam Lee, Priya Shah, Jo Park, +1 ••• ••• 0177");
  expect(f).toContain('"lock in saturday?"');
  expect(f).toContain(" s  Send");
  expect(f).toContain(" e  Edit");
  expect(f).toContain(" x  Skip");
});

test("with no chat yet, the card says to find it and s never posts", async () => {
  const s = withGroup(null);
  const app = openApp(fakeClient(s));
  const f = await app.frame((f) => f.includes("Group text to hikers"));
  expect(f).toContain("! group chat needed");
  expect(f).toContain("People: Sam, Priya");
  expect(f).toContain("Find the group chat on the dashboard, then send it here.");
  expect(f).not.toContain(" s  Send");
  const r = play(["s"], onNeed, s);
  expect(r.intents).toEqual([]);
  expect(r.ui.overlay).toBeNull();
  expect(r.flashes).toContain("Find the group chat on the dashboard first.");
});

test("s confirms with the group, its size and the words; y posts only the text", async () => {
  const s = withGroup();
  const opened = play(["s"], onNeed, s);
  expect(opened.ui.overlay).toEqual({ kind: "confirm", purpose: "send", targetId: "msa_g" });
  const c = confirmLines({ kind: "confirm", purpose: "send", targetId: "msa_g" }, s, 70);
  expect(c.title).toBe("Send a group text");
  expect(text(c.lines)).toContain("Send this to Hike crew (4 people)?");
  expect(text(c.lines)).toContain("Sam Lee, Priya Shah, Jo Park, +1 ••• ••• 0177");
  const sent = play(["e", " 8am", "\r", "y"], onNeed, s);
  expect(sent.intents).toEqual([{ type: "send_message", actionId: "msa_g", toName: "Hike crew", text: "lock in saturday? 8am", chatId: "iMessage;+;chat-hike" }]);
  const client = fakeClient(s);
  const flash = await runIntent(client, sent.intents[0]!, s);
  expect(client.calls).toEqual([{ method: "POST", path: "/api/message-actions/msa_g/send", body: { text: "lock in saturday? 8am", chatId: "iMessage;+;chat-hike" } }]);
  expect(flash).toEqual({ tone: "ok", text: "Sending to Hike crew… If it doesn't go, the text comes back in Needs you." });
  expect(play(["x"], onNeed, s).intents).toEqual([{ type: "reject", approvalId: APR, note: "" }]);
});

test("detail shows the group, the people and the words; the follow-up reads the group line", () => {
  const s = withGroup();
  const detail = text(approvalDetail(deriveView(s, { ...initialUi, ...onNeed }), null));
  expect(detail).toContain("To      Hike crew  chat name from Messages");
  expect(detail).toContain('Asked   "hikers" with Sam and Priya');
  expect(detail).toContain("People  Sam Lee, Priya Shah, Jo Park, +1 ••• ••• 0177");
  expect(detail).toContain("lock in saturday?");
  const at = Date.now() - 1000;
  s.activity.unshift({ id: "act_g", spaceId: ids.jobHunt, taskId: null, actor: "atrium", message: "Sent a text to Hike crew (4 people). Atrium can't confirm delivery.", createdAt: Date.now() });
  expect(sendFollowUp(s, { toName: "Hike crew", at })).toEqual({ tone: "ok", text: "Sent to Hike crew. Atrium can't confirm delivery." });
});

test("L2: y sends the chat the confirm showed, even if a newer pick lands before the post", async () => {
  const s = withGroup();
  const [send] = play(["s", "y"], onNeed, s).intents;
  const newer = withGroup({ ...HIKE, id: "iMessage;+;chat-other", name: "Other" });
  const client = fakeClient(newer);
  await runIntent(client, send!, newer);
  expect(client.calls).toEqual([{ method: "POST", path: "/api/message-actions/msa_g/send", body: { text: "lock in saturday?", chatId: "iMessage;+;chat-hike" } }]);
  const c = confirmLines({ kind: "confirm", purpose: "send", targetId: "msa_g" }, s, 70);
  expect(text(c.lines)).toContain('You asked for "hikers" with Sam and Priya.');
});
