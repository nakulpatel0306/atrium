import { expect, test } from "bun:test";
import { activityKind, byDay, dayLabel, groupActivity, visibleGroups } from "../../src/engine/activity-groups";
import type { ActivityRow } from "../../src/engine/events";

const NOW = new Date(2026, 10, 6, 15, 0).getTime();
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
let n = 0;
const row = (createdAt: number, message: string, more: Partial<ActivityRow> = {}): ActivityRow => ({
  id: `act_${++n}`,
  spaceId: "spc_a",
  taskId: null,
  actor: "atrium",
  message,
  createdAt,
  ...more,
});
// The feed arrives newest first.
const feed = (...rows: ActivityRow[]) => rows.sort((a, b) => b.createdAt - a.createdAt);

test("kinds come from the engine's own words", () => {
  expect(activityKind("Started: Groceries")).toBe("started");
  expect(activityKind("Finished: Groceries")).toBe("finished");
  expect(activityKind("Ready for review: Groceries")).toBe("ready");
  expect(activityKind("Approved: Groceries")).toBe("decided");
  expect(activityKind('Approved by your rule "Docs": Groceries')).toBe("rule");
  expect(activityKind("Blocked: Groceries. No repo.")).toBe("blocked");
  expect(activityKind("Couldn't do: Groceries. No list.")).toBe("couldnt");
  expect(activityKind("Partly done: Groceries. Half.")).toBe("partial");
  expect(activityKind("Couldn't clone a/b. GitHub said: no")).toBe("failed");
  expect(activityKind("Didn't send the text to Dana: no number")).toBe("failed");
  expect(activityKind("Alert: NVDA crossed $140")).toBe("alert");
  expect(activityKind("Paper buy 2 AAPL @ US$190.00")).toBe("paper");
  expect(activityKind("Sent via Messages to Dana (+1 555). Atrium can't confirm delivery.")).toBe("sent");
  expect(activityKind("Drafted a text to Dana: Text Dana")).toBe("drafted");
  expect(activityKind("The engine restarted, so Groceries is back in the queue.")).toBe("requeued");
  expect(activityKind("Paused: Claude hit its limit. Groceries will run again after that.")).toBe("paused");
  expect(activityKind("Cloned a/b into ~/dev")).toBe("other");
});

test("day labels read Today, Yesterday, then the date", () => {
  expect(dayLabel(at(6, 9), NOW)).toBe("Today");
  expect(dayLabel(at(5, 23), NOW)).toBe("Yesterday");
  expect(dayLabel(at(3, 12), NOW)).toBe("Tue, Nov 3");
  expect(dayLabel(new Date(2025, 10, 3, 12).getTime(), NOW)).toBe("Mon, Nov 3, 2025");
});

test("one task's routine lines collapse into one line with its files", () => {
  const t = { taskId: "tsk_g" };
  const groups = groupActivity(
    feed(
      row(at(6, 10), "Started: Groceries", { ...t, actor: "claude" }),
      row(at(6, 10, 5), "Ready for review: Groceries", { ...t, actor: "claude" }),
    ),
    { now: NOW, tasks: [{ id: "tsk_g", title: "Groceries", status: "review" }], files: { tsk_g: 2 } },
  );
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ title: "Groceries", text: "ran, wrote 2 files, waiting for review", tone: "attention", count: 2, day: "Today" });
  expect(groups[0]!.events.map((e) => e.message)).toEqual(["Ready for review: Groceries", "Started: Groceries"]);
});

test("once decided, the line says what happened instead of waiting", () => {
  const t = { taskId: "tsk_g" };
  const [g] = groupActivity(
    feed(
      row(at(6, 10), "Started: Groceries", t),
      row(at(6, 10, 5), "Ready for review: Groceries", t),
      row(at(6, 11), "Approved: Groceries", { ...t, actor: "you" }),
    ),
    { now: NOW, tasks: [{ id: "tsk_g", title: "Groceries", status: "done" }] },
  );
  expect(g).toMatchObject({ text: "ran, ready for review, approved", tone: "routine" });
});

