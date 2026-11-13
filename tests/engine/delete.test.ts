import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApproval, resolveApproval } from "../../src/engine/approvals";
import { config } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { DeleteRefused, deleteSpace, deleteTask, HANDLED, spaceDeletePreview, taskDeletePreview } from "../../src/engine/delete";
import { finishPendingDeletes, queueDelete } from "../../src/engine/delete-files";
import { listActivity, logActivity } from "../../src/engine/events";
import { ensureSpaceFolder } from "../../src/engine/folders";
import { newId } from "../../src/engine/ids";
import { draftMessage, setMessageStatus } from "../../src/engine/messaging/store";
import { recordRunFiles } from "../../src/engine/outputs/store";
import { createCloner } from "../../src/engine/repos/clones";
import { listClones } from "../../src/engine/repos/store";
import { setSetting, getSetting } from "../../src/engine/settings";
import { createSpace, getSpace, listSpaces, type Space } from "../../src/engine/spaces";
import { createTask, getTask, setTaskStatus } from "../../src/engine/tasks";
import { tempHome, tempRepo } from "../helpers";
import { fakeGitHub, seedRemote } from "../repos-helpers";

setDefaultTimeout(30_000);

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

const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const tables = () => (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
const count = (sql: string, ...p: string[]) => (db.query(sql).get(...p) as { n: number }).n;

// A run of a task with a transcript file, as the runner leaves one.
function addRun(taskId: string): { id: string; transcript: string } {
  const id = newId("run");
  const transcript = join(config().transcriptsDir, `${id}.log`);
  writeFileSync(transcript, "agent output\n");
  db.query("INSERT INTO runs (id, task_id, agent, started_at, ended_at, exit_code, transcript_path) VALUES (?, ?, 'claude', ?, ?, 0, ?)").run(id, taskId, Date.now(), Date.now(), transcript);
  return { id, transcript };
}

// A space with a row in every table that can point at it, the way real use fills them.
function fullSpace(name: string): { space: Space; task: string; review: string; run: string; transcript: string } {
  const space = createSpace(db, { name, kind: "general", goal: "g" });
  const task = createTask(db, { spaceId: space.id, title: `${name} work` }).id;
  const { id: run, transcript } = addRun(task);
  const approval = createApproval(db, { spaceId: space.id, taskId: task, kind: "review", title: "Review it", detail: "" });
  const review = createTask(db, { spaceId: space.id, title: `Review: ${name}`, kind: "review", parentTaskId: task, approvalId: approval.id } as Parameters<typeof createTask>[1]).id;
  db.query("UPDATE tasks SET approval_id = ? WHERE id = ?").run(approval.id, review);
  logActivity(db, space.id, "claude", `Started: ${name} work`, { taskId: task });
  db.query("INSERT INTO messages (id, space_id, task_id, from_agent, to_agent, body, created_at) VALUES (?, ?, ?, 'claude', 'codex', 'hi', 0)").run(newId("msg"), space.id, task);
  db.query("INSERT INTO attachments (id, space_id, task_id, path, name, size, type, created_at) VALUES (?, ?, ?, 'Attachments/r.png', 'r.png', 1, 'image/png', 0)").run(newId("att"), space.id, task);
  const now = Date.now();
  const proposal = newId("prp");
  db.query("INSERT INTO autonomy_proposals (id, space_id, fingerprint, evidence, created_at) VALUES (?, ?, 'fp', '[]', ?)").run(proposal, space.id, now);
  const rule = newId("rul");
  db.query("INSERT INTO autonomy_rules (id, space_id, fingerprint, proposal_id, created_at, expires_at) VALUES (?, ?, 'fp', ?, ?, ?)").run(rule, space.id, proposal, now, now + 1);
  db.query("UPDATE approvals SET rule_id = ? WHERE id = ?").run(rule, approval.id);
  db.query("INSERT INTO rule_events (id, space_id, rule_id, approval_id, event, actor, created_at) VALUES (?, ?, ?, ?, 'applied', 'atrium', ?)").run(newId("rle"), space.id, rule, approval.id, now);
  recordRunFiles(db, { runId: run, taskId: task, spaceId: space.id, root: "space" }, [{ path: "list.md", change: "created", size: 4 }]);
  draftMessage(db, { spaceId: space.id, taskId: task, toName: "Dana", text: "Hey" });
  const mailApproval = createApproval(db, { spaceId: space.id, taskId: task, kind: "question", title: "Send an email to Dana?", detail: "", alwaysAsk: "send_message" });
  db.query("INSERT INTO mail_actions (id, approval_id, space_id, task_id, kind, status, drafted_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'new', 'draft', 'claude', ?, ?)").run(newId("mla"), mailApproval.id, space.id, task, now, now);
  const repoApproval = createApproval(db, { spaceId: null, kind: "question", title: "Create repo?", detail: "", alwaysAsk: "create_repo" });
  db.query("INSERT INTO repo_actions (id, kind, status, approval_id, space_id, created_at, updated_at) VALUES (?, 'create', 'done', ?, ?, ?, ?)").run(newId("rpa"), repoApproval.id, space.id, now, now);
  const list = newId("lst");
  db.query("INSERT INTO market_lists (id, space_id, name, position, created_at) VALUES (?, ?, 'L', 0, ?)").run(list, space.id, now);
  db.query("INSERT INTO market_watchlist (list_id, space_id, symbol, exchange, added_at) VALUES (?, ?, 'AAPL', 'US', ?)").run(list, space.id, now);
  db.query("INSERT INTO market_holdings (id, space_id, account, symbol, exchange, quantity, currency, source, updated_at) VALUES (?, ?, 'TFSA', 'AAPL', 'US', 1, 'USD', 'manual', ?)").run(newId("hld"), space.id, now);
  db.query("INSERT INTO market_alerts (id, space_id, key, rule, created_at) VALUES (?, ?, 'AAPL', '{}', ?)").run(newId("alr"), space.id, now);
  db.query("INSERT INTO paper_accounts (space_id, starting_cash, reset_at) VALUES (?, 1000, ?)").run(space.id, now);
  db.query("INSERT INTO paper_fills (id, space_id, symbol, side, qty, price, quote_at, source, actor, task_id, reasoning, created_at) VALUES (?, ?, 'AAPL', 'buy', 1, 1, 0, 'demo', 'claude', ?, 'r', ?)").run(newId("pf"), space.id, task, now);
  db.query("INSERT INTO market_strategies (id, space_id, name, rules, symbols, cadence, max_position_value, max_trades_per_day, created_at, updated_at) VALUES (?, ?, 'S', 'r', 'AAPL', 'open', 1, 1, ?, ?)").run(newId("str"), space.id, now, now);
  db.query("INSERT INTO research_notes (space_id, key, updated_at) VALUES (?, 'AAPL', ?)").run(space.id, now);
  db.query("INSERT INTO market_writeups (id, space_id, kind, key, for_date, body, task_id, created_at) VALUES (?, ?, 'digest', 'k', 'd', 'b', ?, ?)").run(newId("wu"), space.id, task, now);
  db.query("INSERT INTO market_ideas (space_id, key, stage, stage_at, created_at) VALUES (?, 'AAPL', 'watching', ?, ?)").run(space.id, now, now);
  db.query("INSERT INTO money_transactions (id, space_id, source, account, date, description, merchant, amount, kind, fingerprint, imported_at) VALUES (?, ?, 'bank', 'a', 'd', 'x', 'm', 1, 'spend', ?, ?)").run(newId("mt"), space.id, newId("fp"), now);
  db.query("INSERT INTO money_imports (id, space_id, account, first_date, last_date, rows, imported_at) VALUES (?, ?, 'a', 'd', 'd', 1, ?)").run(newId("mi"), space.id, now);
  db.query("INSERT INTO money_budgets (space_id, category, monthly_limit, updated_at) VALUES (?, 'Dining', 100, ?)").run(space.id, now);
  db.query("INSERT INTO money_accounts (space_id, name, kind, institution, created_at) VALUES (?, 'Everyday', 'chequing', '', ?)").run(space.id, now);
  db.query("INSERT INTO money_nudges (id, space_id, kind, key, title, body, created_at) VALUES (?, ?, 'import', 'k', 't', 'b', ?)").run(newId("mn"), space.id, now);
  ensureSpaceFolder(db, space);
  writeFileSync(join(space.folder!, "list.md"), "eggs");
  return { space, task, review, run, transcript };
}

test("every table that points at a space, task or run is handled", () => {
  const point = (col: string) => tables().filter((t) => columns(t).includes(col) && !(t === "tasks" && col === "task_id")).sort();
  expect(point("space_id")).toEqual([...HANDLED.space].sort());
  expect([...point("task_id"), "tasks"].sort()).toEqual([...HANDLED.task].sort());
  expect(point("run_id")).toEqual([...HANDLED.run].sort());
});

test("deleting a space removes every row about it, its transcripts and its folder, and nothing else", async () => {
  const gone = fullSpace("Text Dana");
  const kept = fullSpace("Groceries");
  setSetting(db, "messaging.spaceId", gone.space.id);
  const before = Object.fromEntries(tables().map((t) => [t, count(`SELECT COUNT(*) AS n FROM ${t}`)]));
  const spaceTables = HANDLED.space.filter((x) => x !== "repo_clones");
  const keptBefore = spaceTables.map((t) => [t, count(`SELECT COUNT(*) AS n FROM ${t} WHERE space_id = ?`, kept.space.id)]);

  const preview = spaceDeletePreview(db, gone.space.id);
  expect(preview).toMatchObject({ name: "Text Dana", tasks: 2, runs: 1, refusal: null, texts: { sent: 0, drafts: 1 }, repo: null });
  expect(preview.folder).toMatchObject({ files: 1, bytes: 4 });
  expect(preview.investing).toBeGreaterThan(5);

  await deleteSpace(db, gone.space.id, "  Text Dana ");

  expect(getSpace(db, gone.space.id)).toBeNull();
  for (const t of HANDLED.space) {
    if (t === "repo_clones") continue;
    expect([t, count(`SELECT COUNT(*) AS n FROM ${t} WHERE space_id = ?`, gone.space.id)]).toEqual([t, 0]);
  }
  for (const t of HANDLED.task) {
    const col = t === "tasks" ? "id" : "task_id";
    expect([t, count(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} IN (?, ?)`, gone.task, gone.review)]).toEqual([t, 0]);
  }
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(existsSync(gone.transcript)).toBe(false);
  expect(existsSync(gone.space.folder!)).toBe(false);
  expect(getSetting(db, "messaging.spaceId")).toBeNull();
  expect(count("SELECT COUNT(*) AS n FROM pending_deletes")).toBe(0);
  // The other space is exactly as it was.
  expect(existsSync(kept.transcript)).toBe(true);
  expect(readFileSync(join(kept.space.folder!, "list.md"), "utf8")).toBe("eggs");
  expect(getTask(db, kept.task)).not.toBeNull();
  expect(spaceTables.map((t) => [t, count(`SELECT COUNT(*) AS n FROM ${t} WHERE space_id = ?`, kept.space.id)])).toEqual(keptBefore);
  expect(keptBefore.every(([, n]) => (n as number) > 0)).toBe(true);
  // Repo approvals belong to no space; the deleted space's one went with its repo action, the other one stayed.
  expect(count("SELECT COUNT(*) AS n FROM approvals WHERE space_id IS NULL")).toBe(1);
  expect(count("SELECT COUNT(*) AS n FROM tasks")).toBe(before.tasks! - 2);
});

test("the name must match exactly", async () => {
  const s = fullSpace("Text Dana");
  const err = await deleteSpace(db, s.space.id, "text dana").catch((e) => e);
  expect(err).toBeInstanceOf(DeleteRefused);
  expect(err.status).toBe(400);
  expect(err.message).toBe('Type the space\'s name exactly as shown, "Text Dana", to delete it.');
  expect(getSpace(db, s.space.id)).not.toBeNull();
  expect(existsSync(s.transcript)).toBe(true);
});

test("a running task stops the delete and says what to do", async () => {
  const s = fullSpace("Busy");
  setTaskStatus(db, s.task, "running");
  expect(spaceDeletePreview(db, s.space.id).refusal).toBe('"Busy work" is running. Wait for it to finish (it shows under Live), then try again. Nothing was deleted.');
  const err = await deleteSpace(db, s.space.id, "Busy").catch((e) => e);
  expect(err.status).toBe(409);
  expect(getSpace(db, s.space.id)).not.toBeNull();
  expect(count("SELECT COUNT(*) AS n FROM tasks WHERE space_id = ?", s.space.id)).toBe(2);
});

test("a text being sent stops the delete of the Messages space", async () => {
  const space = createSpace(db, { name: "Messages", kind: "general", goal: "g" });
  const { action } = draftMessage(db, { spaceId: space.id, toName: "Dana", text: "Hey", handle: "+15550100134", handleSource: "you" });
  db.query("UPDATE message_actions SET status = 'sending' WHERE id = ?").run(action.id);
  const err = await deleteSpace(db, space.id, "Messages").catch((e) => e);
  expect(err.status).toBe(409);
  expect(err.message).toBe("A text is being sent from here right now. Try again in a minute, once it has gone. Nothing was deleted.");
  setMessageStatus(db, action.id, "sent", { sentAt: Date.now() });
  const preview = spaceDeletePreview(db, space.id);
  expect(preview.texts).toEqual({ sent: 1, drafts: 0 });
  await deleteSpace(db, space.id, "Messages");
  expect(getSpace(db, space.id)).toBeNull();
});

test("a link inside the folder is removed, never followed", async () => {
  const s = fullSpace("Links");
  const outside = mkdtempSync(join(tmpdir(), "atrium-outside-"));
  writeFileSync(join(outside, "precious.txt"), "keep me");
  symlinkSync(outside, join(s.space.folder!, "elsewhere"));
  symlinkSync(join(outside, "precious.txt"), join(s.space.folder!, "file-link"));
  try {
    await deleteSpace(db, s.space.id, "Links");
    expect(existsSync(s.space.folder!)).toBe(false);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a folder that is itself a link is unlinked, and its target kept", async () => {
  const s = fullSpace("Linked");
  const outside = mkdtempSync(join(tmpdir(), "atrium-outside-"));
  writeFileSync(join(outside, "precious.txt"), "keep me");
  rmSync(s.space.folder!, { recursive: true });
  symlinkSync(outside, s.space.folder!);
  try {
    await deleteSpace(db, s.space.id, "Linked");
    expect(existsSync(s.space.folder!)).toBe(false);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a recorded folder outside the files home is never removed", async () => {
  const s = fullSpace("Escape");
  const outside = mkdtempSync(join(tmpdir(), "atrium-outside-"));
  writeFileSync(join(outside, "precious.txt"), "keep me");
  db.query("UPDATE spaces SET folder = ? WHERE id = ?").run(outside, s.space.id);
  try {
    const { message } = await deleteSpace(db, s.space.id, "Escape");
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
    expect(message).toContain("isn't inside");
    for (const bad of ["/", join(config().filesHome, ".."), join(config().filesHome, ".hidden")]) {
      queueDelete(db, "folder", bad, config().filesHome);
    }
    await finishPendingDeletes(db);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
    expect(existsSync(config().home)).toBe(true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a folder another space still records is kept", async () => {
  const s = fullSpace("Shared");
  const other = createSpace(db, { name: "Other", kind: "general", goal: "g" });
  db.query("UPDATE spaces SET folder = ? WHERE id = ?").run(s.space.folder, other.id);
  await deleteSpace(db, s.space.id, "Shared");
  expect(readFileSync(join(s.space.folder!, "list.md"), "utf8")).toBe("eggs");
});

test("files queued before a crash are removed on the next boot", async () => {
  const s = fullSpace("Crash");
  // As if the engine stopped right after the transaction committed: rows gone, files still queued.
  db.exec("PRAGMA foreign_keys = OFF");
  db.transaction(() => {
    db.query("DELETE FROM spaces WHERE id = ?").run(s.space.id);
    queueDelete(db, "folder", s.space.folder!, config().filesHome);
    queueDelete(db, "transcript", s.transcript, config().transcriptsDir);
  })();
  expect(existsSync(s.space.folder!)).toBe(true);
  db.close();
  db = openDb();
  await finishPendingDeletes(db);
  expect(existsSync(s.space.folder!)).toBe(false);
  expect(existsSync(s.transcript)).toBe(false);
  expect(count("SELECT COUNT(*) AS n FROM pending_deletes")).toBe(0);
  // Nothing half-moved is left in the files home either.
  expect(readdirSync(config().filesHome).filter((n) => n.startsWith(".atrium-trash-"))).toEqual([]);
});

test("a repo space Nakul made: nothing in his repo changes", async () => {
  const repo = tempRepo();
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo.path }).stdout.toString();
  try {
    git("branch", "atrium/tsk_old");
    const space = createSpace(db, { name: "Mine", kind: "repo", goal: "g", repoPath: repo.path });
    const task = createTask(db, { spaceId: space.id, title: "Fix" });
    db.query("UPDATE tasks SET branch = 'atrium/tsk_old' WHERE id = ?").run(task.id);
    const before = [git("rev-parse", "HEAD"), git("branch", "--list"), git("status", "--porcelain"), readdirSync(repo.path).sort().join()];
    expect(spaceDeletePreview(db, space.id).repo).toEqual({ path: repo.path, atriumClone: false });
    await deleteSpace(db, space.id, "Mine");
    expect([git("rev-parse", "HEAD"), git("branch", "--list"), git("status", "--porcelain"), readdirSync(repo.path).sort().join()]).toEqual(before);
    expect(getSpace(db, space.id)).toBeNull();
  } finally {
    repo.cleanup();
  }
});

test("Atrium's own clone goes when everything is on GitHub, and stays when it isn't", async () => {
  const gh = fakeGitHub();
  try {
    seedRemote(gh, "clean");
    seedRemote(gh, "dirty");
    const spaces = ["clean", "dirty"].map((n) => createSpace(db, { name: n, kind: "repo", goal: "g", github: `fakeuser/${n}` }));
    const cloner = createCloner(db, () => {});
    for (const s of spaces) cloner.request(s);
    await cloner.settle();
    const [clean, dirty] = spaces.map((s) => getSpace(db, s.id)!);
    writeFileSync(join(dirty!.repoPath!, "notes.txt"), "unsaved");
    expect(spaceDeletePreview(db, clean!.id).repo?.atriumClone).toBe(true);

    await deleteSpace(db, clean!.id, "clean");
    expect(existsSync(clean!.repoPath!)).toBe(false);
    expect(listClones(db).find((c) => c.path === clean!.repoPath)?.status).toBe("removed");

    const { kept } = await deleteSpace(db, dirty!.id, "dirty");
    expect(readFileSync(join(dirty!.repoPath!, "notes.txt"), "utf8")).toBe("unsaved");
    expect(kept[0]).toStartWith("Kept the local copy of fakeuser/dirty:");
    expect(listClones(db).find((c) => c.path === dirty!.repoPath)).toMatchObject({ status: "present", spaceId: null });
    // Still listed in Storage, under the deleted spaces, so it can be found and removed later.
    const { createRepos } = await import("../../src/engine/repos");
    const view = await createRepos({ db, kick: () => {} }).storage();
    expect(view.repos.find((r) => r.path === dirty!.repoPath)).toMatchObject({ spaceId: null, spaceName: "fakeuser/dirty", createdBy: "atrium" });
    // Nothing reached GitHub beyond the clones and the fetch that checks what's pushed.
    expect(gh.argv().some((a) => a.includes("delete"))).toBe(false);
  } finally {
    gh.cleanup();
  }
});

test("deleting a task removes its runs, review, history, transcript and the files only it made", async () => {
  const s = fullSpace("Groceries");
  const other = createTask(db, { spaceId: s.space.id, title: "Other" }).id;
  const otherRun = addRun(other);
  writeFileSync(join(s.space.folder!, "shared.md"), "both");
  writeFileSync(join(s.space.folder!, "changed.md"), "old");
  recordRunFiles(db, { runId: s.run, taskId: s.task, spaceId: s.space.id, root: "space" }, [
    { path: "shared.md", change: "created", size: 4 },
    { path: "changed.md", change: "changed", size: 3 },
  ]);
  recordRunFiles(db, { runId: otherRun.id, taskId: other, spaceId: s.space.id, root: "space" }, [{ path: "shared.md", change: "changed", size: 4 }]);
  mkdirSync(join(s.space.folder!, "runs", s.run), { recursive: true });
  writeFileSync(join(s.space.folder!, "runs", s.run, "kept.txt"), "k");
  recordRunFiles(db, { runId: s.run, taskId: s.task, spaceId: s.space.id, root: "space" }, [{ path: `runs/${s.run}/kept.txt`, change: "created", size: 1 }]);
  const outside = mkdtempSync(join(tmpdir(), "atrium-outside-"));
  writeFileSync(join(outside, "x.md"), "keep");
  symlinkSync(join(outside, "x.md"), join(s.space.folder!, "sneaky.md"));
  recordRunFiles(db, { runId: s.run, taskId: s.task, spaceId: s.space.id, root: "space" }, [{ path: "sneaky.md", change: "created", size: 1 }]);

  try {
    expect(taskDeletePreview(db, s.task)).toMatchObject({ title: "Groceries work", followers: 1, runs: 1, files: ["list.md", `runs/${s.run}/kept.txt`], edited: [], refusal: null });
    await deleteTask(db, s.task);
    expect(getTask(db, s.task)).toBeNull();
    expect(getTask(db, s.review)).toBeNull();
    expect(getTask(db, other)).not.toBeNull();
    expect(existsSync(s.transcript)).toBe(false);
    expect(existsSync(otherRun.transcript)).toBe(true);
    expect(existsSync(join(s.space.folder!, "list.md"))).toBe(false);
    expect(existsSync(join(s.space.folder!, "runs", s.run))).toBe(false);
    expect(readFileSync(join(s.space.folder!, "shared.md"), "utf8")).toBe("both");
    expect(readFileSync(join(s.space.folder!, "changed.md"), "utf8")).toBe("old");
    expect(readFileSync(join(outside, "x.md"), "utf8")).toBe("keep");
    expect(listActivity(db, { spaceId: s.space.id }).some((r) => r.taskId === s.task)).toBe(false);
    // The paper ledger and write-ups keep their rows; only the link to the task goes.
    expect(count("SELECT COUNT(*) AS n FROM paper_fills WHERE space_id = ? AND task_id IS NULL", s.space.id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM market_writeups WHERE space_id = ? AND task_id IS NULL", s.space.id)).toBe(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(listSpaces(db).some((x) => x.id === s.space.id)).toBe(true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a text drafted in Messages for a deleted task stays, unlinked", async () => {
  const s = fullSpace("Text Dana");
  const messages = createSpace(db, { name: "Messages", kind: "general", goal: "g" });
  const { action } = draftMessage(db, { spaceId: messages.id, taskId: s.task, toName: "Dana", text: "Hey again" });
  await deleteSpace(db, s.space.id, "Text Dana");
  expect(db.query("SELECT space_id, task_id FROM message_actions WHERE id = ?").get(action.id)).toEqual({ space_id: messages.id, task_id: null });
});

test("a running task can't be deleted, nor one whose review is running", async () => {
  const s = fullSpace("Busy");
  setTaskStatus(db, s.review, "running");
  const err = await deleteTask(db, s.task).catch((e) => e);
  expect(err.status).toBe(409);
  expect(err.message).toBe('"Review: Busy" is running. Wait for it to finish (it shows under Live), then try again. Nothing was deleted.');
  expect(getTask(db, s.task)).not.toBeNull();
});

test("decided approvals and rules don't block a delete", async () => {
  const s = fullSpace("Done");
  const a = createApproval(db, { spaceId: s.space.id, taskId: s.task, kind: "review", title: "t", detail: "" });
  resolveApproval(db, a.id, "approve");
  await deleteSpace(db, s.space.id, "Done");
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
