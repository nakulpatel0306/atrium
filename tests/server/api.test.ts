import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { createApproval, listPending } from "../../src/engine/approvals";
import { applyRule } from "../../src/engine/autonomy/rules";
import { addMessage } from "../../src/engine/messages";
import { openDb } from "../../src/engine/db";
import { createRegistry } from "../../src/engine/agents/registry";
import { createRunner } from "../../src/engine/runner";
import { SetupFailed } from "../../src/engine/setup";
import { createSpace } from "../../src/engine/spaces";
import { getSetting } from "../../src/engine/settings";
import { createTask, getTask, listTasks, setTaskStatus } from "../../src/engine/tasks";
import { bus } from "../../src/engine/events";
import { startServer, type WsData } from "../../src/server/server";
import { branchAt, PLAIN_DOCS, tempHome, tempRepo } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<WsData>;
let kicks: number;
let setupImpl: (text: string) => Promise<never>;
let base: string;
let origin: string;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  kicks = 0;
  setupImpl = async () => {
    throw new Error("setup not stubbed");
  };
  server = startServer({
    db,
    runner: { kick: () => void kicks++ },
    setup: (t) => setupImpl(t),
    port: 0,
  });
  base = `http://127.0.0.1:${server.port}`;
  origin = base;
});
afterEach(() => {
  server.stop(true);
  db.close();
  home.cleanup();
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const patch = (path: string, body: unknown) =>
  fetch(base + path, { method: "PATCH", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

test("PATCH reviewBy validates the agent id", async () => {
  const s = createSpace(db, { name: "App", kind: "general", goal: "g" });
  const bad = await patch(`/api/spaces/${s.id}`, { reviewBy: "bogus" });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("reviewBy must be codex, gemini, claude, or null.");
  const set = await patch(`/api/spaces/${s.id}`, { reviewBy: "codex" });
  expect(set.status).toBe(200);
  expect(((await set.json()) as { reviewBy: string }).reviewBy).toBe("codex");
  const cleared = await patch(`/api/spaces/${s.id}`, { reviewBy: null });
  expect(((await cleared.json()) as { reviewBy: string | null }).reviewBy).toBeNull();
  // Leaving it out keeps what's there.
  await patch(`/api/spaces/${s.id}`, { reviewBy: "gemini" });
  expect(((await (await patch(`/api/spaces/${s.id}`, { name: "Renamed" })).json()) as { reviewBy: string }).reviewBy).toBe("gemini");
});

test("GET messages returns the thread in order", async () => {
  const s = createSpace(db, { name: "App", kind: "general", goal: "g" });
  const t = createTask(db, { spaceId: s.id, title: "Work" });
  addMessage(db, { spaceId: s.id, taskId: t.id, fromAgent: "claude", toAgent: "codex", body: "Please review 2 files on atrium/x." });
  addMessage(db, { spaceId: s.id, taskId: t.id, fromAgent: "codex", toAgent: "claude", body: "VERDICT: approve" });
  const res = await fetch(`${base}/api/tasks/${t.id}/messages`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { fromAgent: string; body: string }[];
  expect(body.map((m) => [m.fromAgent, m.body])).toEqual([
    ["claude", "Please review 2 files on atrium/x."],
    ["codex", "VERDICT: approve"],
  ]);
  expect((await fetch(`${base}/api/tasks/nope/messages`)).status).toBe(404);
});

test("GET /api/state returns spaces and briefing", async () => {
  createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const res = await fetch(`${base}/api/state`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { spaces: unknown[]; briefing: unknown };
  expect(body.spaces).toHaveLength(1);
  expect(body.briefing).toBeDefined();
});

test("POST /api/tasks creates and kicks the runner", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const res = await post("/api/tasks", { spaceId: s.id, title: "Draft" });
  expect(res.status).toBe(200);
  expect(listTasks(db)).toHaveLength(1);
  expect(kicks).toBe(1);
});

test("second approval resolve returns 409", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const a = createApproval(db, { spaceId: s.id, kind: "question", title: "Q", detail: "?" });
  expect((await post(`/api/approvals/${a.id}`, { decision: "approve" })).status).toBe(200);
  const again = await post(`/api/approvals/${a.id}`, { decision: "approve" });
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: "Already handled" });
});

test("unknown approval id returns 404", async () => {
  const res = await post("/api/approvals/apr_nope", { decision: "approve" });
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: string }).error).toBe("No such approval.");
});