test("a failure after finished work stays apart from that work", () => {
  const t = { taskId: "tsk_g" };
  const groups = groupActivity(
    feed(row(at(6, 9), "Started: Groceries", t), row(at(6, 9, 5), "Finished: Groceries", t), row(at(6, 10), "Blocked: Groceries. No disk.", t)),
    { now: NOW, tasks: [{ id: "tsk_g", title: "Groceries", status: "blocked" }] },
  );
  expect(groups.map((g) => [g.tone, g.count])).toEqual([
    ["failure", 1],
    ["routine", 2],
  ]);
});

test("a failure is its own prominent line and splits the task's routine lines around it", () => {
  const t = { taskId: "tsk_g" };
  const groups = groupActivity(
    feed(
      row(at(6, 9), "Started: Groceries", t),
      row(at(6, 9, 1), "Blocked: Groceries. The folder is read-only.", t),
      row(at(6, 10), "Started: Groceries", t),
      row(at(6, 10, 2), "Finished: Groceries", t),
    ),
    { now: NOW, tasks: [{ id: "tsk_g", title: "Groceries", status: "done" }] },
  );
  // The start that led straight to the failure folds into the failure's line.
  expect(groups.map((g) => [g.tone, g.text, g.count])).toEqual([
    ["routine", "ran", 2],
    ["failure", "Blocked: Groceries. The folder is read-only.", 2],
  ]);
});

test("runs repeated in a day are counted", () => {
  const t = { taskId: "tsk_g" };
  const [g] = groupActivity(
    feed(row(at(6, 9), "Started: Groceries", t), row(at(6, 9, 5), "Finished: Groceries", t), row(at(6, 10), "Started: Groceries", t), row(at(6, 10, 5), "Finished: Groceries", t)),
    { now: NOW, tasks: [{ id: "tsk_g", title: "Groceries", status: "done" }] },
  );
  expect(g!.text).toBe("ran 2 times");
});

test("a task still running says so", () => {
  const [g] = groupActivity(feed(row(at(6, 14), "Started: Groceries", { taskId: "tsk_g" })), {
    now: NOW,
    tasks: [{ id: "tsk_g", title: "Groceries", status: "running" }],
  });
  expect(g!.text).toBe("running");
});

test("repeated system lines fold into one with a count", () => {
  const alerts = Array.from({ length: 40 }, (_, i) => row(at(6, 9, i), "Alert: NVDA crossed $140"));
  const paper = Array.from({ length: 12 }, (_, i) => row(at(6, 8, i), `Paper buy ${i + 1} AAPL @ US$190.00`, { actor: "claude" }));
  const groups = groupActivity(feed(...alerts, ...paper, row(at(6, 7), "Cloned a/b into ~/dev")), { now: NOW });
  expect(groups.map((g) => [g.text, g.count, g.tone])).toEqual([
    ["Alert: NVDA crossed $140 ×40", 40, "attention"],
    ["12 paper trades", 12, "routine"],
    ["Cloned a/b into ~/dev", 1, "routine"],
  ]);
});

test("lines from different days and spaces never merge", () => {
  const groups = groupActivity(
    feed(
      row(at(5, 9), "Started: Groceries", { taskId: "tsk_g" }),
      row(at(6, 9), "Started: Groceries", { taskId: "tsk_g" }),
      row(at(6, 9, 1), "Alert: NVDA crossed $140", { spaceId: "spc_a" }),
      row(at(6, 9, 2), "Alert: NVDA crossed $140", { spaceId: "spc_b" }),
    ),
    { now: NOW },
  );
  expect(groups.map((g) => [g.day, g.count])).toEqual([
    ["Today", 1],
    ["Today", 1],
    ["Today", 1],
    ["Yesterday", 1],
  ]);
});

test("older lines without a task id group by the title they name", () => {
  const groups = groupActivity(
    feed(row(at(6, 9), "Started: Groceries", { actor: "claude" }), row(at(6, 9, 3), "Ready for review: Groceries", { actor: "claude" }), row(at(6, 9, 4), "Started: Laundry")),
    { now: NOW },
  );
  expect(groups.map((g) => [g.title, g.text])).toEqual([
    ["Laundry", "started"],
    ["Groceries", "ran, ready for review"],
  ]);
});

