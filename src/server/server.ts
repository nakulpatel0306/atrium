import type { Database } from "bun:sqlite";
import type { Server, ServerWebSocket } from "bun";
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
import { createSpace, getSpace, MARKETS_PRIVATE, REVIEWERS, type ReviewerId, updateSpace } from "../engine/spaces";
import { DeleteRefused, deleteSpace, deleteTask, spaceDeletePreview, taskDeletePreview } from "../engine/delete";
import { snapshot } from "../engine/state";
import { summary } from "../engine/summary";
import { createTask, getTask, InvalidTransition, setTaskStatus } from "../engine/tasks";
import { fail, HttpError, isBool, isString, json, opt, readBody, str } from "./http";
import { FileRefused } from "../engine/outputs/files";
import { filesRoute } from "./files";
import { embedResponse } from "./embed";
import { investingRoute } from "./investing";
import { simpleRoute } from "./investing-simple";
import { moneyRoute } from "./money";
import { marketsRoute, type MarketsDeps } from "./markets";
import type { Repos } from "../engine/repos";
import { BadDraft } from "../engine/repos/names";
import { PushRefused } from "../engine/repos/push";
import { reposRoute } from "./repos";
import type { Messaging } from "../engine/messaging";
import { messagingRoute } from "./messaging";
import { mergeRestoredMessages, messagesMergeWait } from "../engine/messaging/space";

type Deps = {
  db: Database;
  runner: { kick(): void; stopTask?(taskId: string): Promise<boolean>; registry?: Registry };
  setup: (text: string) => ReturnType<typeof setupSpace>;
  port?: number;
  // How many dashboard tabs are visible; the market feed only streams while someone is looking.
  onViewers?: (n: number) => void;
  markets?: MarketsDeps;
  repos?: Repos;
  messaging?: Messaging;
};


const AGENTS = ["auto", "claude", "codex", "gemini"];
const agentField = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !AGENTS.includes(v)) throw new HttpError(400, "agent must be auto, claude, codex, or gemini.");
  return v;
};
const RESERVE_STEPS = [0.25, 0.5, 0.75];

// "changed" sockets (the Mac app) skip run output, which only the dashboard's live transcript needs.
export type WsData = { topic: "engine" | "changed" };