test("command without spaceId calls setup; SetupFailed maps to 422 with message", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const seen: string[] = [];
  setupImpl = async (t) => {
    seen.push(t);
    return { space: s, tasks: [] } as never;
  };
  const ok = await post("/api/command", { text: "set up docs" });
  expect(ok.status).toBe(200);
  expect(seen).toEqual(["set up docs"]);

  setupImpl = async () => {
    throw new SetupFailed("Couldn't plan that one.", new Error("No JSON object in the agent's reply."));
  };
  const spy = spyOn(console, "error").mockImplementation(() => {});
  const bad = await post("/api/command", { text: "x" });
  expect(bad.status).toBe(422);
  expect(await bad.json()).toEqual({ error: "Couldn't plan that one." });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(String(spy.mock.calls[0]!.join(" "))).toContain("No JSON object in the agent's reply.");
  spy.mockRestore();
});

test("command with spaceId creates a light task in a general space", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const res = await post("/api/command", { text: "Draft the intro", spaceId: s.id });
  const { task } = (await res.json()) as { task: { weight: string; title: string } };
  expect(task.weight).toBe("light");
  expect(task.title).toBe("Draft the intro");
  expect(kicks).toBe(1);
});

test("retry requeues a failed or blocked task; other statuses are 409", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const t = createTask(db, { spaceId: s.id, title: "T" });
  const bad = await post(`/api/tasks/${t.id}/retry`);
  expect(bad.status).toBe(409);
  expect(await bad.json()).toEqual({ error: "This task isn't blocked or failed, so there's nothing to retry." });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "failed");
  const ok = await post(`/api/tasks/${t.id}/retry`);
  expect(ok.status).toBe(200);
  expect(getTask(db, t.id)!.status).toBe("queued");
  setTaskStatus(db, t.id, "blocked", { blockedReason: "stuck" });
  expect((await post(`/api/tasks/${t.id}/retry`)).status).toBe(200);
  expect(getTask(db, t.id)!.status).toBe("queued");
  expect((await post("/api/tasks/tsk_nope/retry")).status).toBe(404);
});

test("retry on a running task is 409 and the agent runs once", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const t = createTask(db, { spaceId: s.id, title: "T", weight: "light" });
  let calls = 0;
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  const runner = createRunner({
    db,
    adapters: {
      claude: {
        id: "claude",
        label: "Fake",
        async run() {
          calls++;
          await gate;
          return { status: "ok", summary: "done", inputTokens: 1, outputTokens: 1 };
        },
      },
    },
    power: async () => "ac",
    keepAwake: { start() {}, stop() {}, active: () => false },
  });
  server.stop(true);
  server = startServer({ db, runner, setup: (x) => setupImpl(x), port: 0 });
  base = origin = `http://127.0.0.1:${server.port}`;
  runner.start();
  try {
    while (getTask(db, t.id)!.status !== "running") await Bun.sleep(5);
    const res = await post(`/api/tasks/${t.id}/retry`);
    expect(res.status).toBe(409);
    finish();
    while (getTask(db, t.id)!.status !== "review") await Bun.sleep(5);
    await Bun.sleep(30);
    expect(calls).toBe(1);
  } finally {
    await runner.stop();
  }
});

test("retry on a task in review is 409 and its approval stays pending", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const t = createTask(db, { spaceId: s.id, title: "T" });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review");
  const a = createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title: "T", detail: "d" });
  expect((await post(`/api/tasks/${t.id}/retry`)).status).toBe(409);
  expect(getTask(db, t.id)!.status).toBe("review");
  expect(listPending(db).map((p) => p.id)).toEqual([a.id]);
});

