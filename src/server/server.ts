import type { Database } from "bun:sqlite";
import type { Server, ServerWebSocket } from "bun";
import { existsSync, readFileSync } from "node:fs";
import index from "../dashboard/index.html";
import type { Registry } from "../engine/agents/registry";
import { STEER_NOTE_MAX, type SteerOutcome, type StopOutcome } from "../engine/runner";
import { AlreadyResolved, getApproval, resolveApproval } from "../engine/approvals";
import { answerProposal, considerProposal, getProposal, suggestAgain } from "../engine/autonomy/proposals";
import { getRule, renewRule, revokeRule, ruleApprovals, ruleEvents, RuleRefused, undoAutoApproval } from "../engine/autonomy/rules";
import { markSeen } from "../engine/briefing";
import { config } from "../engine/config";
import { ChangesRefused, taskChanges } from "../engine/changes";
import { bus } from "../engine/events";
import type { setupSpace } from "../engine/setup";
import { type OnCreate, SetupFailed } from "../engine/setup";
import { setSetting } from "../engine/settings";
import { listMessages } from "../engine/messages";
import { createSpace, getSpace, REVIEWERS, type ReviewerId, updateSpace } from "../engine/spaces";
import { DeleteRefused, deleteSpace, deleteTask, spaceDeletePreview, taskDeletePreview } from "../engine/delete";
import { snapshot } from "../engine/state";
import { summary } from "../engine/summary";
import { KeychainError } from "../engine/keychain";
import { REMOVED_FEATURE_RETRY, STAYS_PRIVATE } from "../engine/legacy";
import { findOldData, OLD_DATA_DISMISSED, removeOldData } from "../engine/old-data";
import { createTask, getTask, InvalidTransition, setTaskStatus } from "../engine/tasks";
import { fail, HttpError, isBool, isString, json, opt, readBody, str } from "./http";
import { FileRefused } from "../engine/outputs/files";
import { filesRoute } from "./files";
import { attachedView, attachmentsRoute, isMultipart, MAX_BODY_BYTES, readUploads } from "./attachments";
import { type Attachment, AttachRefused, attachToTask, checkAttachments, checkUploads, claimAttachments, storeAttachments, withAttachments } from "../engine/attachments";
import { DEFAULT_PROMPT } from "../engine/attachment-rules";
import { startRoute } from "./start";
import type { Repos } from "../engine/repos";
import { BadDraft } from "../engine/repos/names";
import { openPullRequest, PrFailed, prInfo } from "../engine/repos/pr";
import { PushRefused } from "../engine/repos/push";
import { reposRoute } from "./repos";

