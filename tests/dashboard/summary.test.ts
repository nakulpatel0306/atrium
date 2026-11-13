import { expect, test } from "bun:test";
import type { Wait } from "../../src/dashboard/agents";
import type { State } from "../../src/dashboard/api";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import {
  agentStatus,
  distinctWaits,
  emptyHome,
  orderedTasks,
  attentionText,
  reviewLine,
  runOutcome,
  spaceStatus,
} from "../../src/dashboard/summary";

type Task = State["tasks"][number];
type Run = State["runs"][number];
type Space = State["spaces"][number];
type Approval = State["approvals"][number];
type Info = State["agents"][string];

const task = (over: Partial<Task> = {}) =>
  ({ id: "tsk_1", spaceId: "spc_1", title: "Task", status: "queued", agent: "auto", kind: "work", parentTaskId: null, ...over }) as Task;
const space = { id: "spc_1", name: "atrium", updatedAt: Date.now() - 3 * 3600_000 } as Space;
const wait = (kind: Wait["kind"], taskId: string, reason: string = kind): Wait => ({ taskId, agent: "claude", kind, reason });
const state = (over: Partial<State> = {}) =>
  ({ tasks: [], runs: [], waits: {}, activity: [], approvals: [], claudeWindow: null, ...over }) as unknown as State;
const waitsOf = (ws: Wait[]) => Object.fromEntries(ws.map((w) => [w.taskId, w]));

test("orderedTasks puts open work first and finished work newest first", () => {
  const tasks = [
    task({ id: "a", status: "done" }),
    task({ id: "queued", status: "queued" }),
    task({ id: "running", status: "running" }),
    task({ id: "b", status: "done" }),
    task({ id: "blocked", status: "blocked" }),
  ];
  expect(orderedTasks(tasks).map((t) => t.id)).toEqual(["running", "blocked", "queued", "b", "a"]);
});

test("spaceStatus says who is running", () => {
  const running = task({ status: "running", agent: "claude", title: "Fix" });
  expect(spaceStatus(space, [running], state({ tasks: [running] }))).toEqual({ text: "Claude running · Fix" });

  const queued = task();
  const signedOut = wait("signed_out", queued.id, "Claude is signed out.");
  const s = spaceStatus(space, [queued], state({ tasks: [queued], waits: waitsOf([signedOut]) }));
  expect(s.tone).toBe("blocked");
  expect(s.text).toBe("Claude is signed out.");

  const blocked = task({ status: "blocked", blockedReason: "No repo" });
  expect(spaceStatus(space, [blocked], state({ tasks: [blocked] })).text).toBe("Blocked: No repo");

  expect(spaceStatus(space, [], state()).text.startsWith("Idle · last activity ")).toBe(true);
});

const approval = { id: "apr_1", spaceId: "spc_1", taskId: "tsk_1", title: "Task" } as Approval;
const repo = { ...space, kind: "repo" } as Space;
const loop = (over: Partial<NonNullable<Task["loop"]>> = {}) => ({ ...newLoop(SIZE_BUDGETS.medium), ...over });

test("reviewLine says what the checks and the reviewer made of the work", () => {
  const passed = task({ loop: loop({ checks: "passed", reviews: [{ reviewer: "codex", verdict: "approve", findings: [], skipped: null }] }) });
  expect(reviewLine(approval, state({ tasks: [passed], spaces: [repo] }))).toEqual({ text: "Checks passed · reviewed by Codex", tone: "ok" });

  const finding = { severity: "high" as const, file: "a.ts", line: 1, reason: "r", resolution: { action: "fixed" as const, note: "" } };
  const fixed = task({ loop: loop({ checks: "none", reviews: [{ reviewer: "claude", verdict: "changes", findings: [finding, { ...finding, resolution: null }], skipped: null }] }) });
  expect(reviewLine(approval, state({ tasks: [fixed], spaces: [repo] }))).toEqual({ text: "Unverified: no checks found · Claude found 2 to fix, 1 fixed", tone: "waiting" });

  const flagged = task({ loop: loop({ checks: "passed", attention: ["This change edits how checks run: package.json."] }) });
  expect(reviewLine(approval, state({ tasks: [flagged], spaces: [repo] }))?.tone).toBe("bad");
  expect(attentionText(flagged.loop)).toBe("Look closely: This change edits how checks run: package.json.");

  // Work outside the loop has no line.
  expect(reviewLine(approval, state({ tasks: [task()], spaces: [repo] }))).toBeNull();
});

test("agentStatus", () => {
  const info = (over: Partial<Info> = {}) =>
    ({ label: "Claude", installed: true, loggedIn: true, detail: "ok", limitedUntil: null, tokensToday: 0, ...over }) as Info;
  const missing = agentStatus("codex", info({ installed: false }), state());
  expect(missing.tone).toBe("bad");
  expect(missing.text.startsWith("Not installed. ")).toBe(true);
  expect(agentStatus("codex", info({ loggedIn: false }), state()).text.startsWith("Signed out. ")).toBe(true);
  const saving = state({ claudeWindow: { utilization: 0.6, resetsAt: Date.now() + 3600_000, reserve: 0.5 } });
  expect(agentStatus("claude", info(), saving).text.startsWith("Saving your window until ")).toBe(true);
  expect(agentStatus("claude", info(), state())).toEqual({ text: "Ready" });
});

test("runOutcome", () => {
  const run = (over: Partial<Run>) => ({ endedAt: 1, exitCode: 0, ...over }) as Run;
  expect(runOutcome(run({ endedAt: null }))).toBe("running");
  expect(runOutcome(run({ exitCode: 0 }))).toBe("finished");
  expect(runOutcome(run({ exitCode: 1 }))).toBe("ended without finishing");
});

test("distinctWaits drops repeated reasons", () => {
  const tasks = ["t1", "t2", "t3", "t4"].map((id) => task({ id }));
  const waits = [
    wait("limited", "t1", "Claude is limited."),
    wait("limited", "t2", "Claude is limited."),
    wait("limited", "t3", "Claude is limited."),
    wait("signed_out", "t4", "Codex is signed out."),
  ];
  const got = distinctWaits(tasks, state({ tasks, waits: waitsOf(waits) }));
  expect(got.map((w) => w.kind)).toEqual(["signed_out", "limited"]);
});

test("Home is only empty when there are no spaces and nothing waiting", () => {
  expect(emptyHome(state({ spaces: [], proposals: [] } as Partial<State>))).toBe(true);
  const ask = { id: "apr_1", spaceId: null, kind: "question", title: 'Create GitHub repo "demo"?' } as Approval;
  expect(emptyHome(state({ spaces: [], proposals: [], approvals: [ask] } as Partial<State>))).toBe(false);
  expect(emptyHome(state({ spaces: [space], proposals: [] } as Partial<State>))).toBe(false);
});