test("settings writes overnight as a string and kicks", async () => {
  const res = await post("/api/settings", { overnight: true });
  expect(res.status).toBe(200);
  expect(getSetting(db, "overnight")).toBe("true");
  expect(kicks).toBe(1);
  expect((await post("/api/settings", { overnight: "yes" })).status).toBe(400);
});

test("transcript is served from the run's stored path only", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const t = createTask(db, { spaceId: s.id, title: "T" });
  const path = `${home.home}/t.log`;
  await Bun.write(path, "hello transcript");
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES (?, ?, ?, ?, ?)").run(
    "run_1", t.id, "claude", Date.now(), path,
  );
  const res = await fetch(`${base}/api/runs/run_1/transcript`);
  expect(res.headers.get("content-type")).toContain("text/plain");
  // Agent output must never be sniffed into HTML on the engine's origin.
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await res.text()).toBe("hello transcript");
  expect((await fetch(`${base}/api/runs/nope/transcript`)).status).toBe(404);
});

test("server is bound to 127.0.0.1", () => {
  expect(server.hostname).toBe("127.0.0.1");
});

test("server runs in production mode unless ATRIUM_DEV=1", () => {
  expect(server.development).toBe(false);
});

test("a second server on the same port fails instead of sharing it", () => {
  // Production mode defaults to SO_REUSEPORT, which would let two engines split requests.
  expect(() => startServer({ db, runner: { kick() {} }, setup: (t) => setupImpl(t), port: server.port as number })).toThrow();
});

test("dashboard routes serve html", async () => {
  for (const p of ["/", "/space/spc_1", "/agents"]) {
    const res = await fetch(base + p);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Atrium</title>");
  }
});

test("wrong Host header is 403", async () => {
  const res = await fetch(`${base}/api/state`, { headers: { host: "evil.example" } });
  expect(res.status).toBe(403);
});

test("POST without Origin or with a foreign Origin is 403; allowed Origin works", async () => {
  const noOrigin = await fetch(`${base}/api/seen`, { method: "POST" });
  expect(noOrigin.status).toBe(403);
  expect((await post("/api/seen", undefined, { origin: "http://evil.example" })).status).toBe(403);
  expect((await post("/api/seen", undefined, { origin: `http://localhost:${server.port}` })).status).toBe(200);
  expect((await post("/api/seen")).status).toBe(200);
});

test("non-JSON content-type is 415", async () => {
  const text = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { origin, "content-type": "text/plain" },
    body: '{"overnight":true}',
  });
  expect(text.status).toBe(415);
});

test("unexpected errors return the generic 500 and log the cause", async () => {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  const res = await post("/api/command", { text: "x" });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "Something went wrong in Atrium. Check the engine log." });
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});

test("unknown route is 404", async () => {
  expect((await fetch(`${base}/api/nope`)).status).toBe(404);
});

const openWs = (headers: Record<string, string>, path = "/ws") =>
  new Promise<{ ws: WebSocket; ok: boolean }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers } as never);
    ws.onopen = () => resolve({ ws, ok: true });
    ws.onerror = () => resolve({ ws, ok: false });
  });

test("ws receives changed after a mutation", async () => {
  const { ws, ok } = await openWs({ origin });
  expect(ok).toBe(true);
  const got = new Promise<string>((resolve) => (ws.onmessage = (m) => resolve(String(m.data))));
  await post("/api/spaces", { name: "New", kind: "general", goal: "g" });
  expect(JSON.parse(await got)).toEqual({ type: "changed" });
  ws.close();
});

test("ws upgrade with a foreign Origin is rejected", async () => {
  const { ok } = await openWs({ origin: "http://evil.example" });
  expect(ok).toBe(false);
});

test("GET /api/summary returns the summary without Origin", async () => {
  const s = createSpace(db, { name: "App", kind: "general", goal: "g" });
  createApproval(db, { spaceId: s.id, kind: "question", title: "Which?", detail: "" });
  const res = await fetch(`${base}/api/summary`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { needsYou: number }).needsYou).toBe(1);
});

