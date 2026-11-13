import { expect, test } from "bun:test";
import { runIntent } from "../../src/tui/effects";
import type { Intent } from "../../src/tui/keys";
import { fakeClient } from "./fake-client";
import { ids, makeState } from "./fixtures";

const state = makeState();

type Row = { intent: Intent; method: string; path: string; body?: unknown; text: string; data?: unknown };

const rows: Row[] = [
  { intent: { type: "approve", approvalId: ids.approval, title: "Review: Fix login redirect" }, method: "POST", path: `/api/approvals/${ids.approval}`, body: { decision: "approve" }, text: 'Approved "Review: Fix login redirect".' },
  { intent: { type: "reject", approvalId: ids.approval, note: " tighten it " }, method: "POST", path: `/api/approvals/${ids.approval}`, body: { decision: "reject", note: "tighten it" }, text: "Sent back with your note." },
  { intent: { type: "reject", approvalId: ids.approval, note: "  " }, method: "POST", path: `/api/approvals/${ids.approval}`, body: { decision: "reject" }, text: "Sent back." },
  { intent: { type: "retry", taskId: ids.blocked }, method: "POST", path: `/api/tasks/${ids.blocked}/retry`, text: 'Queued "Summarize postings" again.' },
  { intent: { type: "runNow", taskId: ids.queued }, method: "POST", path: `/api/tasks/${ids.queued}/run-now`, text: `Starting "Add tests" now, using Claude's reserved window.` },
  { intent: { type: "newTask", spaceId: ids.atrium, text: "Add a README", agent: "claude" }, method: "POST", path: "/api/command", body: { text: "Add a README", spaceId: ids.atrium, agent: "claude" }, data: { task: { title: "Add a README" } }, text: 'Queued "Add a README" in atrium for Claude.' },
  { intent: { type: "newTask", spaceId: ids.atrium, text: "Add a README", agent: "auto" }, method: "POST", path: "/api/command", body: { text: "Add a README", spaceId: ids.atrium, agent: "auto" }, data: { task: { title: "Add a README" } }, text: 'Queued "Add a README" in atrium.' },
  { intent: { type: "newSpace", text: "keep my reading list" }, method: "POST", path: "/api/command", body: { text: "keep my reading list" }, data: { space: { id: "spc_new", name: "reading" }, tasks: [] }, text: "Set up reading." },
  { intent: { type: "answerBrief", taskId: ids.queued, title: "Add tests", answers: [{ question: "Unit or e2e?", answer: "Unit" }] }, method: "POST", path: `/api/tasks/${ids.queued}/answers`, body: { answers: [{ question: "Unit or e2e?", answer: "Unit" }] }, text: 'Started "Add tests" with your answers.' },
  { intent: { type: "answerBrief", taskId: ids.queued, title: "Add tests", answers: [] }, method: "POST", path: `/api/tasks/${ids.queued}/answers`, body: { answers: [] }, text: 'Started "Add tests" leaving the questions to the agent.' },
  { intent: { type: "answerBrief", taskId: ids.queued, title: "Add tests", answers: [], shape: "split" }, method: "POST", path: `/api/tasks/${ids.queued}/answers`, body: { answers: [], shape: "split" }, text: 'Started "Add tests" as split into tasks.' },
  { intent: { type: "answerBrief", taskId: ids.queued, title: "Add tests", answers: [], shape: "single" }, method: "POST", path: `/api/tasks/${ids.queued}/answers`, body: { answers: [], shape: "single" }, text: 'Started "Add tests" with one writer.' },
  { intent: { type: "setAgent", taskId: ids.queued, agent: "codex" }, method: "PATCH", path: `/api/tasks/${ids.queued}`, body: { agent: "codex" }, text: 'Codex will take "Add tests".' },
  { intent: { type: "overnight", on: true }, method: "POST", path: "/api/settings", body: { overnight: true }, text: "Overnight mode on. Leave the lid open; your Mac stays awake while plugged in and work is queued." },
  { intent: { type: "overnight", on: false }, method: "POST", path: "/api/settings", body: { overnight: false }, text: "Overnight mode off." },
  { intent: { type: "reserve", value: 0.75 }, method: "POST", path: "/api/settings", body: { claudeReserve: 0.75 }, text: "Claude tasks now pause at 75% of the window." },
  { intent: { type: "private", spaceId: ids.atrium, on: true }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { private: true }, text: "atrium is private now. Only Claude works here." },
  { intent: { type: "private", spaceId: ids.atrium, on: false }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { private: false }, text: "atrium is no longer private." },
  { intent: { type: "goal", spaceId: ids.atrium, goal: "Ship it" }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { goal: "Ship it" }, text: "Goal saved." },
  { intent: { type: "reviewer", spaceId: ids.atrium, reviewBy: "gemini" }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { reviewBy: "gemini" }, text: "Gemini reviews finished code in atrium." },
  { intent: { type: "reviewer", spaceId: ids.atrium, reviewBy: "auto" }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { reviewBy: "auto" }, text: "A fresh agent reviews finished code in atrium." },
  { intent: { type: "reviewer", spaceId: ids.atrium, reviewBy: "off" }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { reviewBy: "off" }, text: "No review in atrium: finished code comes to you once its checks pass." },
  { intent: { type: "archive", spaceId: ids.atrium }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { status: "archived" }, text: "Archived atrium. It's at the end of Spaces; press X there to restore it." },
  { intent: { type: "restore", spaceId: ids.atrium }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { status: "active" }, text: "Restored the space. Press X to archive it again." },
  { intent: { type: "stop", taskId: ids.running }, method: "POST", path: `/api/tasks/${ids.running}/stop`, data: { status: "blocked" }, text: 'Stopped "Add the status bar". Its edits so far are kept; R retries it.' },
  { intent: { type: "stop", taskId: ids.running }, method: "POST", path: `/api/tasks/${ids.running}/stop`, data: { status: "running" }, text: `Stopping "Add the status bar": the agent hasn't exited yet. Atrium marks it stopped when it does.` },
];