test("a rule's approval is always named", () => {
  const [g] = groupActivity(feed(row(at(6, 9), "Ready for review: Docs", { taskId: "t" }), row(at(6, 9, 1), 'Approved by your rule "Docs": Docs', { taskId: "t" })), {
    now: NOW,
    tasks: [{ id: "t", title: "Docs", status: "done" }],
  });
  expect(g!.text).toBe("ran, ready for review, approved by your rule");
});

test("partly done and sent lines stand alone", () => {
  const groups = groupActivity(
    feed(row(at(6, 9), "Partly done: Groceries. Only half the list.", { taskId: "t" }), row(at(6, 10), "Sent via Messages to Dana (+1 555). Atrium can't confirm delivery.")),
    { now: NOW },
  );
  expect(groups.map((g) => g.tone)).toEqual(["notice", "attention"]);
});

test("byDay keeps groups in order under their day", () => {
  const groups = groupActivity(feed(row(at(4, 9), "Cloned a/b"), row(at(6, 9), "Cloned c/d"), row(at(6, 10), "Cloned e/f")), { now: NOW });
  expect(byDay(groups).map((d) => [d.day, d.groups.length])).toEqual([
    ["Today", 2],
    ["Wed, Nov 4", 1],
  ]);
});

test("activity lines keep the task they're about", async () => {
  const { tempHome } = await import("../helpers");
  const { openDb } = await import("../../src/engine/db");
  const { createSpace } = await import("../../src/engine/spaces");
  const { createTask } = await import("../../src/engine/tasks");
  const { listActivity, logActivity } = await import("../../src/engine/events");
  const home = tempHome();
  const db = openDb();
  try {
    const s = createSpace(db, { name: "A", kind: "general", goal: "g" });
    const t = createTask(db, { spaceId: s.id, title: "Groceries" });
    logActivity(db, s.id, "claude", "Started: Groceries", { taskId: t.id });
    logActivity(db, s.id, "atrium", "Cloned a/b");
    expect(listActivity(db, { spaceId: s.id }).map((r) => r.taskId)).toEqual([null, t.id]);
  } finally {
    db.close();
    home.cleanup();
  }
});

test("today's failures and lines still waiting on Nakul stay above Show more; older ones fold", () => {
  const routine = Array.from({ length: 8 }, (_, i) => row(at(6, 14, i), `Cloned repo-${i} into ~/dev`));
  const groups = groupActivity(
    feed(
      ...routine,
      row(at(6, 9), "Blocked: Old job. No disk."),
      row(at(4, 9), "Blocked: Older job. No disk."),
      row(at(3, 9), "Ready for review: Groceries", { taskId: "tsk_g" }),
      row(at(3, 8), "Alert: NVDA crossed $140"),
      row(at(2, 9), "Ready for review: Laundry", { taskId: "tsk_l" }),
    ),
    { now: NOW, tasks: [{ id: "tsk_g", title: "Groceries", status: "review" }, { id: "tsk_l", title: "Laundry", status: "done" }] },
  );
  const { visible, hidden } = visibleGroups(groups, 5);
  expect(visible.map((g) => g.title ?? g.text)).toEqual([
    "Cloned repo-7 into ~/dev",
    "Cloned repo-6 into ~/dev",
    "Cloned repo-5 into ~/dev",
    "Cloned repo-4 into ~/dev",
    "Cloned repo-3 into ~/dev",
    "Blocked: Old job. No disk.",
    "Groceries",
  ]);
  expect(hidden).toBe(groups.length - 7);
});

test("notes about kept or removed files get a line of their own", () => {
  expect(activityKind("Kept notes.md: it changed after the task made it.")).toBe("note");
  expect(activityKind("Atrium left /x alone: it isn't inside /y.")).toBe("note");
  expect(activityKind("Kept the local copy of a/b: unpushed.")).toBe("failed");
  const groups = groupActivity(feed(row(at(6, 9), "Kept a.md: it changed after the task made it."), row(at(6, 9, 1), "Kept a.md: it changed after the task made it.")), { now: NOW });
  expect(groups.map((g) => g.tone)).toEqual(["notice", "notice"]);
});