test("changed-only socket skips run output", async () => {
  const { ws, ok } = await openWs({ origin }, "/ws?events=changed");
  expect(ok).toBe(true);
  const got: unknown[] = [];
  const first = new Promise<void>((resolve) => {
    ws.onmessage = (m) => {
      got.push(JSON.parse(String(m.data)));
      resolve();
    };
  });
  bus.emit({ type: "run-output", runId: "r", taskId: "t", chunk: "x" });
  bus.emit({ type: "changed" });
  await first;
  await Bun.sleep(50);
  expect(got).toEqual([{ type: "changed" }]);
  ws.close();
});

test("changed-only socket requires Origin", async () => {
  const { ok } = await openWs({ origin: "http://evil.example" }, "/ws?events=changed");
  expect(ok).toBe(false);
});

test("run-now sets ignore_reserve and requires Origin", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const t = createTask(db, { spaceId: s.id, title: "T", agent: "claude" });
  const noOrigin = await fetch(`${base}/api/tasks/${t.id}/run-now`, { method: "POST" });
  expect(noOrigin.status).toBe(403);
  expect(getTask(db, t.id)!.ignoreReserve).toBe(false);
  const ok = await post(`/api/tasks/${t.id}/run-now`);
  expect(ok.status).toBe(200);
  expect(getTask(db, t.id)!.ignoreReserve).toBe(true);
  expect(kicks).toBe(1);
  expect((await post("/api/tasks/tsk_nope/run-now")).status).toBe(404);
  // Only a task still waiting to start can skip the reserve.
  setTaskStatus(db, t.id, "running");
  expect((await post(`/api/tasks/${t.id}/run-now`)).status).toBe(409);
});

test("task creation accepts a valid agent and rejects others", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const res = await post("/api/tasks", { spaceId: s.id, title: "Draft", agent: "codex" });
  expect(((await res.json()) as { agent: string }).agent).toBe("codex");
  const bad = await post("/api/tasks", { spaceId: s.id, title: "Draft", agent: "gpt" });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "agent must be auto, claude, codex, or gemini." });
  const cmd = await post("/api/command", { text: "Draft the intro", spaceId: s.id, agent: "gemini" });
  expect(((await cmd.json()) as { task: { agent: string } }).task.agent).toBe("gemini");
  expect((await post("/api/command", { text: "x", spaceId: s.id, agent: "gpt" })).status).toBe(400);
  const plain = await post("/api/tasks", { spaceId: s.id, title: "Draft" });
  expect(((await plain.json()) as { agent: string }).agent).toBe("auto");
});

test("PATCH a queued task's agent; started tasks are 409", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const t = createTask(db, { spaceId: s.id, title: "T" });
  const res = await patch(`/api/tasks/${t.id}`, { agent: "claude" });
  expect(res.status).toBe(200);
  expect(getTask(db, t.id)!.agent).toBe("claude");
  expect(kicks).toBe(1);
  expect((await patch(`/api/tasks/${t.id}`, { agent: "gpt" })).status).toBe(400);
  expect((await patch("/api/tasks/tsk_nope", { agent: "claude" })).status).toBe(404);
  setTaskStatus(db, t.id, "running");
  const started = await patch(`/api/tasks/${t.id}`, { agent: "codex" });
  expect(started.status).toBe(409);
  expect(getTask(db, t.id)!.agent).toBe("claude");
});

test("settings writes the Claude reserve from the allowed steps", async () => {
  const res = await post("/api/settings", { claudeReserve: 0.75 });
  expect(res.status).toBe(200);
  expect(getSetting(db, "usage.claude.reserve")).toBe("0.75");
  expect(getSetting(db, "overnight")).toBeNull();
  expect(kicks).toBe(1);
  expect((await post("/api/settings", { claudeReserve: 0.6 })).status).toBe(400);
  expect((await post("/api/settings", {})).status).toBe(400);
});

