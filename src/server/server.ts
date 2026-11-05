import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import index from "../dashboard/index.html";
import type { Registry } from "../engine/agents/registry";
import { AlreadyResolved, getApproval, resolveApproval } from "../engine/approvals";
import { answerProposal, considerProposal, getProposal, suggestAgain } from "../engine/autonomy/proposals";
import { getRule, renewRule, revokeRule, ruleApprovals, ruleEvents, RuleRefused, undoAutoApproval } from "../engine/autonomy/rules";
import { markSeen } from "../engine/briefing";
import { config } from "../engine/config";
import { bus } from "../engine/events";
import type { setupSpace } from "../engine/setup";
import { SetupFailed } from "../engine/setup";
import { setSetting } from "../engine/settings";
import { listMessages } from "../engine/messages";
import { createSpace, getSpace, REVIEWERS, type ReviewerId, updateSpace } from "../engine/spaces";
import { snapshot } from "../engine/state";
import { summary } from "../engine/summary";
import { createTask, getTask, InvalidTransition, setTaskStatus } from "../engine/tasks";

type Deps = {
  db: Database;
  runner: { kick(): void; registry?: Registry };
  setup: (text: string) => ReturnType<typeof setupSpace>;
  port?: number;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, message: string) => json({ error: message }, status);