const embedPath = (token: string) => `/embed/${token}/tradingview`;
// The origin a header names ("http://localhost:7421/" → "http://localhost:7421"), or null.
const originOf = (value: string | null): string | null => {
  if (!value || value === "null") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

export function startServer(deps: Deps): Server<WsData> & { embedPort: number | null; embedToken: string } {
  const { db, runner } = deps;
  const embedToken = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  let embed: Server<undefined> | null = null;
  const embedInfo = () => (embed ? { port: embed.port as number, token: embedToken } : null);

  const origins = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`];
  // Blocks DNS rebinding (Host) and other websites driving or reading the engine. Mutations and the socket must carry
  // our Origin; any API read that says it comes from another site (a foreign Origin, or Sec-Fetch-Site naming
  // another site or another port) is refused too, so a web page can't read prices or make the engine spend
  // provider calls. Reads with neither header (curl, the terminal app, the Mac app) are allowed.
  const guard = (req: Request, port: number, needsOrigin: boolean, api: boolean): Response | null => {
    if (!origins(port).includes(req.headers.get("host") ?? "")) return fail(403, "Forbidden host.");
    // The TradingView page runs third-party code on the chart listener's origin. Anything that origin sends (it
    // shows as Origin, or as Referer, which its Referrer-Policy: origin cuts to just the origin) is refused.
    if (embed) {
      const chart = [`http://127.0.0.1:${embed.port}`, `http://localhost:${embed.port}`];
      const from = [originOf(req.headers.get("origin")), originOf(req.headers.get("referer"))];
      if (from.some((o) => o !== null && chart.includes(o))) return fail(403, "Forbidden origin.");
    }
    const origin = req.headers.get("origin");
    if (api && origin === "null") return fail(403, "Forbidden origin.");
    const ours = origin !== null && origins(port).some((h) => origin === `http://${h}`);
    if (needsOrigin && !ours) return fail(403, "Forbidden origin.");
    if (api) {
      if (origin !== null && !ours) return fail(403, "Forbidden origin.");
      const site = req.headers.get("sec-fetch-site");
      if (site === "cross-site" || site === "same-site") return fail(403, "Forbidden origin.");
    }
    return null;
  };

  const route = async (req: Request, url: URL): Promise<Response> => {
    const { pathname } = url;
    const method = req.method;
    const hit = (m: string, pattern: RegExp) => (method === m ? pathname.match(pattern) : null);

    if (hit("GET", /^\/api\/state$/)) return json({ ...snapshot(db, runner.registry), embed: embedInfo() });
    if (hit("GET", /^\/api\/summary$/)) return json({ ...summary(db), embed: embedInfo() });

    if (hit("POST", /^\/api\/spaces$/)) {
      const b = await readBody(req);
      const kind = b.kind;
      if (kind !== "repo" && kind !== "general" && kind !== "markets") throw new HttpError(400, "kind must be repo, general or markets.");
      if (kind === "markets" && b.private === false) throw new HttpError(400, MARKETS_PRIVATE);
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
      const current = getSpace(db, id);
      if (!current) throw new HttpError(404, "No such space.");
      const b = await readBody(req);
      if (current.kind === "markets" && b.private === false) throw new HttpError(400, MARKETS_PRIVATE);
      const status = b.status;
      if (status !== undefined && status !== "active" && status !== "archived") {
        throw new HttpError(400, "status must be active or archived.");
      }
      // A second Messages space never comes back; the restored one's texts join the current one.
      if (status === "active" && Object.keys(b).length === 1) {
        const wait = messagesMergeWait(db, id);
        if (wait) throw new HttpError(409, wait);
        const merged = mergeRestoredMessages(db, id);
        if (merged) return json(merged);
      }
      const reviewBy = b.reviewBy;
      if (reviewBy !== undefined && reviewBy !== null && !REVIEWERS.includes(reviewBy as ReviewerId)) {
        throw new HttpError(400, "reviewBy must be codex, gemini, claude, or null.");
      }
      const res = json(
        updateSpace(db, id, {
          ...(b.name !== undefined && { name: str(b.name, "name") }),
          ...(b.goal !== undefined && { goal: str(b.goal, "goal") }),
          ...(b.private !== undefined && { private: opt(b.private, isBool, "private") }),
          ...(status !== undefined && { status }),
          ...(reviewBy !== undefined && { reviewBy: reviewBy as ReviewerId | null }),
        }),
      );
      // An archived space's local copy may now be idle enough to offer for removal.
      if (status === "archived") deps.repos?.daily(Date.now());
      return res;
    }

    const spacePreviewM = hit("GET", /^\/api\/spaces\/([^/]+)\/delete-preview$/);
    // A clone still downloading would land in a space that's gone, so a delete waits for it.
    const deleteGuards = { cloning: (id: string) => deps.repos?.cloning(id) ?? false };
    if (spacePreviewM) return json(spaceDeletePreview(db, spacePreviewM[1]!, deleteGuards));

    // Permanent: the body must carry the space's exact name, which the engine checks against its own row.
    const spaceDelM = hit("DELETE", /^\/api\/spaces\/([^/]+)$/);
    if (spaceDelM) {
      const b = await readBody(req);
      if (typeof b.name !== "string") throw new HttpError(400, "Type the space's name to delete it.");
      return json(await deleteSpace(db, spaceDelM[1]!, b.name, deleteGuards));
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

    const taskPreviewM = hit("GET", /^\/api\/tasks\/([^/]+)\/delete-preview$/);
    if (taskPreviewM) return json(taskDeletePreview(db, taskPreviewM[1]!));

    const taskDelM = hit("DELETE", /^\/api\/tasks\/([^/]+)$/);
    if (taskDelM) {
      await readBody(req);
      return json(await deleteTask(db, taskDelM[1]!));
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

    // Waits for the run to wind down, so the answer is the task as it ended (blocked, with where its edits went).
    const stopM = hit("POST", /^\/api\/tasks\/([^/]+)\/stop$/);
    if (stopM) {
      const id = stopM[1]!;
      if (!getTask(db, id)) throw new HttpError(404, "No such task.");
      if (getTask(db, id)!.status !== "running") throw new HttpError(409, "This task isn't running, so there's nothing to stop.");
      if (!(await runner.stopTask?.(id))) {
        throw new HttpError(409, "Atrium isn't running this task right now. Restart the engine if it still shows as running.");
      }
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
      const current = getApproval(db, id);
      if (!current) throw new HttpError(404, "No such approval.");
      // A text is sent only from its card, so the yes always covers the exact words and recipient on screen.
      if (b.decision === "approve" && current.alwaysAsk === "send_message") {
        throw new HttpError(409, "Press Send on the message card, so Atrium sends exactly what you saw.");
      }
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

    const files = await filesRoute(db, req, url);
    if (files) return files;

    if (deps.markets) {
      const res =
        (await marketsRoute(db, deps.markets, req, url)) ?? (await simpleRoute(db, deps.markets, req, url)) ??
        (await moneyRoute(db, deps.markets, req, url)) ?? (await investingRoute(db, deps.markets, req, url));
      if (res) return res;
    }
    if (deps.repos) {
      const res = await reposRoute(db, deps.repos, req, url);
      if (res) return res;
    }
    if (deps.messaging) {
      const res = await messagingRoute(db, deps.messaging, req, url);
      if (res) return res;
    }

    throw new HttpError(404, "Not found.");
  };

  const visible = new Set<ServerWebSocket<WsData>>();
  const setVisible = (ws: ServerWebSocket<WsData>, on: boolean) => {
    const before = visible.size;
    if (on) visible.add(ws);
    else visible.delete(ws);
    if (visible.size !== before) deps.onViewers?.(visible.size);
  };

  const server = Bun.serve<WsData>({
    hostname: config().host,
    port: deps.port ?? config().port,
    // Dev mode serves unminified bundles with HMR; only wanted while working on the dashboard.
    development: process.env.ATRIUM_DEV === "1",
    // Production mode would otherwise share the port, and the port is what keeps a second engine out.
    reusePort: false,
    routes: { "/": index, "/space/*": index, "/agents": index, "/rules": index, "/settings": index },
    async fetch(req, srv) {
      const url = new URL(req.url);
      const needsOrigin = req.method !== "GET" || url.pathname === "/ws";
      const denied = guard(req, srv.port as number, needsOrigin, url.pathname.startsWith("/api/") || url.pathname === "/ws");
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
        if (e instanceof FileRefused) return fail(e.status, e.message);
        if (e instanceof DeleteRefused) return fail(e.status, e.message);
        if (e instanceof AlreadyResolved) return fail(409, "Already handled");
        if (e instanceof InvalidTransition) return fail(409, e.message);
        if (e instanceof RuleRefused) return fail(409, e.message);
        if (e instanceof BadDraft) return fail(400, e.message);
        if (e instanceof PushRefused) return fail(409, e.message);
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
      message: (ws, raw) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        const m = msg as { type?: unknown; visible?: unknown } | null;
        if (m?.type === "visibility" && typeof m.visible === "boolean") setVisible(ws, m.visible);
      },
      close: (ws) => setVisible(ws, false),
    },
  });

  const off = bus.on((e) => {
    const msg = JSON.stringify(e);
    server.publish("engine", msg);
    if (e.type === "changed") server.publish("changed", msg);
  });
  const stop = server.stop.bind(server);
  embed = startEmbed(deps.port ?? config().port, server.port as number, embedToken);
  server.stop = (force?: boolean) => {
    off();
    embed?.stop(force);
    return stop(force);
  };
  return Object.assign(server, { embedPort: embed ? (embed.port as number) : null, embedToken });
}

// TradingView's chart page gets a listener of its own on the next port (any free port when the engine's is
// random, as in tests). It serves that one page, at a per-launch secret path, and nothing else, so the third-party
// script runs on an origin with no API behind it; the engine's guard refuses anything that origin (or a page it
// opens) sends. The dashboard and the Mac app learn the port and path from the engine, never by guessing.
function startEmbed(requested: number, enginePort: number, token: string): Server<undefined> | null {
  const port = requested === 0 ? 0 : enginePort + 1;
  try {
    const embed: Server<undefined> = Bun.serve({
      hostname: config().host,
      port,
      reusePort: false,
      fetch(req) {
        const url = new URL(req.url);
        const own = [`127.0.0.1:${embed.port}`, `localhost:${embed.port}`];
        if (!own.includes(req.headers.get("host") ?? "")) return fail(403, "Forbidden host.");
        if (req.method === "GET" && url.pathname === embedPath(token)) return embedResponse(req, url, enginePort);
        return fail(404, "Not found.");
      },
    });
    return embed;
  } catch (e) {
    console.error(`The chart page couldn't start on port ${port}; symbol pages will show Atrium's chart. ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
