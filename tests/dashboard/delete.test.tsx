import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity } from "../../src/dashboard/components/Activity";
import { DeleteSpace } from "../../src/dashboard/components/DeleteSpace";
import { nameMatches, type SpaceDeletePreview, spaceDeleteLines, taskDeleteLine } from "../../src/dashboard/deletion";
import { ids, makeState } from "../tui/fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const preview = (over: Partial<SpaceDeletePreview> = {}): SpaceDeletePreview => ({
  id: "spc_t",
  name: "Text Dana",
  kind: "general",
  tasks: 3,
  runs: 4,
  history: 12,
  folder: { path: "~/Atrium/text-dana", files: 2, bytes: 2048, more: false },
  repo: null,
  investing: 0,
  refusal: null,
  ...over,
});

test("the confirm lists what goes and what stays, plainly", () => {
  expect(spaceDeleteLines(preview())).toEqual({
    goes: ["3 tasks, with 4 runs and their transcripts", "Its folder ~/Atrium/text-dana (2 files, 2 KB)", "Its history: 12 activity lines"],
    stays: ["Its folder goes to the Trash when macOS allows it. If it can't, Atrium leaves the folder where it is and tells you."],
  });
  expect(spaceDeleteLines(preview({ tasks: 0, runs: 0, history: 0, folder: { path: "~/Atrium/x", files: 0, bytes: 0, more: false } })).goes).toEqual([
    "The space itself (it has no tasks)",
    "Its folder ~/Atrium/x (nothing in it yet)",
  ]);
  const yours = spaceDeleteLines(preview({ kind: "repo", folder: null, repo: { path: "~/dev/app", atriumClone: false } }));
  expect(yours.stays).toEqual([
    "Your repo at ~/dev/app stays exactly as it is, including any atrium/ branches. Delete those yourself if you don't need them.",
    "Nothing on GitHub changes.",
  ]);
  const clone = spaceDeleteLines(preview({ kind: "repo", folder: null, repo: { path: "~/Projects/app", atriumClone: true } }));
  expect(clone.stays[0]).toBe("The copy Atrium cloned at ~/Projects/app is removed only if everything in it is on GitHub. Otherwise Atrium keeps it and says why.");
  expect(spaceDeleteLines(preview({ investing: 30 })).goes).toContain("Its holdings, watchlists, alerts and other investing data");
});

test("the typed name has to match", () => {
  expect(nameMatches("Text Dana", "Text Dana")).toBe(true);
  expect(nameMatches("  Text Dana ", "Text Dana")).toBe(true);
  expect(nameMatches("text dana", "Text Dana")).toBe(false);
  expect(nameMatches("", "")).toBe(false);
});

test("deleting a task says what goes with it", () => {
  expect(taskDeleteLine({ id: "t", title: "Groceries", followers: 0, runs: 2, files: ["list.md"], edited: [], branch: null, refusal: null })).toBe(
    "Deletes this task, along with its 2 runs and transcripts, its history and the file it made (list.md). Files it only changed stay. This can't be undone.",
  );
  expect(taskDeleteLine({ id: "t", title: "Groceries", followers: 0, runs: 1, files: ["a.md", "runs/r/b.md"], edited: ["notes.md"], branch: null, refusal: null })).toBe(
    "Deletes this task, along with its 1 run and transcripts, its history and the 2 files it made (a.md and b.md). notes.md changed since, so it stays. Files it only changed stay. This can't be undone.",
  );
  expect(taskDeleteLine({ id: "t", title: "Fix", followers: 1, runs: 0, files: [], edited: [], branch: "atrium/tsk_1", refusal: null })).toBe(
    "Deletes this task and its review or fix, along with its history. Its branch atrium/tsk_1 stays in your repo. This can't be undone.",
  );
});

test("the delete dialog waits for the engine's count and the name before it can delete", () => {
  const html = renderToStaticMarkup(<DeleteSpace space={{ id: "spc_t", name: "Text Dana" }} onClose={() => {}} />);
  expect(text(html)).toContain('Delete "Text Dana" for good?');
  expect(text(html)).toContain("Type Text Dana to confirm. This can't be undone.");
  expect(html).toMatch(/<button type="submit" class="btn danger" disabled="">/);
});

test("a long feed shows five lines under day headings, with more a click away", () => {
  const s = makeState();
  const now = Date.now();
  const day = 86_400_000;
  s.activity = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `al_${i}`, spaceId: ids.atrium, taskId: null, actor: "atrium", message: "Alert: NVDA crossed $140", createdAt: now - i * 1000 })),
    ...Array.from({ length: 8 }, (_, i) => ({ id: `t_${i}`, spaceId: ids.jobHunt, taskId: `tsk_${i}`, actor: "claude", message: `Started: Task ${i}`, createdAt: now - day - i * 60_000 })),
    { id: "b", spaceId: ids.jobHunt, taskId: ids.blocked, actor: "atrium", message: "Blocked: Summarize postings. No postings found", createdAt: now - 5000 * 1000 },
  ].sort((a, b) => b.createdAt - a.createdAt);
  const html = renderToStaticMarkup(<Activity state={s} />);
  const t = text(html);
  expect(t).toContain("Alert: NVDA crossed $140 ×30");
  expect(t).toContain("Yesterday");
  expect((html.match(/class="group /g) ?? []).length).toBe(5);
  expect(t).toContain("Show more · 5 earlier");
  expect(html).toContain("tone-attention");
});
