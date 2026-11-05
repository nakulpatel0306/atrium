import type { Database } from "bun:sqlite";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getApproval, isOwnYes } from "../approvals";
import { config } from "../config";
import { bus, logActivity } from "../events";
import { git } from "../git";
import { createSpace } from "../spaces";
import { GhProblem, ghCreateRepo, ghEditDescription, ghLogin } from "./gh";
import { cloneRepo, initialCommit, remoteState } from "./gitops";
import { projectPath } from "./names";
import { pushInitialMain } from "./push";
import { draftProject, getRepoAction, type RepoAction, recordClone, setActionStatus } from "./store";
import { templateFiles, writeTemplate } from "./templates";

const stagingPath = (actionId: string) => join(config().projectsRoot, `.atrium-new-${actionId}`);

// Runs only after Nakul's own yes. Everything that can fail on this Mac (folder, template, identity, signing) is
// done before GitHub is touched, so most failures leave no empty repo behind.
export async function createProject(db: Database, actionId: string, deps: { kick(): void; ghTimeoutMs?: number }): Promise<RepoAction> {
  const action = getRepoAction(db, actionId);
  if (!action || action.kind !== "create" || !action.draft) throw new Error(`No new-project draft with id ${actionId}`);
  if (action.status !== "draft") return action;
  const approval = getApproval(db, action.approvalId);
  setActionStatus(db, actionId, "running");
  if (!approval || !isOwnYes(approval) || approval.alwaysAsk !== "create_repo") {
    return setActionStatus(db, actionId, "failed", { error: "Only your own yes can create a repo." });
  }
  const draft = action.draft;
  const gh = { timeoutMs: deps.ghTimeoutMs };
  let url = action.remoteUrl;
  let staging: string | null = null;
  try {
    const final = projectPath(draft.name);
    const owner = await ghLogin(gh);
    const state = url ? await remoteState(`${url}.git`, action.pushedSha) : "empty";
    if (state === "theirs") throw new Error(`${url} already has commits Atrium didn't make, so it won't push over them. Pick a new name.`);
    mkdirSync(config().projectsRoot, { recursive: true });
    staging = stagingPath(actionId);
    if (state === "ours") {
      // An earlier run pushed the first commit and stopped after: pick that repo up as it is, nothing to push.
      await cloneRepo(`${url}.git`, staging);
    } else {
      // Not recursive: an existing staging folder means something is off, and it's never reused.
      mkdirSync(staging);
      writeTemplate(staging, templateFiles(draft.template, draft));
    }
    const sha = state === "ours" ? action.pushedSha! : await initialCommit(staging);
    if (!url) {
      url = await ghCreateRepo(draft, gh);
      // Saved at once, so a crash or failed push later reuses this empty repo instead of hitting "name taken".
      db.query("UPDATE repo_actions SET remote_url = ?, updated_at = ? WHERE id = ?").run(url, Date.now(), actionId);
    } else {
      await ghEditDescription(url.replace(/^https:\/\/github\.com\//, ""), draft.description, gh);
    }
    const slug = url.replace(/^https:\/\/github\.com\//, "");
    if (slug.split("/")[0]!.toLowerCase() !== owner.toLowerCase()) throw new Error(`${url} isn't on your account (${owner}), so Atrium won't push to it.`);
    if (state === "empty") {
      const remote = await git(staging, ["remote", "add", "origin", `${url}.git`]);
      if (remote.code !== 0) throw new Error(`Could not set the GitHub remote: ${remote.err.trim()}`);
      await pushInitialMain(db, action.approvalId, staging, `${url}.git`);
      db.query("UPDATE repo_actions SET pushed_sha = ?, updated_at = ? WHERE id = ?").run(sha, Date.now(), actionId);
    }
    projectPath(draft.name);
    renameSync(staging, final);
    staging = null;
    const done = db.transaction(() => {
      const space = createSpace(db, {
        name: draft.name,
        kind: "repo",
        goal: draft.description,
        repoPath: final,
        github: slug,
        private: draft.visibility === "private",
      });
      const clone = recordClone(db, { spaceId: space.id, path: final, github: slug, origin: "new_project" });
      logActivity(db, space.id, "atrium", `Created GitHub repo ${slug} and its space`);
      return setActionStatus(db, actionId, "done", { spaceId: space.id, cloneId: clone.id, remoteUrl: url });
    })();
    deps.kick();
    return done;
  } catch (e) {
    // The staging folder only ever holds files Atrium wrote, so removing it loses nothing of Nakul's.
    if (staging) rmSync(staging, { recursive: true, force: true });
    const message = e instanceof Error ? e.message : String(e);
    const failed = setActionStatus(db, actionId, "failed", { error: message, remoteUrl: url });
    const raw = e instanceof GhProblem && e.raw ? ` (GitHub said: ${e.raw})` : "";
    logActivity(db, null, "atrium", `Couldn't create ${draft.name}: ${message}${raw}`);
    draftProject(db, draft, { remoteUrl: url ?? undefined, lastError: message, pushedSha: getRepoAction(db, actionId)?.pushedSha ?? undefined });
    return failed;
  }
}

// On boot: a create cut off mid-run is failed and redrafted, carrying any repo it already made on GitHub.
export function recoverRepoActions(db: Database): number {
  const rows = db.query("SELECT id FROM repo_actions WHERE kind = 'create' AND status = 'running'").all() as { id: string }[];
  for (const { id } of rows) {
    const action = getRepoAction(db, id)!;
    const name = action.draft?.name ?? "the repo";
    const error = `Atrium stopped while creating ${name}.`;
    rmSync(stagingPath(id), { recursive: true, force: true });
    setActionStatus(db, id, "failed", { error });
    if (action.draft) draftProject(db, action.draft, { remoteUrl: action.remoteUrl ?? undefined, lastError: error, pushedSha: action.pushedSha ?? undefined });
  }
  if (rows.length > 0) bus.emit({ type: "changed" });
  return rows.length;
}
