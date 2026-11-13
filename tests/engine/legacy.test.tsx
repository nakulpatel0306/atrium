// What a database from before the cut (Markets, Money, Mail and Calendar, texting) still holds, and what the engine
// does with it. Nothing here is migrated away: old tables and rows stay, and are simply never read.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { SpaceView } from "../../src/dashboard/components/SpaceView";
import { BASE_TOOLS, createRunner, recoverOnBoot } from "../../src/engine/runner";
import { createApproval, listPending } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { deleteSpace } from "../../src/engine/delete";
import { listSpaces } from "../../src/engine/spaces";
import { snapshot } from "../../src/engine/state";
import { summary } from "../../src/engine/summary";
import { REMOVED_FEATURE, createTask, getTask, setTaskStatus } from "../../src/engine/tasks";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "../../src/engine/agents/types";
import { deriveView } from "../../src/tui/select";
import { initialUi } from "../../src/tui/ui";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

// Shapes a database like an older install: spaces of kinds that no longer exist, and the tables their features kept.
function legacyInstall() {
  db.exec("PRAGMA ignore_check_constraints = ON");
  db.exec(`INSERT INTO spaces (id, name, kind, goal, color, private, status, created_at, updated_at, folder, folder_ino)
    VALUES ('spc_inv', 'Investing', 'markets', '', '#fff', 0, 'active', 1, 1, NULL, 0),
           ('spc_inb', 'Inbox', 'inbox', '', '#fff', 1, 'active', 2, 2, NULL, 0),
           ('spc_ok', 'Notes', 'general', '', '#fff', 0, 'active', 3, 3, NULL, 0)`);
  db.exec("PRAGMA ignore_check_constraints = OFF");
  db.exec("ALTER TABLE tasks ADD COLUMN purpose TEXT");
  db.exec(`CREATE TABLE market_holdings (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), symbol TEXT);
    CREATE TABLE money_transactions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), amount REAL);
    CREATE TABLE mail_actions (id TEXT PRIMARY KEY, approval_id TEXT REFERENCES approvals(id), space_id TEXT REFERENCES spaces(id), task_id TEXT REFERENCES tasks(id));
    CREATE TABLE message_actions (id TEXT PRIMARY KEY, approval_id TEXT REFERENCES approvals(id), space_id TEXT REFERENCES spaces(id), task_id TEXT REFERENCES tasks(id));
    INSERT INTO market_holdings VALUES ('h1', 'spc_inv', 'SPY'), ('h2', 'spc_ok', 'XEQT');
    INSERT INTO money_transactions VALUES ('t1', 'spc_inv', 12.5);`);
}

const legacyTask = (spaceId: string, purpose: string, status: "queued" | "running" | "done" = "queued") => {
  const t = createTask(db, { spaceId, title: `Old ${purpose} work` });
  db.query("UPDATE tasks SET purpose = ? WHERE id = ?").run(purpose, t.id);
  if (status !== "queued") {
    setTaskStatus(db, t.id, "running");
    if (status === "done") setTaskStatus(db, t.id, "done");
  }
  return t.id;
};

test("a space of a kind that no longer exists reads as a private general space, and nothing crashes", () => {
  legacyInstall();
  const spaces = listSpaces(db, { includeArchived: true });
  expect(spaces.map((s) => [s.name, s.kind, s.private, s.unknownKind])).toEqual([
    ["Investing", "general", true, true],
    ["Inbox", "general", true, true],
    ["Notes", "general", false, false],
  ]);
  const state = snapshot(db);
  expect(state.spaces).toHaveLength(3);
  expect(summary(db).needsYou).toBe(0);
  const view = deriveView(state, initialUi);
  expect(view.spaces.map((s) => s.name)).toEqual(["Investing", "Inbox", "Notes"]);
  const html = renderToStaticMarkup(<SpaceView state={state} space={state.spaces[0]!} focusTask={null} />);
  expect(html).toContain("Investing");
});

