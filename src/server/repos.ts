import type { Database } from "bun:sqlite";
import { resolveApproval } from "../engine/approvals";
import type { Repos } from "../engine/repos";
import { BadDraft, projectPath, validateDraft } from "../engine/repos/names";
import { getClone, getRepoAction, updateDraft } from "../engine/repos/store";
import { HttpError, json, readBody } from "./http";

// New-project drafts, repo storage and clone removal. Returns null for paths it doesn't own.
export async function reposRoute(db: Database, repos: Repos, req: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;
  const method = req.method;

  const approveM = method === "POST" ? pathname.match(/^\/api\/repo-actions\/([^/]+)\/approve$/) : null;
  if (approveM) {
    const action = getRepoAction(db, approveM[1]!);
    if (!action || action.kind !== "create") throw new HttpError(404, "No such new-project draft.");
    const b = await readBody(req);
    let draft: ReturnType<typeof validateDraft>;
    try {
      draft = validateDraft(b);
      projectPath(draft.name);
    } catch (e) {
      if (e instanceof BadDraft) throw new HttpError(400, e.message);
      throw e;
    }
    // His edits and his yes land together: the approval he decides on is exactly what will be created.
    db.transaction(() => {
      updateDraft(db, action.id, draft);
      resolveApproval(db, action.approvalId, "approve");
    })();
    return json(getRepoAction(db, action.id));
  }

  if (method === "GET" && pathname === "/api/storage") return json(await repos.storage());

  const askM = method === "POST" ? pathname.match(/^\/api\/clones\/([^/]+)\/ask-remove$/) : null;
  if (askM) {
    if (!getClone(db, askM[1]!)) throw new HttpError(404, "No such local copy.");
    const res = await repos.askToRemove(askM[1]!);
    if ("reasons" in res) throw new HttpError(409, res.reasons.join(" "));
    return json(res);
  }
  return null;
}