for (const row of rows) {
  test(`${row.intent.type} sends ${row.method} ${row.path} and says "${row.text}"`, async () => {
    const client = fakeClient(state);
    if (row.data) client.respond(row.path, { ok: true, data: row.data });
    const flash = await runIntent(client, row.intent, state);
    expect(client.calls).toEqual([row.body === undefined ? { method: row.method, path: row.path } : { method: row.method, path: row.path, body: row.body }]);
    expect(flash).toMatchObject({ tone: "ok", text: row.text });
  });
}

test("a decision made elsewhere reads plainly", async () => {
  const client = fakeClient(state);
  client.respond(`/api/approvals/${ids.approval}`, { ok: false, error: "Already handled" });
  expect(await runIntent(client, { type: "approve", approvalId: ids.approval, title: "x" }, state)).toEqual({
    tone: "bad",
    text: "Already handled. It was decided somewhere else.",
  });
});

test("other failures pass the engine's words through", async () => {
  const client = fakeClient(state);
  client.respond(`/api/tasks/${ids.queued}`, { ok: false, error: "This task has already started, so its agent can't change." });
  expect(await runIntent(client, { type: "setAgent", taskId: ids.queued, agent: "codex" }, state)).toEqual({
    tone: "bad",
    text: "This task has already started, so its agent can't change.",
  });
});

test("a new space says which space to select", async () => {
  const client = fakeClient(state);
  client.respond("/api/command", { ok: true, data: { space: { id: "spc_new", name: "reading" }, tasks: [] } });
  expect(await runIntent(client, { type: "newSpace", text: "reading" }, state)).toMatchObject({ spaceId: "spc_new" });
});

test("a drafted project says where it waits, and selects no space", async () => {
  const client = fakeClient(state);
  client.respond("/api/command", { ok: true, data: { draft: { id: "rpa_1", draft: { name: "demo" } }, approval: { id: "apr_1" } } });
  const flash = await runIntent(client, { type: "newSpace", text: "start a new project called demo" }, state);
  expect(flash).toEqual({ tone: "ok", text: 'Drafted "demo". It\'s waiting in Needs you.' });
});

test("a stop that came too late says so in the engine's words", async () => {
  const client = fakeClient(state);
  client.respond(`/api/tasks/${ids.running}/stop`, { ok: false, error: "It finished before it could be stopped, so its result stands." });
  expect(await runIntent(client, { type: "stop", taskId: ids.running }, state)).toEqual({ tone: "bad", text: "It finished before it could be stopped, so its result stands." });
});