test("reviewers lists why each agent can't review in a space", async () => {
  server.stop(true);
  const adapter = (id: string, label: string) => ({ id, label, run: async () => ({ status: "error" as const, kind: "failed" as const, message: "" }) });
  const registry = createRegistry(db, { claude: adapter("claude", "Claude Code"), codex: adapter("codex", "Codex"), gemini: adapter("gemini", "Gemini") });
  server = startServer({ db, runner: { kick: () => void kicks++, registry }, setup: (t) => setupImpl(t), port: 0 });
  base = `http://127.0.0.1:${server.port}`;
  origin = base;
  const priv = createSpace(db, { name: "Notes", kind: "general", goal: "g", private: true });
  const res = await fetch(`${base}/api/spaces/${priv.id}/reviewers`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    claude: null,
    codex: "Codex can't work here: this space is private, so only Claude works in it.",
    gemini: "Gemini can't work here: this space is private, so only Claude works in it.",
  });
  const open = createSpace(db, { name: "Docs", kind: "general", goal: "g", private: false });
  expect(await (await fetch(`${base}/api/spaces/${open.id}/reviewers`)).json()).toEqual({ claude: null, codex: null, gemini: null });
  expect((await fetch(`${base}/api/spaces/spc_nope/reviewers`)).status).toBe(404);
});

test("state reports the Claude reserve even without a window reading", async () => {
  const body = (await (await fetch(`${base}/api/state`)).json()) as { usage: { claudeReserve: number } };
  expect(body.usage.claudeReserve).toBe(0.5);
  await post("/api/settings", { claudeReserve: 0.25 });
  expect(((await (await fetch(`${base}/api/state`)).json()) as { usage: { claudeReserve: number } }).usage.claudeReserve).toBe(0.25);
});

// Earned autonomy: five results of the same kind approved through the API, as the dashboard does.
const repos: ReturnType<typeof tempRepo>[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});
const FP = "v1:code:docs:small:claude";
function reviewItem(spaceId: string, title = "Add a note") {
  const t = createTask(db, { spaceId, title });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review", { branch: `atrium/${t.id}` });
  return createApproval(db, { spaceId, taskId: t.id, kind: "review", title, detail: "", fingerprint: FP });
}

type Prop = { id: string; label: string; spaceId: string; fingerprint: string; status: string };
type RuleBody = { id: string; spaceId: string; fingerprint: string; state: string };
const state = async () =>
  (await (await fetch(`${base}/api/state`)).json()) as { proposals: Prop[]; rules: RuleBody[]; neverAsk: Prop[]; approvals: { id: string; taskId: string }[] };

async function proposed(spaceId: string): Promise<Prop> {
  for (let i = 0; i < 5; i++) expect((await post(`/api/approvals/${reviewItem(spaceId).id}`, { decision: "approve" })).status).toBe(200);
  const s = await state();
  expect(s.proposals).toHaveLength(1);
  return s.proposals[0]!;
}

test("approving the fifth clean result returns a proposal in state", async () => {
  const s = createSpace(db, { name: "Docs", kind: "repo", goal: "g" });
  for (let i = 0; i < 4; i++) await post(`/api/approvals/${reviewItem(s.id).id}`, { decision: "approve" });
  expect((await state()).proposals).toEqual([]);
  await post(`/api/approvals/${reviewItem(s.id).id}`, { decision: "approve" });
  const p = (await state()).proposals;
  expect(p).toHaveLength(1);
  expect(p[0]!.label).toBe("docs changes (Markdown in docs/ or a README/CHANGELOG) up to 50 lines from Claude");
});

test("answering yes creates a rule; a second answer is 409", async () => {
  const s = createSpace(db, { name: "Docs", kind: "repo", goal: "g" });
  const p = await proposed(s.id);
  const res = await post(`/api/proposals/${p.id}`, { answer: "yes" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { proposal: Prop; rule: RuleBody };
  expect(body.proposal.status).toBe("yes");
  expect(body.rule.state).toBe("active");
  const st = await state();
  expect(st.proposals).toEqual([]);
  expect(st.rules.map((r) => r.id)).toEqual([body.rule.id]);
  const again = await post(`/api/proposals/${p.id}`, { answer: "never" });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: string }).error).toBe("This suggestion was already answered.");
});

