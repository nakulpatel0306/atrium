import type { Database } from "bun:sqlite";
import { doctor } from "../engine/doctor";
import { HOME_CURRENCY, setProjectsRoot, setUserName, storedName, suggestedName } from "../engine/profile";
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
      if (b.name !== undefined) check(() => setUserName(db, String(b.name)));
      if (b.projectsRoot !== undefined) check(() => setProjectsRoot(db, String(b.projectsRoot)));
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
