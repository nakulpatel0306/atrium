import { afterEach, expect, test } from "bun:test";
import type { Key } from "ink";
import { cleanup } from "ink-testing-library";
import type { State } from "../../src/engine/state";
import { confirmLines } from "../../src/tui/screens/overlays";
import { approvalDetail, taskDetail } from "../../src/tui/detail";
import { runIntent, sendFollowUp } from "../../src/tui/effects";
import { type Command, commandsFor } from "../../src/tui/keys";
import { deriveView } from "../../src/tui/select";
import { initialUi, pin, reduce, type Ui } from "../../src/tui/ui";
import { fakeClient } from "./fake-client";
import { ids, makeState } from "./fixtures";
import { openApp } from "./harness";
import { key } from "./key";

afterEach(() => cleanup());

const rows = { detail: 20, live: 10 };
const MSG_APR = "apr_msg";

function withText(handle: string | null = "+15550100134"): State {
  const s = makeState();
  s.approvals.unshift({
    id: MSG_APR, spaceId: ids.jobHunt, taskId: null, kind: "question", title: "Send a text to Dana?", detail: "To: Dana", status: "pending", note: null,
    branchHead: null, fingerprint: null, decidedBy: "you", ruleId: null, undoneAt: null, alwaysAsk: "send_message", topic: null, subject: null,
    createdAt: Date.now(), resolvedAt: null,
  });
  s.messageActions = [
    { id: "msa_1", approvalId: MSG_APR, spaceId: ids.jobHunt, taskId: null, toName: "Dana", handle, handleSource: handle ? "contacts" : null, candidates: null, service: "iMessage", text: "you free sat?\nlet me know", lastError: null, contactsReady: true },
  ];
  return s;
}
const couldnt = (outcome: "couldnt" | "partial" = "couldnt") => {
  const s = makeState();
  const t = s.tasks.find((x) => x.id === ids.review)!;
  t.outcome = outcome;
  t.outcomeReason = "the file isn't there.";
  return s;
};

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
const onNeed = (id: string, index = 0): Partial<Ui> => ({ selected: { ...initialUi.selected, needs: { id, index } } });
const text = (lines: { text: string }[][]) => lines.map((l) => l.map((x) => x.text).join("")).join("\n");

test("a on a text opens the confirm with the exact words; y sends the stored draft", async () => {
  const s = withText();
  const opened = play(["a"], onNeed(MSG_APR), s);
  expect(opened.ui.overlay).toEqual({ kind: "confirm", purpose: "send", targetId: "msa_1" });
  expect(opened.intents).toEqual([]);
  const shown = text(confirmLines({ kind: "confirm", purpose: "send", targetId: "msa_1" }, s, 60).lines);
  expect(shown).toContain("Send this to Dana (+1 555 010 0134)?");
  expect(shown).toContain("you free sat?\nlet me know");
  expect(shown).toContain("Via iMessage");
  const sent = play(["a", "y"], onNeed(MSG_APR), s);
  expect(sent.intents).toEqual([{ type: "send_message", actionId: "msa_1", toName: "Dana" }]);
  const client = fakeClient(s);
  const flash = await runIntent(client, sent.intents[0]!, s);
  expect(client.calls).toEqual([{ method: "POST", path: "/api/message-actions/msa_1/send", body: { text: "you free sat?\nlet me know", handle: "+15550100134", service: "iMessage" } }]);
  expect(flash).toEqual({ tone: "ok", text: "Sending to Dana… If it doesn't go, the text comes back in Needs you." });
  expect(play(["a", "n"], onNeed(MSG_APR), s).intents).toEqual([]);
});

test("a text without a number never posts", () => {
  const r = play(["a"], onNeed(MSG_APR), withText(null));
  expect(r.intents).toEqual([]);
  expect(r.ui.overlay).toBeNull();
  expect(r.flashes).toContain("Pick who this goes to on the dashboard first.");
});

test("a on a couldn't result asks before accepting", () => {
  const s = couldnt();
  const r = play(["a"], onNeed(ids.approval), s);
  expect(r.ui.overlay).toEqual({ kind: "confirm", purpose: "accept", targetId: ids.approval });
  expect(text(confirmLines({ kind: "confirm", purpose: "accept", targetId: ids.approval }, s, 50).lines)).toContain("Accept anyway? It says it couldn't do this.");
  expect(play(["a", "y"], onNeed(ids.approval), s).intents).toEqual([{ type: "approve", approvalId: ids.approval, title: "Review: Fix login redirect" }]);
  expect(text(confirmLines({ kind: "confirm", purpose: "accept", targetId: ids.approval }, couldnt("partial"), 50).lines)).toContain("Accept as is? It says it's only partly done.");
});