test("answer validation and unknown suggestions", async () => {
  const s = createSpace(db, { name: "Docs", kind: "repo", goal: "g" });
  const p = await proposed(s.id);
  const bad = await post(`/api/proposals/${p.id}`, { answer: "maybe" });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("answer must be yes, not_now, or never.");
  const missing = await post("/api/proposals/prp_nope", { answer: "yes" });
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as { error: string }).error).toBe("No such suggestion.");
});

test("the client can't choose what a rule covers", async () => {
  const s = createSpace(db, { name: "Docs", kind: "repo", goal: "g" });
  const other = createSpace(db, { name: "Other", kind: "repo", goal: "g" });
  const p = await proposed(s.id);
  const res = await post(`/api/proposals/${p.id}`, { answer: "yes", fingerprint: "v1:code:code:small:claude", spaceId: other.id });
  const { rule } = (await res.json()) as { rule: RuleBody };
  expect(rule.fingerprint).toBe(FP);
  expect(rule.spaceId).toBe(s.id);
});

test("there is no endpoint to create a rule directly", async () => {
  expect((await post("/api/rules", {})).status).toBe(404);
  expect((await post("/api/rules/new", { fingerprint: FP })).status).toBe(404);
});

test("rule and proposal endpoints require the dashboard origin", async () => {
  const s = createSpace(db, { name: "Docs", kind: "repo", goal: "g" });
  const p = await proposed(s.id);
  const paths = [`/api/proposals/${p.id}`, `/api/proposals/${p.id}/suggest-again`, "/api/rules/rul_x/revoke", "/api/rules/rul_x/renew", "/api/approvals/apr_x/undo"];
  for (const path of paths) {
    const body = JSON.stringify({ answer: "yes" });
    const noOrigin = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(noOrigin.status).toBe(403);
    expect((await post(path, { answer: "yes" }, { origin: "http://evil.test" })).status).toBe(403);
    expect((await post(path, { answer: "yes" }, { host: "evil.test" })).status).toBe(403);
  }
  const st = await state();
  expect(st.rules).toEqual([]);
  expect(st.proposals.map((x) => x.status)).toEqual(["pending"]);
});

test("rule endpoints require JSON", async () => {
  const s = createSpace(db, { name: "Docs", kind: "repo", goal: "g" });
  const p = await proposed(s.id);
  const res = await post(`/api/proposals/${p.id}`, undefined, { "content-type": "text/plain" });
  const raw = await fetch(`${base}/api/proposals/${p.id}`, { method: "POST", headers: { origin, "content-type": "text/plain" }, body: '{"answer":"yes"}' });
  expect(raw.status).toBe(415);
  expect(res.status).toBe(400);
  expect((await state()).rules).toEqual([]);
});

test("never, then suggest again", async () => {
  const s = createSpace(db, { name: "Docs", kind: "repo", goal: "g" });
  const p = await proposed(s.id);
  await post(`/api/proposals/${p.id}`, { answer: "never" });
  expect((await state()).neverAsk.map((x) => x.id)).toEqual([p.id]);
  const res = await post(`/api/proposals/${p.id}/suggest-again`);
  expect(res.status).toBe(200);
  expect((await state()).neverAsk).toEqual([]);
  expect((await post(`/api/proposals/${p.id}/suggest-again`)).status).toBe(409);
  expect((await post("/api/proposals/prp_nope/suggest-again")).status).toBe(404);
});

