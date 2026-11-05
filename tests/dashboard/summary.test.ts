import { expect, test } from "bun:test";
import type { Wait } from "../../src/dashboard/agents";
import type { Message, State } from "../../src/dashboard/api";
import {
  agentStatus,
  distinctWaits,
  orderedTasks,
  reviewLine,
  reviewTarget,
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

const review = (over: Partial<Task> = {}) =>
  task({ id: "tsk_rev", kind: "review", parentTaskId: "tsk_1", agent: "codex", status: "running", ...over });
const approval = { id: "apr_1", spaceId: "spc_1", taskId: "tsk_1", title: "Review: Task" } as Approval;
const msg = (body: string, fromAgent = "codex") => ({ id: "m", fromAgent, toAgent: "claude", body }) as Message;

test("reviewLine follows the review and the fix", () => {
  const running = state({ tasks: [task(), review()] });
  expect(reviewLine(approval, running, null)).toEqual({
    text: "Codex is reviewing · you can decide now",
    tone: "waiting",
    fixing: false,
  });

  const done = state({ tasks: [task(), review({ status: "done" })] });
  expect(reviewLine(approval, done, null)?.text).toBe("Reviewed by Codex");
  const approved = reviewLine(approval, done, [msg("Looks good.\nVERDICT: approve")]);
  expect(approved?.text).toBe("Reviewed by Codex · approve");
  expect(approved?.tone).toBe("ok");

  const fix = task({ id: "tsk_fix", kind: "fix", parentTaskId: "tsk_1", agent: "claude", status: "done" });
  const fixed = reviewLine(approval, state({ tasks: [task(), review({ status: "done" }), fix] }), null);
  expect(fixed?.text).toBe("Codex asked for changes · Claude fixed them");
  expect(fixed?.fixing).toBe(true);

  expect(reviewLine(approval, state({ tasks: [task()] }), null)).toBeNull();
});

test("reviewTarget asks for the thread only once the review is done without a fix", () => {
  expect(reviewTarget(approval, state({ tasks: [task(), review()] }))).toBeNull();
  expect(reviewTarget(approval, state({ tasks: [task(), review({ status: "done" })] }))).toBe("tsk_1");
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
