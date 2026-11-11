import type { Database } from "bun:sqlite";
import { createApproval, getApproval, isOwnYes, resolveApproval } from "../approvals";
import { logActivity } from "../events";
import { branchSha, gitSettingsFingerprint, pushApprovedSha } from "../git";
import { lastRepoRun } from "../runner";
import { getSpace } from "../spaces";
import { getTask } from "../tasks";
import { ghCredentialFlags, GhProblem, ghPrCreate } from "./gh";
import { PushRefused } from "./push";

// Where a task's pull request would go. Everything comes from what was recorded before the agent ran (the remote,
// the branch the work started from, the repo's git settings) or when Nakul decided (`sha`, the commit he approved).
export type PrTarget = { taskId: string; repoDir: string; branch: string; sha: string; base: string; repo: string; remote: string; fingerprint: string | null };
export type PrInfo =
  | ({ eligible: true; url: string | null; title: string; body: string } & Omit<PrTarget, "taskId" | "repoDir" | "remote" | "fingerprint">)
  | { eligible: false; url: string | null; reason: string };

export class PrFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrFailed";
  }
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// "owner/name" from the GitHub remote forms git accepts; null for anything else.
export function githubSlug(remote: string): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remote);
  return m && m[2] !== "." && m[2] !== ".." ? `${m[1]}/${m[2]}` : null;
}

export async function prTarget(db: Database, taskId: string): Promise<PrTarget | { reason: string }> {
  const task = getTask(db, taskId);
  const space = task ? getSpace(db, task.spaceId) : null;
  if (!task || space?.kind !== "repo" || !space.repoPath || task.kind !== "work") return { reason: "Only work tasks in a repo space can open a pull request." };
  if (task.status !== "review" && task.status !== "done") return { reason: "A pull request can be opened once the task is ready for review or done." };
  const run = lastRepoRun(db, task.id);
  if (!task.branch || !run) return { reason: "This task has no branch to open a pull request from." };
  const head = await branchSha(space.repoPath, task.branch);
  if (!head) return { reason: `The branch ${task.branch} isn't in the repo anymore.` };
  // A decided review recorded the commit Nakul approved; that is what goes out, even if the branch moved since.
  const approved = db
    .query("SELECT branch_head FROM approvals WHERE task_id = ? AND kind = 'review' AND status = 'approved' AND branch_head IS NOT NULL ORDER BY resolved_at DESC, rowid DESC LIMIT 1")
    .get(task.id) as { branch_head: string } | null;
  const repo = run.remote ? githubSlug(run.remote) : null;
  if (!run.remote || !repo) return { reason: "This repo had no GitHub remote when the task ran, so there's nowhere to open a pull request." };
  if (SHA.test(run.start)) return { reason: "The work started from a commit rather than a branch, so there's no branch to merge it into." };
  return { taskId, repoDir: space.repoPath, branch: task.branch, sha: approved?.branch_head ?? head, base: run.start, repo, remote: run.remote, fingerprint: run.fingerprint };
}

