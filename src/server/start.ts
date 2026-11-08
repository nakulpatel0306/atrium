import type { Database } from "bun:sqlite";
import { doctor } from "../engine/doctor";
import { resolve } from "node:path";
import { checkProjectsRoot, cleanUserName, expandHome, HOME_CURRENCY, NAME_KEY, setProjectsRoot, storedName, suggestedName } from "../engine/profile";
import { setSetting } from "../engine/settings";
import { config } from "../engine/config";
import { tildePath } from "../engine/folders";
import { getProgress, saveProgress, shouldAutoOpen } from "../engine/start";
import { claudeBlocks, needsClaudeCheck } from "../engine/start-steps";
import { HttpError, json, readBody } from "./http";

const profileOf = (db: Database) => ({ name: storedName(db), suggestedName: suggestedName(), projectsRoot: tildePath(config().projectsRoot), homeCurrency: HOME_CURRENCY });

function check<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

// Get started and the profile fields behind it: the checks, the wizard's saved place, and the user's name and folder.
export async function startRoute(db: Database, req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/profile") {
    if (req.method === "GET") return json(profileOf(db));
    if (req.method === "PUT") {
      const b = await readBody(req);
      // Both are checked before either is written, so a bad folder doesn't leave a half-saved profile.
      const name = b.name !== undefined ? check(() => cleanUserName(String(b.name))) : null;
      // Sending back the folder already in use isn't a choice; it must not pin a default.
      const same = b.projectsRoot !== undefined && resolve(expandHome(String(b.projectsRoot).trim())) === config().projectsRoot;
      const root = b.projectsRoot !== undefined && !same ? check(() => checkProjectsRoot(String(b.projectsRoot))) : null;
      if (name !== null) setSetting(db, NAME_KEY, name);
      if (root !== null) setProjectsRoot(db, root);
      return json(profileOf(db));
    }
    return null;
  }
  if (url.pathname !== "/api/start") return null;
  if (req.method === "GET") return json({ report: await doctor(db), progress: getProgress(db), autoOpen: shouldAutoOpen(db) });
  if (req.method === "PUT") {
    const b = await readBody(req);
    const problem = needsClaudeCheck(b) ? claudeBlocks(await doctor(db)) : null;
    return json(check(() => saveProgress(db, b, problem)));
  }
  return null;
}