test("detail says couldn't above the summary, and shows a text's recipient and words", () => {
  const s = couldnt();
  const onTask = { ...initialUi, tab: "spaces" as const, focus: "tasks" as const, lastLeft: "tasks" as const, selected: { ...initialUi.selected, tasks: { id: ids.review, index: 1 } } };
  const lines = text(taskDetail(deriveView(s, onTask), null, { summary: { text: "Wrote it.", status: "pending", decidedBy: "you", at: Date.now() }, files: [] }, null));
  expect(lines).toContain("Couldn't do this: the file isn't there.");
  expect(lines.indexOf("Couldn't do this")).toBeLessThan(lines.indexOf("Summary"));
  const t = withText();
  const detail = text(approvalDetail(deriveView(t, { ...initialUi, ...onNeed(MSG_APR) }), null));
  expect(detail).toContain("To   Dana  +1 555 010 0134");
  expect(detail).toContain("Via  iMessage");
  expect(detail).toContain("you free sat?\nlet me know");
});

test("s, e and x on a text card: send, edit then send the edit, skip", async () => {
  const s = withText();
  expect(play(["s"], onNeed(MSG_APR), s).ui.overlay).toEqual({ kind: "confirm", purpose: "send", targetId: "msa_1" });
  expect(play(["x"], onNeed(MSG_APR), s).intents).toEqual([{ type: "reject", approvalId: MSG_APR, note: "" }]);
  const editing = play(["e"], onNeed(MSG_APR), s);
  expect(editing.ui.ask).toMatchObject({ purpose: "edit", targetId: MSG_APR, value: "you free sat?\nlet me know" });
  const edited = play(["e", " :)", "\r"], onNeed(MSG_APR), s);
  expect(edited.ui.overlay).toEqual({ kind: "confirm", purpose: "send", targetId: "msa_1", text: "you free sat?\nlet me know :)" });
  expect(text(confirmLines(edited.ui.overlay as never, s, 60).lines)).toContain("let me know :)");
  const sent = play(["e", " :)", "\r", "y"], onNeed(MSG_APR), s);
  expect(sent.intents).toEqual([{ type: "send_message", actionId: "msa_1", toName: "Dana", text: "you free sat?\nlet me know :)" }]);
  const client = fakeClient(s);
  await runIntent(client, sent.intents[0]!, s);
  expect(client.calls[0]).toEqual({ method: "POST", path: "/api/message-actions/msa_1/send", body: { text: "you free sat?\nlet me know :)", handle: "+15550100134", service: "iMessage" } });
});

test("the cards mark a couldn't result and a text", async () => {
  const s = withText();
  const r = s.tasks.find((x) => x.id === ids.review)!;
  r.outcome = "couldnt";
  r.outcomeReason = "no number.";
  s.tasks.push({ ...r, id: "tsk_done", title: "Send the text to Dana", status: "done", approvalId: null });
  const client = fakeClient(s);
  const app = openApp(client);
  const f = await app.frame((f) => f.includes("✉ Text to Dana"));
  expect(f).toContain('"you free sat? let me know"');
  expect(f).toContain(" s  Send");
  expect(f).toContain("! Review: Fix login redirect");
  await app.type("2", "\t");
  const tasks = await app.frame((f) => f.includes("Send the text to Dana"));
  expect(tasks).toMatch(/! Send the text to Dana\s+not done/);
});

test("after Sending…, the activity says whether it went", () => {
  const s = withText();
  const at = Date.now() - 1000;
  expect(sendFollowUp(s, { toName: "Dana", at })).toBeNull();
  s.activity.unshift({ id: "act_s", spaceId: ids.jobHunt, taskId: null, actor: "atrium", message: "Sent via Messages to Dana (+1 555 010 0134). Atrium can't confirm delivery.", createdAt: Date.now() });
  expect(sendFollowUp(s, { toName: "Dana", at })).toEqual({ tone: "ok", text: "Sent to Dana. Atrium can't confirm delivery." });
  s.activity[0] = { ...s.activity[0]!, message: "Couldn't send the text to Dana: Messages didn't answer." };
  expect(sendFollowUp(s, { toName: "Dana", at })?.tone).toBe("bad");
  expect(sendFollowUp(s, { toName: "Dana", at: Date.now() + 60_000 })).toBeNull();
});