// The newest review's text without Atrium's own "push it when you're ready" line, which a PR has made moot.
function defaultBody(db: Database, taskId: string): string {
  const row = db.query("SELECT detail FROM approvals WHERE task_id = ? AND kind = 'review' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(taskId) as
    | { detail: string }
    | null;
  const summary = (row?.detail ?? "")
    .split("\n\n")
    .filter((p) => !/^Branch \S+ is on your machine\. Push it when you're ready\.$/.test(p.trim()))
    .join("\n\n")
    .trim();
  return summary ? `${summary}\n\nOpened from Atrium.` : "Opened from Atrium.";
}

export async function prInfo(db: Database, taskId: string): Promise<PrInfo> {
  const url = getTask(db, taskId)?.prUrl ?? null;
  const t = await prTarget(db, taskId);
  if ("reason" in t) return { eligible: false, url, reason: t.reason };
  return { eligible: true, url, branch: t.branch, sha: t.sha, base: t.base, repo: t.repo, title: getTask(db, taskId)!.title, body: defaultBody(db, taskId) };
}

// What git said when the remote turned the push down, in words Nakul can act on; null when it wasn't a refusal.
function refusal(reason: string, t: PrTarget): string | null {
  if (/permission to .* denied|denied to|HTTP 403|error: 403|not allowed to push|insufficient permission|read-only/i.test(reason)) {
    return `Your GitHub account can't push to ${t.repo}. Check that you have write access, then try again.`;
  }
  if (/protected branch|GH006|GH013|repository rule/i.test(reason)) {
    return `GitHub turned the push down because of a branch rule on ${t.repo}. Check the repo's branch rules, then try again.`;
  }
  if (/non-fast-forward|\[rejected\]|fetch first/i.test(reason)) {
    return `${t.repo} already has a different ${t.branch} branch, so Atrium didn't overwrite it. Push it yourself if you meant to replace it.`;
  }
  return null;
}

const GH_COPY: Record<string, string> = {
  not_installed: "GitHub CLI (gh) isn't installed. Install it with `brew install gh`, run `gh auth login`, then try again.",
  logged_out: "gh is signed out of GitHub. Run `gh auth login` in a terminal, then try again.",
  offline: "Couldn't reach GitHub. Check your internet connection, then try again.",
  timeout: "GitHub didn't answer in time. If your Mac's keychain is locked, unlock it, then try again.",
};

function ghFailed(e: GhProblem, t: PrTarget): PrFailed {
  if (GH_COPY[e.kind]) return new PrFailed(GH_COPY[e.kind]!);
  if (e.kind === "not_found") return new PrFailed(`Couldn't find ${t.repo} on GitHub, or your account can't see it.`);
  if (/permission|not permitted|403/i.test(e.raw ?? "")) return new PrFailed(`Your GitHub account can't open pull requests on ${t.repo}. Check your access, then try again.`);
  return new PrFailed("GitHub didn't open the pull request, and Atrium couldn't tell why. Run `gh auth status` in a terminal to check gh still works, then try again.");
}

// One open at a time per task, so a double click can't record two yeses or push twice.
const opening = new Set<string>();

// Nakul's click on "Push and open PR" is the yes. It's recorded as an always-ask push approval he decided himself, so
// the audit trail shows it, and re-read before anything leaves the Mac. `sha` is the commit his confirm step showed;
// if the commit that would go out is a different one, nothing is pushed.
export async function openPullRequest(
  db: Database,
  taskId: string,
  input: { title: string; body: string; sha?: string },
  opts: { timeoutMs?: number } = {},
): Promise<{ url: string }> {
  if (opening.has(taskId)) throw new PushRefused("Already opening a pull request for this task.");
  opening.add(taskId);
  try {
    return await open(db, taskId, input, opts);
  } finally {
    opening.delete(taskId);
  }
}

async function open(db: Database, taskId: string, input: { title: string; body: string; sha?: string }, opts: { timeoutMs?: number }): Promise<{ url: string }> {
  const t = await prTarget(db, taskId);
  if ("reason" in t) throw new PushRefused(t.reason);
  if (input.sha !== undefined && input.sha !== t.sha) throw new PushRefused("The branch has changed since you looked. Check the commit shown, then try again.");
  // The push itself never reads the repo's config, but settings the agent changed are a reason to stop anyway.
  if (!t.fingerprint || (await gitSettingsFingerprint(t.repoDir).catch(() => null)) !== t.fingerprint) {
    throw new PushRefused("This repo's git settings changed since the task ran, so Atrium won't push from it. Check them in the repo, then push yourself.");
  }
  const task = getTask(db, taskId)!;
  const short = t.sha.slice(0, 7);
  const approval = db.transaction(() => {
    const a = createApproval(db, {
      spaceId: task.spaceId,
      taskId,
      kind: "question",
      title: `Push ${t.branch} to ${t.repo} and open a pull request?`,
      detail: `Commit ${short}, pull request into ${t.base}: ${input.title}`,
      alwaysAsk: "push",
    });
    return resolveApproval(db, a.id, "approve");
  })();
  const yes = getApproval(db, approval.id);
  if (!yes || !isOwnYes(yes) || yes.alwaysAsk !== "push") throw new PushRefused("Only your own yes can push a branch.");

  let flags: string[];
  try {
    flags = ghCredentialFlags();
  } catch (e) {
    if (e instanceof GhProblem) throw ghFailed(e, t);
    throw e;
  }
  const pushed = await pushApprovedSha(t.repoDir, t.sha, t.branch, t.remote, { flags, timeoutMs: opts.timeoutMs });
  if (!pushed.pushed) {
    const reason = pushed.reason ?? "";
    const refused = refusal(reason, t);
    if (refused) throw new PushRefused(refused);
    if (reason === "The push timed out.") throw new PrFailed(GH_COPY.timeout!);
    if (/could not resolve host|unable to access|connection refused|network is unreachable|timed out/i.test(reason)) throw new PrFailed(GH_COPY.offline!);
    if (/authentication failed|could not read username|terminal prompts disabled/i.test(reason)) throw new PrFailed(GH_COPY.logged_out!);
    throw new PrFailed(`The push to ${t.repo} didn't go through. Check that the repo still exists and gh is signed in, then try again.`);
  }

  let pr: { url: string; existed: boolean };
  try {
    pr = await ghPrCreate({ repo: t.repo, head: t.branch, base: t.base, title: input.title, body: input.body }, opts);
  } catch (e) {
    if (e instanceof GhProblem) throw ghFailed(e, t);
    throw e;
  }
  db.query("UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ?").run(pr.url, Date.now(), taskId);
  // Logging emits `changed`, so the task shows its link.
  logActivity(db, task.spaceId, "atrium", `Opened pull request ${pr.url}`, { taskId });
  return { url: pr.url };
}
