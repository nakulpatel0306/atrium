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
  { intent: { type: "setAgent", taskId: ids.queued, agent: "codex" }, method: "PATCH", path: `/api/tasks/${ids.queued}`, body: { agent: "codex" }, text: 'Codex will take "Add tests".' },
  { intent: { type: "overnight", on: true }, method: "POST", path: "/api/settings", body: { overnight: true }, text: "Overnight mode on. Leave the lid open; your Mac stays awake while plugged in and work is queued." },
  { intent: { type: "overnight", on: false }, method: "POST", path: "/api/settings", body: { overnight: false }, text: "Overnight mode off." },
  { intent: { type: "reserve", value: 0.75 }, method: "POST", path: "/api/settings", body: { claudeReserve: 0.75 }, text: "Claude tasks now pause at 75% of the window." },
  { intent: { type: "private", spaceId: ids.atrium, on: true }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { private: true }, text: "atrium is private now. Only Claude works here." },
  { intent: { type: "private", spaceId: ids.atrium, on: false }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { private: false }, text: "atrium is no longer private." },
  { intent: { type: "goal", spaceId: ids.atrium, goal: "Ship it" }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { goal: "Ship it" }, text: "Goal saved." },
  { intent: { type: "reviewer", spaceId: ids.atrium, reviewBy: "gemini" }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { reviewBy: "gemini" }, text: "Gemini reviews finished work in atrium." },
  { intent: { type: "reviewer", spaceId: ids.atrium, reviewBy: null }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { reviewBy: null }, text: "No automatic review in atrium." },
  { intent: { type: "archive", spaceId: ids.atrium }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { status: "archived" }, text: "Archived atrium. It's at the end of Spaces; press X there to restore it." },
  { intent: { type: "restore", spaceId: ids.atrium }, method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { status: "active" }, text: "Restored the space. Press X to archive it again." },
  { intent: { type: "stop", taskId: ids.running }, method: "POST", path: `/api/tasks/${ids.running}/stop`, data: { status: "blocked" }, text: 'Stopped "Add the status bar". Its edits so far are kept; R retries it.' },
  { intent: { type: "stop", taskId: ids.running }, method: "POST", path: `/api/tasks/${ids.running}/stop`, data: { status: "running" }, text: `Stopping "Add the status bar": the agent hasn't exited yet. Atrium marks it stopped when it does.` },
  { intent: { type: "dismissNudge", spaceId: "spc_inv", nudgeId: "mnd_1" }, method: "POST", path: "/api/investing/spc_inv/money/nudges/mnd_1/dismiss", text: "Dismissed. It won't come back for this month." },
  { intent: { type: "explain", spaceId: "spc_inv", month: "2026-10" }, method: "POST", path: "/api/investing/spc_inv/money/explain", body: { month: "2026-10" }, text: "Claude is explaining your month. The answer shows up here." },
  { intent: { type: "moneyAsk", spaceId: "spc_inv", question: "Where did it go?" }, method: "POST", path: "/api/investing/spc_inv/money/ask", body: { question: "Where did it go?" }, text: "Claude is looking at your money. The answer shows up here." },
  { intent: { type: "budget", spaceId: "spc_inv", category: "Dining", limit: 1200 }, method: "PUT", path: "/api/investing/spc_inv/money/budgets", body: { category: "Dining", limit: 1200 }, text: "Dining budget set to CA$1,200 a month." },
  { intent: { type: "budget", spaceId: "spc_inv", category: "Dining", limit: null }, method: "PUT", path: "/api/investing/spc_inv/money/budgets", body: { category: "Dining", limit: null }, text: "No budget for Dining now." },
  { intent: { type: "importCsv", spaceId: "spc_inv", csv: "a,b", account: "Amex" }, method: "POST", path: "/api/investing/spc_inv/money/import", body: { csv: "a,b", account: "Amex" }, data: { added: 20, duplicates: 2 }, text: "Imported 20 rows, skipped 2 already there." },
  { intent: { type: "investAsk", spaceId: "spc_inv", key: "SHOP.TO", question: "Why?" }, method: "POST", path: "/api/investing/spc_inv/symbol/SHOP.TO/ask", body: { question: "Why?" }, text: "Asked Claude about SHOP.TO. The answer lands in the Investing space." },
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

test("importing by path reads the file here, previews it through the engine, and shows counts only", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "atrium-csv-"));
  const file = join(dir, "td.csv");
  writeFileSync(file, "10/01/2026,NO FRILLS,12.00,,100.00\n");
  try {
    const client = fakeClient(state);
    client.respond("/api/investing/spc_inv/money/preview", { ok: true, data: { format: "bank", bank: { label: "TD chequing or credit card" }, accounts: ["TD chequing"], account: "TD chequing", total: 1, skipped: [], warnings: [], rows: [{ description: "NO FRILLS" }] } });
    const out = await runIntent(client, { type: "importPreview", spaceId: "spc_inv", path: file }, state);
    expect(client.calls).toEqual([{ method: "POST", path: "/api/investing/spc_inv/money/preview", body: { csv: "10/01/2026,NO FRILLS,12.00,,100.00\n" } }]);
    expect(out.overlay).toEqual({ kind: "confirm", purpose: "import", targetId: "spc_inv", csv: "10/01/2026,NO FRILLS,12.00,,100.00\n", account: "TD chequing", summary: ["TD chequing or credit card · 1 row", "Into TD chequing. Change the account on the dashboard if that's wrong."] });
    // No row's text is ever shown, only counts.
    expect(JSON.stringify(out.overlay && "summary" in out.overlay ? out.overlay.summary : [])).not.toContain("NO FRILLS");
    const missing = await runIntent(fakeClient(state), { type: "importPreview", spaceId: "spc_inv", path: join(dir, "nope.csv") }, state);
    expect(missing.tone).toBe("bad");
    expect(missing.text).toStartWith("There's no file at ");
    const unknown = fakeClient(state);
    unknown.respond("/api/investing/spc_inv/money/preview", { ok: true, data: { format: "unknown", bank: { label: "?" }, accounts: [], account: null, total: 0, skipped: [], warnings: ["Atrium couldn't find date, description and amount columns. Pick them below."] } });
    expect((await runIntent(unknown, { type: "importPreview", spaceId: "spc_inv", path: file }, state)).text).toContain("Import it from the dashboard's Money tab");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop that came too late says so in the engine's words", async () => {
  const client = fakeClient(state);
  client.respond(`/api/tasks/${ids.running}/stop`, { ok: false, error: "It finished before it could be stopped, so its result stands." });
  expect(await runIntent(client, { type: "stop", taskId: ids.running }, state)).toEqual({ tone: "bad", text: "It finished before it could be stopped, so its result stands." });
});

test("a dragged-in path with shell escapes or quotes finds the file", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "atrium-csv-"));
  const file = join(dir, "Statement (1) & 'Oct' [TD].csv");
  writeFileSync(file, "x\n");
  try {
    const escaped = file.replace(/([ ()&'[\]])/g, "\\$1");
    for (const path of [escaped, `'${file}'`, `"${file}"`]) {
      const client = fakeClient(state);
      client.respond("/api/investing/spc_inv/money/preview", { ok: false, error: "read it" });
      expect((await runIntent(client, { type: "importPreview", spaceId: "spc_inv", path }, state)).text).toBe("read it");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
