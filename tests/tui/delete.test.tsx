import { expect, test } from "bun:test";
import type { SpaceDeletePreview } from "../../src/engine/delete";
import type { State } from "../../src/engine/state";
import { deleteBoxLines } from "../../src/tui/screens/overlays";
import { activityDetail } from "../../src/tui/detail";
import { commandsFor } from "../../src/tui/keys";
import { deriveView } from "../../src/tui/select";
import { initialUi, pin, reduce, type Ui } from "../../src/tui/ui";
import { fakeClient } from "./fake-client";
import { ids, makeState, space } from "./fixtures";
import { KEY, openApp } from "./harness";
import { key } from "./key";

const withArchived = (): State => makeState({ archived: [space({ id: "spc_old", name: "Text Dana", status: "archived", goal: "Text Dana" })] });

// Plays characters through the keys and reducer, as the App does, and returns the intents.
function play(chars: (string | "enter")[], state: State, start: Partial<Ui>) {
  let ui: Ui = pin({ ...initialUi, ...start }, deriveView(state, { ...initialUi, ...start }));
  const intents: unknown[] = [];
  const flashes: string[] = [];
  for (const ch of chars) {
    const cmds = commandsFor(ch === "enter" ? "" : ch, key(ch === "enter" ? { return: true } : {}), ui, deriveView(state, ui));
    for (const c of cmds) {
      if (c.kind === "intent") intents.push(c.intent);
      if (c.kind !== "ui") continue;
      if (c.action.type === "flash" && c.action.flash) flashes.push(c.action.flash.text);
      ui = pin(reduce(ui, c.action, deriveView(state, ui), { detail: 20, live: 10 }), deriveView(state, ui));
    }
  }
  return { ui, intents, flashes };
}

const onOld = { tab: "spaces" as const, selected: { ...initialUi.selected, spaces: { id: "spc_old", index: 2 } } };

test("archived spaces list after the active ones", () => {
  expect(deriveView(withArchived(), initialUi).spaces.map((s) => s.name)).toEqual(["atrium", "job hunt", "Text Dana"]);
});

test("X restores an archived space; on an active one it still asks first", () => {
  expect(play(["X"], withArchived(), onOld).intents).toEqual([{ type: "restore", spaceId: "spc_old" }]);
  expect(play(["X"], withArchived(), { tab: "spaces" }).ui.overlay).toEqual({ kind: "confirm", purpose: "archive", targetId: ids.atrium });
  expect(play(["n"], withArchived(), onOld).flashes).toEqual(["Text Dana is archived. Press X to restore it first."]);
});

test("D deletes only once the name is typed in full", () => {
  const typed = (name: string) => play(["D", ...name, "enter"], withArchived(), onOld);
  expect(typed("Text").intents).toEqual([]);
  expect(typed("Text").flashes).toEqual(['Type "Text Dana" exactly to delete it, or press esc to keep it.']);
  // Typing "q" or "X" inside the box is text, not a command.
  expect(typed("Text Dana").intents).toEqual([{ type: "deleteSpace", spaceId: "spc_old", name: "Text Dana" }]);
  expect(play(["D", "q", "X", "\u001b"], withArchived(), onOld).intents).toEqual([]);
});

test("the delete box shows what goes and what stays", () => {
  const preview: SpaceDeletePreview = {
    id: "spc_old",
    name: "Text Dana",
    kind: "general",
    tasks: 2,
    runs: 2,
    history: 7,
    folder: { path: "~/Atrium/text-dana", files: 1, bytes: 120, more: false },
    repo: null,
    investing: 0,
    refusal: null,
  };
  const { title, lines } = deleteBoxLines({ kind: "delete", spaceId: "spc_old", value: "Text", cursor: 4 }, withArchived(), preview, 64);
  const text = lines.map((l) => l.map((s) => s.text).join("")).join("\n");
  expect(title).toBe("Delete Text Dana for good");
  expect(text).toContain("  · 2 tasks, with 2 runs and their transcripts");
  expect(text).toContain("Type Text Dana to confirm. This can't be undone.");
  expect(text).toContain("› Text");
});

test("the activity pane lists folded groups and the detail shows every line", () => {
  const s = makeState();
  const now = Date.now();
  s.activity = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, spaceId: ids.atrium, taskId: null, actor: "atrium", message: "Alert: NVDA crossed $140", createdAt: now - i * 1000 }));
  const view = deriveView(s, { ...initialUi, tab: "activity" });
  expect(view.activity).toHaveLength(1);
  expect(view.activity[0]!.text).toBe("Alert: NVDA crossed $140 ×12");
  const lines = activityDetail(view).map((l) => l.map((x) => x.text).join(""));
  expect(lines).toContain("All 12 lines");
  expect(lines.filter((l) => l.includes("Atrium: Alert: NVDA crossed $140"))).toHaveLength(12);
});

test("D in the app opens the box with the engine's count", async () => {
  const client = fakeClient(withArchived());
  client.respond("/api/spaces/spc_old/delete-preview", {
    ok: true,
    data: { id: "spc_old", name: "Text Dana", kind: "general", tasks: 0, runs: 0, history: 0, folder: null, texts: { sent: 0, drafts: 0 }, repo: null, investing: 0, refusal: null },
  });
  client.respond("/api/spaces/spc_old", { ok: true, data: { name: "Text Dana", message: 'Deleted "Text Dana". Its folder ~/Atrium/text-dana went to the Trash.', kept: [] } });
  const app = openApp(client);
  await app.frame((f) => f.includes("1 Home"));
  await app.type("2", "j", "j", "D");
  await app.frame((f) => f.includes("Delete Text Dana for good") && f.includes("The space itself"));
  await app.type(..."Text Dana", KEY.enter);
  await app.frame(() => client.calls.some((c) => c.method === "DELETE"));
  expect(client.calls.find((c) => c.method === "DELETE")).toEqual({ method: "DELETE", path: "/api/spaces/spc_old", body: { name: "Text Dana" } });
  await app.frame((f) => f.includes('Deleted "Text Dana". Its folder ~/Atrium/text-dana went'));
  app.unmount();
});

test("restoring an earlier Messages says it merged, and points X at the current one", async () => {
  const { runIntent } = await import("../../src/tui/effects");
  const state = makeState({ archived: [space({ id: "spc_oldmsg", name: "Messages", status: "archived" })] });
  const client = fakeClient(state);
  client.respond("/api/spaces/spc_oldmsg", { ok: true, data: { id: "spc_current", name: "Messages" } });
  expect(await runIntent(client, { type: "restore", spaceId: "spc_oldmsg" }, state)).toEqual({
    tone: "ok",
    text: "Moved the earlier Messages into your current one, so there's only one.",
    spaceId: "spc_current",
  });
});
