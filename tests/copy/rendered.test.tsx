import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FilesList } from "../../src/dashboard/components/FilesTab";
import { NeedsYou } from "../../src/dashboard/components/NeedsYou";
import { SpaceView } from "../../src/dashboard/components/SpaceView";
import { ThreadList } from "../../src/dashboard/components/Thread";
import { WhatItMadeList } from "../../src/dashboard/components/WhatItMade";
import { approvalDetail, taskDetail } from "../../src/tui/detail";
import { deriveView } from "../../src/tui/select";
import { initialUi } from "../../src/tui/ui";
import { ids, makeState } from "../tui/fixtures";

const MD = "**Done.** Made `grocery-list.md`.\n\n| Day | Plan |\n| --- | --- |\n| Mon | Gym |\n\n- [x] milk\n- [ ] eggs";

// The text a person reads: tags stripped, entities decoded, whitespace as it would render.
const readable = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
    // Inline tags join their text; anything else breaks a line.
    .replace(/<\/?(strong|em|code|a|span|b|del|time|label|svg|path|circle|rect|line|polyline)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

function expectClean(text: string, opts: { tui?: boolean } = {}) {
  for (const bad of ["**", "__", "```", "undefined", "NaN", "[object Object]"]) expect(text).not.toContain(bad);
  expect(text).not.toMatch(/\bnull\b/);
  expect(text).not.toMatch(/(^|[.!?]\s+)Error:/);
  if (!opts.tui) {
    // Two spaces in a row inside one run of text; gaps between elements are layout, not copy.
    for (const run of text.split("\n")) expect(run).not.toMatch(/\S {2}\S/);
  }
}

const state = () => {
  const s = makeState();
  s.approvals[0]!.detail = MD;
  return s;
};

test("Needs you and a space read cleanly", () => {
  const s = state();
  expectClean(readable(renderToStaticMarkup(<NeedsYou state={s} />)));
  const space = s.spaces.find((x) => x.id === ids.atrium)!;
  expectClean(readable(renderToStaticMarkup(<SpaceView state={s} space={space} focusTask={ids.review} />)));
  expectClean(readable(renderToStaticMarkup(<SpaceView state={s} space={undefined} focusTask={null} />)));
});

test("what a task made, files and threads read cleanly", () => {
  const file = { id: "rf1", runId: "r", root: "space" as const, ref: null, path: "grocery-list.md", absPath: "/a/grocery-list.md", change: "created" as const, size: 2662, insertions: null, deletions: null, kind: "markdown" as const, exists: true, at: Date.now() };
  expectClean(readable(renderToStaticMarkup(<WhatItMadeList outputs={{ summary: { text: MD, status: "approved", decidedBy: "rule", at: Date.now() }, files: [file, { ...file, id: "rf2", path: "gone.md", exists: false }] }} spaceId="s" taskId="t" spaceKind="general" />)));
  const space = makeState().spaces[0]!;
  expectClean(readable(renderToStaticMarkup(<FilesList files={{ folder: "/a", shown: "~/Atrium/a", truncated: true, files: [{ root: "space", ref: null, path: "grocery-list.md", absPath: "/a/grocery-list.md", size: 10, at: Date.now(), kind: "markdown", madeBy: null }] }} space={space} />)));
  expectClean(readable(renderToStaticMarkup(<FilesList files={{ folder: "/a", shown: "~/Atrium/a", truncated: false, files: [] }} space={space} />)));
  expectClean(readable(renderToStaticMarkup(<ThreadList messages={[{ id: "m", spaceId: "s", taskId: "t", fromAgent: "codex", toAgent: "claude", body: MD, createdAt: Date.now() }]} />)));
});

test("the terminal app's task and approval detail read cleanly", () => {
  const s = state();
  const text = (lines: { text: string }[][]) => lines.map((l) => l.map((x) => x.text).join("")).join("\n");
  const onTask = { ...initialUi, tab: "spaces" as const, focus: "tasks" as const, lastLeft: "tasks" as const, selected: { ...initialUi.selected, tasks: { id: ids.review, index: 1 } } };
  expectClean(text(taskDetail(deriveView(s, onTask), null, { summary: { text: MD, status: "pending", decidedBy: "you", at: Date.now() }, files: [] }, null)), { tui: true });
  const onNeed = { ...initialUi, selected: { ...initialUi.selected, needs: { id: ids.approval, index: 0 } } };
  expectClean(text(approvalDetail(deriveView(s, onNeed))), { tui: true });
});
