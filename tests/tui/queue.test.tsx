import { afterEach, expect, test } from "bun:test";
import { cleanup } from "ink-testing-library";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import { fakeClient } from "./fake-client";
import { ids, makeState, task } from "./fixtures";
import { openApp } from "./harness";

afterEach(() => cleanup());

const old = Date.now() - 120 * 60_000;

// The fixture's review plus a paused task that has waited longer and an open CLAUDE.md proposal.
function queued() {
  const state = makeState();
  state.tasks.push(task({ id: "tsk_paused", title: "Rewrite ranking", status: "blocked", updatedAt: old, loop: { ...newLoop(SIZE_BUDGETS.small), paused: { kind: "budget", diagnosis: "Another turn would go over the 200k token budget." } } }));
  state.learning = { ...state.learning, memory: [{ id: "mem_1", spaceId: ids.atrium, taskId: null, source: "steer", line: "Use the wait() helper in tests.", why: "You steered.", status: "open", branch: null, commitSha: null, createdAt: old }] };
  return state;
}

test("Home lists the queue longest-waiting first, counts only what holds work up, and e explains a pause", async () => {
  const client = fakeClient(queued());
  const app = openApp(client);
  const f = await app.frame((f) => f.includes("Rewrite ranking") && f.includes("Add a line to CLAUDE.md?"));
  expect(f).toMatch(/NEEDS YOU\s+2/);
  expect(f.indexOf("Rewrite ranking")).toBeLessThan(f.indexOf("Review: Fix login redirect"));
  expect(f.indexOf("Review: Fix login redirect")).toBeLessThan(f.indexOf("Add a line to CLAUDE.md?"));
  await app.frame((f) => f.includes("e  Explain the problem"));
  await app.type("e");
  await app.frame(() => client.calls.some((c) => c.path === "/api/tasks/tsk_paused/explain"));
});

test("y adds a proposed CLAUDE.md line from Home", async () => {
  const client = fakeClient(queued());
  const app = openApp(client);
  await app.frame((f) => f.includes("Add a line to CLAUDE.md?"));
  await app.type("j");
  await app.type("j");
  await app.frame((f) => f.includes("y  Add it"));
  await app.type("y");
  await app.frame(() => client.calls.some((c) => c.path === "/api/memory/mem_1"));
  expect(client.calls).toContainEqual({ method: "POST", path: "/api/memory/mem_1", body: { action: "accept", line: "Use the wait() helper in tests." } });
});
