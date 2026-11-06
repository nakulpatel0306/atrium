import type { Database } from "bun:sqlite";
import { spaceFolder } from "../engine/folders";
import { branchPreview, branchRaw, readPreview, readRaw, resolveTarget } from "../engine/outputs/files";
import { type OpenHow, openFile } from "../engine/outputs/open";
import { spaceFiles, taskOutputs } from "../engine/outputs/views";
import { getSpace } from "../engine/spaces";
import { getTask } from "../engine/tasks";
import { HttpError, json, readBody, str } from "./http";

const HOW: OpenHow[] = ["open", "reveal", "calendar"];

// The bytes are an agent's; the browser must never treat them as a page on the engine's origin.
const rawResponse = (r: { bytes: Uint8Array; type: string }) =>
  new Response(r.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": r.type,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "no-store",
    },
  });

// What runs made and what space folders hold. Reads are confined to the space folder or the task's own branch;
// the one POST opens or reveals a file through macOS's open. Returns null for paths it doesn't own.
export async function filesRoute(db: Database, req: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;
  const method = req.method;
  const path = () => url.searchParams.get("path") ?? "";

  const outM = method === "GET" ? pathname.match(/^\/api\/tasks\/([^/]+)\/outputs$/) : null;
  if (outM) {
    const out = await taskOutputs(db, outM[1]!);
    if (!out) throw new HttpError(404, "No such task.");
    return json(out);
  }

  const taskFileM = method === "GET" ? pathname.match(/^\/api\/tasks\/([^/]+)\/file(\/raw)?$/) : null;
  if (taskFileM) {
    const task = getTask(db, taskFileM[1]!);
    if (!task) throw new HttpError(404, "No such task.");
    const repo = getSpace(db, task.spaceId)?.repoPath;
    if (!task.branch || !repo) throw new HttpError(404, "This task has no branch to read from.");
    return taskFileM[2] ? rawResponse(await branchRaw(repo, task.branch, path())) : json(await branchPreview(repo, task.branch, path()));
  }

  const spaceM = pathname.match(/^\/api\/spaces\/([^/]+)\/(files|file|file\/raw|file\/open)$/);
  if (!spaceM) return null;
  const space = getSpace(db, spaceM[1]!);
  if (!space) throw new HttpError(404, "No such space.");
  const what = spaceM[2]!;

  if (method === "GET" && what === "files") return json(await spaceFiles(db, space.id));
  if (method === "GET" && what === "file") {
    if (space.kind === "repo") throw new HttpError(404, "Open the task to preview files on its branch.");
    return json(readPreview(spaceFolder(space), path()));
  }
  if (method === "GET" && what === "file/raw") {
    if (space.kind === "repo") throw new HttpError(404, "Open the task to preview files on its branch.");
    return rawResponse(readRaw(spaceFolder(space), path()));
  }
  if (method === "POST" && what === "file/open") {
    const b = await readBody(req);
    const rel = str(b.path, "path");
    const how = b.how as OpenHow;
    if (!HOW.includes(how)) throw new HttpError(400, "how must be open, reveal or calendar.");
    if (rel === "." && how !== "reveal") throw new HttpError(400, "A folder can only be revealed in Finder.");
    if (space.kind === "repo") {
      if (how !== "reveal") {
        throw new HttpError(
          409,
          "This file's latest version is on its task branch, not in your working copy. Check out the branch to open it, or use the preview here.",
        );
      }
      if (!space.repoPath) throw new HttpError(404, "This space has no repo folder set.");
      return json({ ok: true, ...(await openFile(resolveTarget(space.repoPath, rel), how)) });
    }
    return json({ ok: true, ...(await openFile(resolveTarget(spaceFolder(space), rel), how)) });
  }
  return null;
}
