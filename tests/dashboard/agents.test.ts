import { expect, test } from "bun:test";
import { agentText, byPriority, needsAction, type Wait, waitOf } from "../../src/dashboard/agents";
import type { State } from "../../src/dashboard/api";

type Task = State["tasks"][number];
type Run = State["runs"][number];

const task = (over: Partial<Task> = {}) => ({ id: "tsk_1", status: "queued", agent: "auto", ...over }) as Task;
const wait = (kind: Wait["kind"], taskId = "tsk_1"): Wait => ({ taskId, agent: "claude", kind, reason: kind });
const state = (waits: Wait[]) => ({ waits: Object.fromEntries(waits.map((w) => [w.taskId, w])) }) as unknown as State;

test("a task's wait comes from the engine, and only while it's still queued", () => {
  const s = state([wait("reserve")]);
  expect(waitOf(task(), s)?.kind).toBe("reserve");
  expect(waitOf(task({ status: "running" }), s)).toBeNull();
  expect(waitOf(task({ id: "tsk_2" }), s)).toBeNull();
});

test("waits Nakul has to act on sort first and are marked as such", () => {
  const sorted = [wait("busy"), wait("reserve"), wait("signed_out"), wait("limited")].sort(byPriority).map((w) => w.kind);
  expect(sorted).toEqual(["signed_out", "limited", "reserve", "busy"]);
  expect(needsAction(wait("env_files"))).toBe(true);
  expect(needsAction(wait("power"))).toBe(false);
});

test("an auto task shows the agent that ran it", () => {
  const runs = [{ taskId: "tsk_1", agent: "codex" }] as Run[];
  expect(agentText(task(), runs)).toBe("Auto → Codex");
  expect(agentText(task(), [])).toBe("Auto");
  expect(agentText(task({ agent: "claude" }), [{ taskId: "tsk_1", agent: "claude" }] as Run[])).toBe("Claude");
});
