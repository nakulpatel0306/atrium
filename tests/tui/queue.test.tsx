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

// Two finished results: one clean (checks passed, reviewer approved), one with a note on what it did to its checks.
function results() {
  const state = makeState();
  const review = state.approvals[0]!;
  const loop = (over: object) => ({ ...newLoop(SIZE_BUDGETS.small), stage: "ready" as const, checks: "passed" as const, reviews: [{ reviewer: "codex", verdict: "approve" as const, findings: [], skipped: null }], ...over });
  state.tasks = state.tasks.map((t) => (t.id === ids.review ? { ...t, outcome: "done" as const, loop: loop({ checkedSha: "sha_1" }) } : t));
  state.tasks.push(task({ id: "tsk_two", title: "Second", status: "review", outcome: "done", loop: loop({ checkedSha: "sha_2" }) }));
  state.tasks.push(task({ id: "tsk_noted", title: "Noted", status: "review", outcome: "done", loop: loop({ checkedSha: "sha_3", attention: ["The change edits check config: bunfig.toml."] }) }));
  state.approvals = [review, { ...review, id: "apr_two", taskId: "tsk_two", title: "Review: Second", createdAt: review.createdAt + 1 }, { ...review, id: "apr_noted", taskId: "tsk_noted", title: "Review: Noted", createdAt: review.createdAt + 2 }];
  return state;
}

test("a risky result takes a second a to approve, as in the dashboard", async () => {
  const client = fakeClient(results());
  const app = openApp(client);
  await app.frame((f) => f.includes("Review: Noted"));
  await app.type("j");
  await app.type("j");
  await app.type("a");
  await app.frame((f) => f.includes("again to approve") && f.includes("bunfig.toml"));
  expect(client.calls.some((c) => c.path === "/api/approvals/apr_noted")).toBe(false);
  await app.type("a");
  await app.frame(() => client.calls.some((c) => c.path === "/api/approvals/apr_noted"));
});

test("Esc or moving away disarms a risky approval, so the next a asks again", async () => {
  const client = fakeClient(results());
  const app = openApp(client);
  await app.frame((f) => f.includes("Review: Noted"));
  await app.type("j");
  await app.type("j");
  await app.type("a");
  await app.frame((f) => f.includes("again to approve"));
  await app.type("\x1b");
  await app.frame((f) => !f.includes("again to approve"));
  await app.type("a");
  await app.frame((f) => f.includes("again to approve"));
  await app.type("k");
  await app.frame((f) => !f.includes("again to approve"));
  expect(client.calls.some((c) => c.path === "/api/approvals/apr_noted")).toBe(false);
});

test("Shift-A lists the clean results and a second Shift-A approves them at the commits shown", async () => {
  const client = fakeClient(results());
  client.respond("/api/approvals/batch", { ok: true, data: { approved: [ids.approval], skipped: [{ id: "apr_two", reason: "Its branch changed." }] } });
  const app = openApp(client);
  await app.frame((f) => f.includes("Review: Second"));
  await app.type("A");
  const f = await app.frame((f) => f.includes("Approve clean results"));
  expect(f).toContain("• Review: Second");
  expect(f).not.toContain("• Review: Noted");
  await app.type("A");
  await app.frame(() => client.calls.some((c) => c.path === "/api/approvals/batch"));
  expect(client.calls.find((c) => c.path === "/api/approvals/batch")!.body).toEqual({ items: [{ id: ids.approval, sha: "sha_1" }, { id: "apr_two", sha: "sha_2" }] });
  // What the engine left is said plainly.
  await app.frame((f) => f.includes("Approved 1. Left for you to read: Review: Second."));
});
