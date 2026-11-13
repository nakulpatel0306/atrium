import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { activateOnKey } from "../../src/dashboard/activate";
import { SpaceNeeds } from "../../src/dashboard/components/NeedsYou";
import { SpaceView } from "../../src/dashboard/components/SpaceView";
import { kindLabel } from "../../src/dashboard/spaces";
import { ids, makeState } from "../tui/fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("a space lists what's waiting on you there, with the same answers as Needs you", () => {
  const s = makeState();
  const t = text(renderToStaticMarkup(<SpaceNeeds state={s} spaceId={ids.atrium} />));
  expect(t).toContain("Waiting for you · 1");
  expect(t).toContain("Review: Fix login redirect");
  expect(t).toContain("Send back");
  expect(t).toContain("Approve");
  expect(renderToStaticMarkup(<SpaceNeeds state={s} spaceId={ids.jobHunt} />)).toBe("");
});

test("a task in review offers Approve and Send back in its own detail", () => {
  const s = makeState();
  const space = s.spaces.find((x) => x.id === ids.atrium)!;
  const html = renderToStaticMarkup(<SpaceView state={s} space={space} focusTask={ids.review} />);
  const detail = html.slice(html.indexOf(`id="task-${ids.review}"`));
  expect(text(detail)).toContain("Waiting for your review");
  expect(detail).toContain('data-act="approve"');
});

test("a task whose runs are older than the dashboard keeps doesn't claim it never ran", () => {
  const s = makeState();
  const space = s.spaces.find((x) => x.id === ids.atrium)!;
  s.runs = [];
  s.activity.unshift({ id: "act_old", spaceId: ids.atrium, taskId: ids.review, actor: "claude", message: "Ready for review: Fix login redirect", createdAt: Date.now() - 60_000 });
  const detail = (focus: string) => {
    const html = renderToStaticMarkup(<SpaceView state={s} space={space} focusTask={focus} />);
    const from = html.indexOf(`id="task-${focus}"`);
    return html.slice(from, html.indexOf('id="task-', from + 1) >>> 0);
  };
  expect(detail(ids.review)).not.toContain("No runs yet.");
  expect(detail(ids.queued)).toContain("No runs yet.");
});

test("a task row's summary is a real button, with its actions beside it rather than inside", () => {
  const s = makeState();
  const space = s.spaces.find((x) => x.id === ids.atrium)!;
  const html = renderToStaticMarkup(<SpaceView state={s} space={space} focusTask={ids.review} />);
  const opens = [...html.matchAll(/<button class="task-open" aria-expanded="(true|false)">(.*?)<\/button>/g)];
  expect(opens.length).toBe(s.tasks.filter((t) => t.spaceId === ids.atrium).length);
  expect(opens.map((m) => m[1])).toContain("true");
  for (const m of opens) expect(m[2]).not.toContain("<button");
  expect(html).not.toMatch(/class="item task[^"]*" role="button"/);
});

test("rule and agent rows open on Enter or Space, but not on a press meant for a control inside", () => {
  let opened = 0;
  let prevented = 0;
  const row = {};
  const press = (key: string, target: unknown = row) => activateOnKey({ key, target, currentTarget: row, preventDefault: () => prevented++ }, () => opened++);
  press("Enter");
  press(" ");
  press("a");
  expect(opened).toBe(2);
  expect(prevented).toBe(2);
  press("Enter", {});
  expect(opened).toBe(2);
});

test("the space header names its kind in plain words and the task meta says when it runs", () => {
  const s = makeState();
  const space = s.spaces.find((x) => x.id === ids.atrium)!;
  const t = text(renderToStaticMarkup(<SpaceView state={s} space={{ ...space, kind: "repo" }} focusTask={ids.review} />));
  expect(t).toContain("Code");
  expect(t).toContain("Runs when your Mac is plugged in");
  expect(kindLabel("general")).toBeNull();
  expect(kindLabel("repo")).toBe("Code");
});