async function appliedRule() {
  const repo = tempRepo();
  repos.push(repo);
  const s = createSpace(db, { name: "Docs", kind: "repo", goal: "g", repoPath: repo.path });
  const p = await proposed(s.id);
  const { rule } = (await (await post(`/api/proposals/${p.id}`, { answer: "yes" })).json()) as { rule: RuleBody };
  // Approvals made in the same millisecond as the rule would count as already waiting.
  await Bun.sleep(5);
  const a = reviewItem(s.id, "Auto one");
  const facts = { domain: "code" as const, agent: "claude", branch: `atrium/${a.taskId}`, sha: branchAt(repo.path, `atrium/${a.taskId}`), content: PLAIN_DOCS, files: [{ path: "docs/a.md", status: "A" as const, added: 2, deleted: 0, oldMode: "000000", newMode: "100644" }] };
  expect(applyRule(db, a.id, facts)).not.toBeNull();
  return { rule, a };
}

test("revoke then undo", async () => {
  const { rule, a } = await appliedRule();
  const revoked = await post(`/api/rules/${rule.id}/revoke`);
  expect(revoked.status).toBe(200);
  expect((await state()).rules[0]!.state).toBe("revoked");
  const again = await post(`/api/rules/${rule.id}/revoke`);
  expect(again.status).toBe(409);
  expect((await post("/api/rules/rul_nope/revoke")).status).toBe(404);
  kicks = 0;
  const undo = await post(`/api/approvals/${a.id}/undo`);
  expect(undo.status).toBe(200);
  const reopened = (await undo.json()) as { id: string; status: string; taskId: string };
  expect(reopened.status).toBe("pending");
  expect(kicks).toBe(1);
  expect((await state()).approvals.map((x) => x.id)).toContain(reopened.id);
  expect((await post(`/api/approvals/${a.id}/undo`)).status).toBe(409);
  expect((await post("/api/approvals/apr_nope/undo")).status).toBe(404);
});

test("renew extends an active rule", async () => {
  const { rule } = await appliedRule();
  const res = await post(`/api/rules/${rule.id}/renew`);
  expect(res.status).toBe(200);
  expect((await post("/api/rules/rul_nope/renew")).status).toBe(404);
  await post(`/api/rules/${rule.id}/revoke`);
  expect((await post(`/api/rules/${rule.id}/renew`)).status).toBe(409);
});

test("GET /api/rules/:id returns the rule, its applied approvals and events in order", async () => {
  const { rule, a } = await appliedRule();
  const res = await fetch(`${base}/api/rules/${rule.id}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    rule: RuleBody;
    proposal: { evidence: { title: string }[] };
    approvals: { id: string }[];
    events: { event: string; actor: string }[];
  };
  expect(body.rule.id).toBe(rule.id);
  // The suggestion's evidence, so the rule's page can show why it exists.
  expect(body.proposal.evidence).toHaveLength(5);
  expect(body.approvals.map((x) => x.id)).toEqual([a.id]);
  expect(body.events.map((e) => [e.event, e.actor])).toEqual([
    ["proposed", "atrium"],
    ["yes", "you"],
    ["created", "you"],
    ["applied", "atrium"],
  ]);
  expect((await fetch(`${base}/api/rules/rul_nope`)).status).toBe(404);
});

test("/rules serves html", async () => {
  const res = await fetch(`${base}/rules`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<title>Atrium</title>");
});

test("visibility messages count viewers", async () => {
  server.stop(true);
  const seen: number[] = [];
  server = startServer({ db, runner: { kick: () => {} }, setup: (t) => setupImpl(t), port: 0, onViewers: (n) => seen.push(n) });
  base = `http://127.0.0.1:${server.port}`;
  origin = base;
  const a = await openWs({ origin });
  const b = await openWs({ origin });
  a.ws.send("not json");
  a.ws.send(JSON.stringify({ type: "visibility", visible: true }));
  await Bun.sleep(30);
  b.ws.send(JSON.stringify({ type: "visibility", visible: "yes" }));
  b.ws.send(JSON.stringify({ type: "visibility", visible: true }));
  await Bun.sleep(30);
  a.ws.close();
  await Bun.sleep(50);
  expect(seen).toEqual([1, 2, 1]);
  b.ws.close();
});
