import type { Database } from "bun:sqlite";
import { getApproval, isOwnYes } from "../approvals";
import { git } from "../git";
import { ghCredentialFlags, ghProblem } from "./gh";

export class PushRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushRefused";
  }
}

// The one push Atrium makes on its own: a new project's first main, and only on Nakul's own yes to creating it.
// The approval is re-read here so no caller can push on a stale or rule-made decision.
export async function pushInitialMain(db: Database, approvalId: string, path: string, url: string, timeoutMs = 60_000): Promise<void> {
  const a = getApproval(db, approvalId);
  if (!a || !isOwnYes(a) || a.alwaysAsk !== "create_repo") throw new PushRefused("Only your own yes on a new repo can push.");
  const res = await git(path, [...ghCredentialFlags(), "push", "-q", url, "refs/heads/main:refs/heads/main"], timeoutMs);
  if (res.code !== 0 || res.timedOut) throw ghProblem(res, {});
}