type Deps = {
  db: Database;
  runner: {
    kick(): void;
    stopTask?(taskId: string): Promise<StopOutcome>;
    steerTask?(taskId: string, note: string): Promise<SteerOutcome>;
    steerPending?(taskId: string): boolean;
    outputSeq?(runId: string): number | null;
    registry?: Registry;
  };
  setup: (text: string, onCreate?: OnCreate) => ReturnType<typeof setupSpace>;
  port?: number;
  repos?: Repos;
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

export function startServer(deps: Deps): Server<WsData> {
  const { db, runner } = deps;

  const origins = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`];
  // Blocks DNS rebinding (Host) and other websites driving or reading the engine. Mutations and the socket must carry
  // our Origin; any API read that says it comes from another site (a foreign Origin, or Sec-Fetch-Site naming
  // another site or another port) is refused too, so a web page can't read what the engine knows. Reads with neither header (curl, the terminal app, the Mac app) are allowed.
  const guard = (req: Request, port: number, needsOrigin: boolean, api: boolean): Response | null => {
    if (!origins(port).includes(req.headers.get("host") ?? "")) return fail(403, "Forbidden host.");
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

    if (hit("GET", /^\/api\/state$/)) return json(snapshot(db, runner.registry));
    if (hit("GET", /^\/api\/summary$/)) return json(summary(db));

    // What removed features left behind: listed first, removed only when the user confirms that list.
    if (hit("GET", /^\/api\/old-data$/)) return json(await findOldData(db));
    if (hit("POST", /^\/api\/old-data\/remove$/)) return json(await removeOldData(db));
    if (hit("POST", /^\/api\/old-data\/dismiss$/)) {
      setSetting(db, OLD_DATA_DISMISSED, "1");
      bus.emit({ type: "changed" });
      return json({ ok: true });
    }

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
      const current = getSpace(db, id);
      if (!current) throw new HttpError(404, "No such space.");
      const b = await readBody(req);
      const status = b.status;
      if (status !== undefined && status !== "active" && status !== "archived") {
        throw new HttpError(400, "status must be active or archived.");
      }
      // Spaces of removed kinds held personal data, so they always read as private; storing otherwise would do nothing.
      if (current.unknownKind && b.private === false) throw new HttpError(409, STAYS_PRIVATE);
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
      const space = getSpace(db, spaceId);
      if (!space) throw new HttpError(404, "No such space.");
      const weight = b.weight;
      if (weight !== undefined && weight !== "heavy" && weight !== "light") {
        throw new HttpError(400, "weight must be heavy or light.");
      }
      const title = str(b.title, "title");
      const detail = opt(b.detail, isString, "detail");
      const agent = agentField(b.agent);
      const allowOnBattery = opt(b.allowOnBattery, isBool, "allowOnBattery");
      const task = db.transaction(() => {
        const files = checkAttachments(db, space, b.attachments);
        const t = createTask(db, { spaceId, title, detail: withAttachments(detail ?? "", files), weight, allowOnBattery, agent });
        claimAttachments(db, t.id, files);
        return t;
      })();
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
      // The runner would only fail it again.
      if (current.legacyPurpose !== null) throw new HttpError(409, REMOVED_FEATURE_RETRY);
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

    // Waits for the run to wind down, so the answer says what actually happened: 200 with the task blocked when it
    // stopped; 202 with the task still running when the agent hasn't exited yet (it's marked stopped when it does);
    // 409 when it finished first, since its result stands.
    const stopM = hit("POST", /^\/api\/tasks\/([^/]+)\/stop$/);
    if (stopM) {
      const id = stopM[1]!;
      const task = getTask(db, id);
      if (!task) throw new HttpError(404, "No such task.");
      if (task.status !== "running") throw new HttpError(409, "This task isn't running, so there's nothing to stop.");
      const outcome = (await runner.stopTask?.(id)) ?? "not-running";
      if (outcome === "not-running") throw new HttpError(409, "Atrium isn't running this task right now. Restart the engine if it still shows as running.");
      if (outcome === "finished") throw new HttpError(409, "It finished before it could be stopped, so its result stands.");
      return json(getTask(db, id), outcome === "timeout" ? 202 : 200);
    }

    // Stop and continue with Nakul's note: 200 once the task is back in the queue with it; 202 while the agent is still
    // winding down (it requeues when it exits); 409 when there's no run to steer.
    const steerM = hit("POST", /^\/api\/tasks\/([^/]+)\/steer$/);
    if (steerM) {
      const id = steerM[1]!;
      const task = getTask(db, id);
      if (!task || getSpace(db, task.spaceId)?.kind !== "repo") throw new HttpError(404, "No such task in a repo space.");
      const b = await readBody(req);
      if (typeof b.note !== "string" || !b.note.trim()) throw new HttpError(400, "Write a note for the agent first.");
      const note = b.note.trim();
      if (note.length > STEER_NOTE_MAX) throw new HttpError(400, `Keep the note to ${STEER_NOTE_MAX.toLocaleString("en-US")} characters or fewer.`);
      const pending = "Already restarting with your note.";
      if (runner.steerPending?.(id)) throw new HttpError(409, pending);
      if (task.status !== "running") throw new HttpError(409, "This task isn't running, so there's nothing to steer.");
      const outcome = (await runner.steerTask?.(id, note)) ?? "not-running";
      if (outcome === "pending") throw new HttpError(409, pending);
      if (outcome === "blocked") throw new HttpError(409, `It couldn't start again with your note: ${getTask(db, id)?.blockedReason ?? "it was blocked."}`);
      if (outcome === "not-running") throw new HttpError(409, "It finished or stopped before your note arrived, so nothing was restarted.");
      return json(getTask(db, id), outcome === "timeout" ? 202 : 200);
    }

    const prInfoM = hit("GET", /^\/api\/tasks\/([^/]+)\/pr$/);
    if (prInfoM) {
      if (!getTask(db, prInfoM[1]!)) throw new HttpError(404, "No such task.");
      return json(await prInfo(db, prInfoM[1]!));
    }

    // Nakul's click on "Push and open PR" is his yes; 409 when the task can't open one or GitHub turns the push
    // down, 502 when gh fails.
    const prM = hit("POST", /^\/api\/tasks\/([^/]+)\/pr$/);
    if (prM) {
      if (!getTask(db, prM[1]!)) throw new HttpError(404, "No such task.");
      const b = await readBody(req);
      const title = str(b.title, "title").trim();
      if (typeof b.body !== "string") throw new HttpError(400, "body is required.");
      if (title.length > 256) throw new HttpError(400, "Keep the title to 256 characters or fewer.");
      const sha = str(b.sha, "sha");
      return json(await openPullRequest(db, prM[1]!, { title, body: b.body, sha }));
    }

    const diffM = hit("GET", /^\/api\/tasks\/([^/]+)\/diff$/);
    if (diffM) return json(await taskChanges(db, diffM[1]!));

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
      // Files sent with a description for a new space go to its first task, in the same step that makes it, so the
      // task can't start without them. They come up front because there's no space yet to upload them to.
      if (isMultipart(req)) {
        const { fields, files } = await readUploads(req);
        const text = str(fields.text, "text");
        checkUploads(files);
        let attached: Attachment[] = [];
        const result = await deps.setup(text, (space, tasks) => {
          if (space.kind === "repo" || !tasks[0]) return tasks;
          attached = storeAttachments(db, space, files);
          attachToTask(db, tasks[0].id, attached);
          return [getTask(db, tasks[0].id)!, ...tasks.slice(1)];
        });
        return json({ ...result, attached: attachedView(attached) });
      }
      const b = await readBody(req);
      if (b.spaceId === undefined) return json(await deps.setup(str(b.text, "text")));
      const space = getSpace(db, str(b.spaceId, "spaceId"));
      if (!space) throw new HttpError(404, "No such space.");
      const agent = agentField(b.agent);
      const task = db.transaction(() => {
        const files = checkAttachments(db, space, b.attachments);
        // Files alone are a request too: the agent is asked to look at them.
        const text = files.length && (typeof b.text !== "string" || !b.text.trim()) ? DEFAULT_PROMPT : str(b.text, "text");
        const t = createTask(db, {
          spaceId: space.id,
          title: text.split("\n")[0]!.slice(0, 80),
          detail: withAttachments(text, files),
          weight: space.kind === "repo" ? "heavy" : "light",
          agent,
        });
        claimAttachments(db, t.id, files);
        return t;
      })();
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
      if (!row || !existsSync(row.transcript_path)) throw new HttpError(404, "No transcript for that run.");
      // The line count and the file are read in one synchronous step, so no line is appended between them: a live
      // reader skips the run-output lines numbered up to it, which the text already has.
      const seq = runner.outputSeq?.(trM[1]!) ?? null;
      const text = readFileSync(row.transcript_path);
      // Agent output is untrusted; a browser must never sniff it into HTML on the engine's origin.
      const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" };
      if (seq !== null) headers["x-atrium-output-seq"] = String(seq);
      return new Response(text, { headers });
    }

    const files = await filesRoute(db, req, url);
    if (files) return files;
    const attached = await attachmentsRoute(db, req, url);
    if (attached) return attached;
    const start = await startRoute(db, req, url);
    if (start) return start;

    if (deps.repos) {
      const res = await reposRoute(db, deps.repos, req, url);
      if (res) return res;
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
    // The biggest thing anyone sends is a full set of attachments.
    maxRequestBodySize: MAX_BODY_BYTES,
    routes: { "/": index, "/space/*": index, "/agents": index, "/rules": index, "/settings": index, "/start": index, "/needs-you": index, "/activity": index },
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
        if (e instanceof AttachRefused) return fail(e.status, e.message);
        if (e instanceof DeleteRefused) return fail(e.status, e.message);
        if (e instanceof AlreadyResolved) return fail(409, "Already handled");
        if (e instanceof InvalidTransition) return fail(409, e.message);
        if (e instanceof RuleRefused) return fail(409, e.message);
        if (e instanceof BadDraft) return fail(400, e.message);
        if (e instanceof PushRefused) return fail(409, e.message);
        if (e instanceof ChangesRefused) return fail(e.status, e.message);
        if (e instanceof PrFailed) return fail(502, e.message);
        if (e instanceof KeychainError) return fail(409, e.message);
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
      open: (ws) => {
        ws.subscribe(ws.data.topic);
      },
      // Clients only listen.
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