const str = (v: unknown, field: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${field} is required.`);
  return v;
};
const opt = <T>(v: unknown, ok: (x: unknown) => x is T, field: string): T | undefined => {
  if (v === undefined) return undefined;
  if (!ok(v)) throw new HttpError(400, `${field} is not valid.`);
  return v;
};
const isBool = (x: unknown): x is boolean => typeof x === "boolean";
const isString = (x: unknown): x is string => typeof x === "string";

const AGENTS = ["auto", "claude", "codex", "gemini"];
const agentField = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !AGENTS.includes(v)) throw new HttpError(400, "agent must be auto, claude, codex, or gemini.");
  return v;
};
const RESERVE_STEPS = [0.25, 0.5, 0.75];

// "changed" sockets (the Mac app) skip run output, which only the dashboard's live transcript needs.
export type WsData = { topic: "engine" | "changed" };

export function startServer(deps: Deps): Server<WsData> {
  const { db, runner } = deps;

  const origins = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`];
  // Blocks DNS rebinding (Host) and other websites driving the engine (Origin).
  const guard = (req: Request, port: number, needsOrigin: boolean): Response | null => {
    if (!origins(port).includes(req.headers.get("host") ?? "")) return fail(403, "Forbidden host.");
    if (needsOrigin) {
      const origin = req.headers.get("origin") ?? "";
      if (!origins(port).some((h) => origin === `http://${h}`)) return fail(403, "Forbidden origin.");
    }
    return null;
  };

  const readBody = async (req: Request): Promise<Record<string, unknown>> => {
    if (!req.body) return {};
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "Send the request body as application/json.");
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "The request body isn't valid JSON.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new HttpError(400, "The request body must be a JSON object.");
    }
    return body as Record<string, unknown>;
  };

  const route = async (req: Request, url: URL): Promise<Response> => {
    const { pathname } = url;
    const method = req.method;
    const hit = (m: string, pattern: RegExp) => (method === m ? pathname.match(pattern) : null);

    if (hit("GET", /^\/api\/state$/)) return json(snapshot(db, runner.registry));
    if (hit("GET", /^\/api\/summary$/)) return json(summary(db));

    if (hit("POST", /^\/api\/spaces$/)) {
      const b = await readBody(req);
      const kind = b.kind;
      if (kind !== "repo" && kind !== "general") throw new HttpError(400, "kind must be repo or general.");
      return json(
        createSpace(db, {
          name: str(b.name, "name"),
          kind,
          goal: str(b.goal, "goal"),
          repoPath: opt(b.repoPath, isString, "repoPath"),
          private: opt(b.private, isBool, "private"),
        }),
      );
    }

    const spaceM = hit("PATCH", /^\/api\/spaces\/([^/]+)$/);
    if (spaceM) {
      const id = spaceM[1]!;
      if (!getSpace(db, id)) throw new HttpError(404, "No such space.");
      const b = await readBody(req);
      const status = b.status;
      if (status !== undefined && status !== "active" && status !== "archived") {
        throw new HttpError(400, "status must be active or archived.");
      }
      const reviewBy = b.reviewBy;
      if (reviewBy !== undefined && reviewBy !== null && !REVIEWERS.includes(reviewBy as ReviewerId)) {
        throw new HttpError(400, "reviewBy must be codex, gemini, claude, or null.");
      }
      return json(
        updateSpace(db, id, {
          ...(b.name !== undefined && { name: str(b.name, "name") }),
          ...(b.goal !== undefined && { goal: str(b.goal, "goal") }),
          ...(b.private !== undefined && { private: opt(b.private, isBool, "private") }),
          ...(status !== undefined && { status }),
          ...(reviewBy !== undefined && { reviewBy: reviewBy as ReviewerId | null }),
        }),
      );
    }

    // Lets space settings say up front why a reviewer would be skipped, instead of after the work finishes.
    const reviewersM = hit("GET", /^\/api\/spaces\/([^/]+)\/reviewers$/);
    if (reviewersM) {
      const space = getSpace(db, reviewersM[1]!);
      if (!space) throw new HttpError(404, "No such space.");
      return json(Object.fromEntries(REVIEWERS.map((id) => [id, runner.registry?.refusal(id, "review", space)?.reason ?? null])));
    }

    if (hit("POST", /^\/api\/tasks$/)) {
      const b = await readBody(req);
      const spaceId = str(b.spaceId, "spaceId");
      if (!getSpace(db, spaceId)) throw new HttpError(404, "No such space.");
      const weight = b.weight;
      if (weight !== undefined && weight !== "heavy" && weight !== "light") {
        throw new HttpError(400, "weight must be heavy or light.");
      }
      const task = createTask(db, {
        spaceId,
        title: str(b.title, "title"),
        detail: opt(b.detail, isString, "detail"),
        weight,
        allowOnBattery: opt(b.allowOnBattery, isBool, "allowOnBattery"),
        agent: agentField(b.agent),
      });
      runner.kick();
      return json(task);
    }

    const retryM = hit("POST", /^\/api\/tasks\/([^/]+)\/retry$/);
    if (retryM) {
      const id = retryM[1]!;
      const current = getTask(db, id);
      if (!current) throw new HttpError(404, "No such task.");
      // Requeueing a running or in-review task would start a second run or orphan its review.
      if (current.status !== "blocked" && current.status !== "failed") {
        throw new HttpError(409, "This task isn't blocked or failed, so there's nothing to retry.");
      }
      const task = setTaskStatus(db, id, "queued");
      runner.kick();
      return json(task);
    }

    // Changing the agent after a run started would misattribute that run, so only queued tasks change.
    const taskM = hit("PATCH", /^\/api\/tasks\/([^/]+)$/);
    if (taskM) {
      const id = taskM[1]!;
      if (!getTask(db, id)) throw new HttpError(404, "No such task.");
      const agent = agentField((await readBody(req)).agent);
      if (!agent) throw new HttpError(400, "agent is required.");
      const res = db.query("UPDATE tasks SET agent = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(agent, Date.now(), id);
      if (res.changes === 0) throw new HttpError(409, "This task has already started, so its agent can't change.");
      bus.emit({ type: "changed" });
      runner.kick();
      return json(getTask(db, id));
    }

    const nowM = hit("POST", /^\/api\/tasks\/([^/]+)\/run-now$/);
    if (nowM) {
      const id = nowM[1]!;
      if (!getTask(db, id)) throw new HttpError(404, "No such task.");
      const res = db.query("UPDATE tasks SET ignore_reserve = 1, updated_at = ? WHERE id = ? AND status = 'queued'").run(Date.now(), id);
      if (res.changes === 0) throw new HttpError(409, "This task isn't waiting to start, so there's nothing to run now.");
      bus.emit({ type: "changed" });
      runner.kick();
      return json(getTask(db, id));
    }

    const msgM = hit("GET", /^\/api\/tasks\/([^/]+)\/messages$/);
    if (msgM) {
      if (!getTask(db, msgM[1]!)) throw new HttpError(404, "No such task.");
      return json(listMessages(db, msgM[1]!));
    }

    const apprM = hit("POST", /^\/api\/approvals\/([^/]+)$/);
    if (apprM) {
      const id = apprM[1]!;
      const b = await readBody(req);
      if (b.decision !== "approve" && b.decision !== "reject") {
        throw new HttpError(400, "decision must be approve or reject.");
      }
      if (!db.query("SELECT 1 FROM approvals WHERE id = ?").get(id)) throw new HttpError(404, "No such approval.");
      const approval = resolveApproval(db, id, b.decision, opt(b.note, isString, "note"));
      // Nakul's decision stands whatever happens here; a suggestion is only ever extra.
      if (b.decision === "approve") {
        try {
          considerProposal(db, id);
        } catch (e) {
          console.error("Couldn't consider a rule suggestion:", e);
        }
      }
      runner.kick();
      return json(approval);
    }

    const undoM = hit("POST", /^\/api\/approvals\/([^/]+)\/undo$/);
    if (undoM) {
      if (!getApproval(db, undoM[1]!)) throw new HttpError(404, "No such approval.");
      const reopened = undoAutoApproval(db, undoM[1]!);
      runner.kick();
      return json(reopened);
    }

    // Rules are made only by answering yes to a suggestion the engine made; nothing here takes what a rule
    // covers from the request.
    const propM = hit("POST", /^\/api\/proposals\/([^/]+)$/);
    if (propM) {
      const b = await readBody(req);
      if (b.answer !== "yes" && b.answer !== "not_now" && b.answer !== "never") {
        throw new HttpError(400, "answer must be yes, not_now, or never.");
      }
      if (!getProposal(db, propM[1]!)) throw new HttpError(404, "No such suggestion.");
      return json(answerProposal(db, propM[1]!, b.answer));
    }

    const againM = hit("POST", /^\/api\/proposals\/([^/]+)\/suggest-again$/);
    if (againM) {
      if (!getProposal(db, againM[1]!)) throw new HttpError(404, "No such suggestion.");
      return json(suggestAgain(db, againM[1]!));
    }

    const ruleActM = hit("POST", /^\/api\/rules\/([^/]+)\/(revoke|renew)$/);
    if (ruleActM) {
      const id = ruleActM[1]!;
      if (!getRule(db, id)) throw new HttpError(404, "No such rule.");
      return json(ruleActM[2] === "revoke" ? revokeRule(db, id, "you") : renewRule(db, id));
    }

    const ruleM = hit("GET", /^\/api\/rules\/([^/]+)$/);
    if (ruleM) {
      const rule = getRule(db, ruleM[1]!);
      if (!rule) throw new HttpError(404, "No such rule.");
      return json({
        rule,
        proposal: getProposal(db, rule.proposalId),
        approvals: ruleApprovals(db, rule.id),
        events: ruleEvents(db, rule.id),
      });
    }

    if (hit("POST", /^\/api\/command$/)) {
      const b = await readBody(req);
      const text = str(b.text, "text");
      if (b.spaceId === undefined) return json(await deps.setup(text));
      const space = getSpace(db, str(b.spaceId, "spaceId"));
      if (!space) throw new HttpError(404, "No such space.");
      const task = createTask(db, {
        spaceId: space.id,
        title: text.split("\n")[0]!.slice(0, 80),
        detail: text,
        weight: space.kind === "repo" ? "heavy" : "light",
        agent: agentField(b.agent),
      });
      runner.kick();
      return json({ task });
    }

    if (hit("POST", /^\/api\/settings$/)) {
      const b = await readBody(req);
      if (b.overnight === undefined && b.claudeReserve === undefined) {
        throw new HttpError(400, "Send overnight or claudeReserve.");
      }
      if (b.overnight !== undefined && typeof b.overnight !== "boolean") {
        throw new HttpError(400, "overnight must be true or false.");
      }
      if (b.claudeReserve !== undefined && !RESERVE_STEPS.includes(b.claudeReserve as number)) {
        throw new HttpError(400, "claudeReserve must be 0.25, 0.5, or 0.75.");
      }
      if (b.overnight !== undefined) setSetting(db, "overnight", String(b.overnight));
      if (b.claudeReserve !== undefined) setSetting(db, "usage.claude.reserve", String(b.claudeReserve));
      runner.kick();
      return json({ overnight: b.overnight, claudeReserve: b.claudeReserve });
    }

    if (hit("POST", /^\/api\/seen$/)) {
      markSeen(db, Date.now());
      return json({ ok: true });
    }

    const trM = hit("GET", /^\/api\/runs\/([^/]+)\/transcript$/);
    if (trM) {
      const row = db.query("SELECT transcript_path FROM runs WHERE id = ?").get(trM[1]!) as {
        transcript_path: string;
      } | null;
      const file = row ? Bun.file(row.transcript_path) : null;
      if (!file || !(await file.exists())) throw new HttpError(404, "No transcript for that run.");
      // Agent output is untrusted; a browser must never sniff it into HTML on the engine's origin.
      return new Response(file, { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
    }

    throw new HttpError(404, "Not found.");
  };

  const server = Bun.serve<WsData>({
    hostname: config().host,
    port: deps.port ?? config().port,
    // Dev mode serves unminified bundles with HMR; only wanted while working on the dashboard.
    development: process.env.ATRIUM_DEV === "1",
    // Production mode would otherwise share the port, and the port is what keeps a second engine out.
    reusePort: false,
    routes: { "/": index, "/space/*": index, "/agents": index, "/rules": index },
    async fetch(req, srv) {
      const url = new URL(req.url);
      const needsOrigin = req.method !== "GET" || url.pathname === "/ws";
      const denied = guard(req, srv.port as number, needsOrigin);
      if (denied) return denied;
      if (url.pathname === "/ws") {
        const topic = url.searchParams.get("events") === "changed" ? "changed" : "engine";
        if (srv.upgrade(req, { data: { topic } })) return undefined as unknown as Response;
        return fail(400, "Expected a WebSocket upgrade.");
      }
      try {
        return await route(req, url);
      } catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.message);
        if (e instanceof AlreadyResolved) return fail(409, "Already handled");
        if (e instanceof InvalidTransition) return fail(409, e.message);
        if (e instanceof RuleRefused) return fail(409, e.message);
        if (e instanceof SetupFailed) {
          // The user sees the plain message; the log keeps what actually went wrong.
          console.error("Setup failed:", e.cause instanceof Error ? e.cause.message : e.message);
          return fail(422, e.message);
        }
        console.error("Unexpected error:", e);
        return fail(500, "Something went wrong in Atrium. Check the engine log.");
      }
    },
    websocket: {
      open: (ws) => void ws.subscribe(ws.data.topic),
      message: () => {},
    },
  });

  const off = bus.on((e) => {
    const msg = JSON.stringify(e);
    server.publish("engine", msg);
    if (e.type === "changed") server.publish("changed", msg);
  });
  const stop = server.stop.bind(server);
  server.stop = (force?: boolean) => {
    off();
    return stop(force);
  };
  return server;
}