test("opening the database again keeps every old table and row, and secure_delete stays on", () => {
  legacyInstall();
  db.close();
  db = openDb();
  expect(db.query("SELECT COUNT(*) AS n FROM market_holdings").get()).toEqual({ n: 2 });
  expect(db.query("SELECT COUNT(*) AS n FROM money_transactions").get()).toEqual({ n: 1 });
  expect(db.query("SELECT COUNT(*) AS n FROM spaces").get()).toEqual({ n: 3 });
  expect(db.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
});

test("a fresh install creates none of the removed features' tables", () => {
  const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  expect(names.filter((n) => /^(market_|money_|mail_|cal_|paper_|message_actions|tfsa_)/.test(n))).toEqual([]);
});

test("deleting an old space clears its rows in the old tables, and only its rows", async () => {
  legacyInstall();
  const task = legacyTask("spc_inv", "money", "done");
  const approval = createApproval(db, { spaceId: "spc_inv", taskId: task, kind: "question", title: "Send an email?", detail: "" });
  db.exec(`INSERT INTO mail_actions VALUES ('m1', '${approval.id}', 'spc_inv', '${task}'); INSERT INTO message_actions VALUES ('x1', NULL, 'spc_inv', '${task}')`);
  const res = await deleteSpace(db, "spc_inv", "Investing");
  expect(res.name).toBe("Investing");
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("SELECT id FROM market_holdings").all()).toEqual([{ id: "h2" }]);
  for (const t of ["money_transactions", "mail_actions", "message_actions"]) expect(db.query(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
  expect(listSpaces(db).map((s) => s.name)).toEqual(["Inbox", "Notes"]);
});

test("a pending approval from a removed feature isn't listed, and the row is kept", () => {
  legacyInstall();
  db.exec("PRAGMA ignore_check_constraints = ON");
  db.exec(`INSERT INTO approvals (id, space_id, kind, title, detail, created_at, always_ask) VALUES ('apr_t', 'spc_ok', 'question', 'Send a text?', '', 1, 'send_message')`);
  db.exec(`INSERT INTO approvals (id, space_id, kind, title, detail, created_at) VALUES ('apr_a', 'spc_inv', 'alert', 'AAPL above $200', '', 2)`);
  db.exec("PRAGMA ignore_check_constraints = OFF");
  const real = createApproval(db, { spaceId: "spc_ok", kind: "question", title: "Which folder?", detail: "" });
  expect(listPending(db).map((a) => a.id)).toEqual([real.id]);
  expect(db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 3 });
});

test("on boot, waiting and running tasks of removed features end with a plain note and keep their rows", async () => {
  legacyInstall();
  const queued = legacyTask("spc_inv", "money");
  const running = legacyTask("spc_inb", "inbox", "running");
  const done = legacyTask("spc_inv", "digest", "done");
  const plain = createTask(db, { spaceId: "spc_ok", title: "Plain work" }).id;
  await recoverOnBoot(db);
  for (const id of [queued, running]) expect(getTask(db, id)).toMatchObject({ status: "failed", blockedReason: REMOVED_FEATURE });
  expect(getTask(db, done)!.status).toBe("done");
  expect(getTask(db, plain)!.status).toBe("queued");
  expect(db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 4 });
});

test("a database that never had a purpose column boots without touching tasks", async () => {
  const t = createTask(db, { spaceId: createSpaceId(), title: "x" });
  await recoverOnBoot(db);
  expect(getTask(db, t.id)!.status).toBe("queued");
});

function createSpaceId() {
  db.exec("INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_p', 'P', 'general', 'x', 1, 1)");
  return "spc_p";
}

function startRunner(adapter: AgentAdapter) {
  const runner = createRunner({ db, adapters: { claude: adapter }, power: async () => "ac", keepAwake: { start() {}, stop() {}, active: () => false } });
  runner.start();
  return runner;
}

const waitFor = async (cond: () => boolean) => {
  const until = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

test("the runner refuses a task whose purpose belongs to a removed feature, whatever tools it once had", async () => {
  legacyInstall();
  const calls: AgentRunInput[] = [];
  const adapter: AgentAdapter = {
    id: "claude",
    label: "Claude Code",
    async run(input): Promise<AgentRunResult> {
      calls.push(input);
      return { status: "ok", summary: "Done.", inputTokens: 1, outputTokens: 1 };
    },
  };
  const id = legacyTask("spc_ok", "message");
  const runner = startRunner(adapter);
  try {
    await waitFor(() => getTask(db, id)!.status === "failed");
    expect(getTask(db, id)!.blockedReason).toBe(REMOVED_FEATURE);
    expect(calls).toHaveLength(0);
  } finally {
    await runner.stop();
  }
});

test("a task in a space of a removed kind runs with no more than the base tools, in a private space", async () => {
  legacyInstall();
  const calls: AgentRunInput[] = [];
  const adapter: AgentAdapter = {
    id: "claude",
    label: "Claude Code",
    async run(input): Promise<AgentRunResult> {
      calls.push(input);
      return { status: "ok", summary: "Done.\nOUTCOME: done", inputTokens: 1, outputTokens: 1 };
    },
  };
  const t = createTask(db, { spaceId: "spc_inv", title: "Tidy the notes" });
  const runner = startRunner(adapter);
  try {
    await waitFor(() => getTask(db, t.id)!.status === "review");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.allowedTools).toEqual(BASE_TOOLS);
    expect(calls[0]!.privateData).toBe(true);
  } finally {
    await runner.stop();
  }
});
