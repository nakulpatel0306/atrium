import type { Database } from "bun:sqlite";
import { MAX_FILES, MAX_TOTAL_BYTES } from "../engine/attachment-rules";
import { storeAttachments, type Upload } from "../engine/attachments";
import { getSpace } from "../engine/spaces";
import { HttpError, json } from "./http";

// Room for the multipart boundaries and headers around the files themselves.
const OVERHEAD = 1024 * 1024;
const TOO_BIG = "Those files add up to more than 100 MB, the most one task can carry.";

// Files from the ask bar, saved into the space's Attachments/ folder. The same-origin guard covers this POST like
// any other, so another website can't drop files into a space.
export async function attachmentsRoute(db: Database, req: Request, url: URL): Promise<Response | null> {
  const m = req.method === "POST" ? url.pathname.match(/^\/api\/spaces\/([^/]+)\/attachments$/) : null;
  if (!m) return null;
  const space = getSpace(db, m[1]!);
  if (!space) throw new HttpError(404, "No such space.");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "Send the files as multipart/form-data.");
  }
  // Refused before reading when the length says it's too big; Bun's own body cap stops one that lies.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_TOTAL_BYTES + OVERHEAD) throw new HttpError(413, TOO_BIG);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "Atrium couldn't read those files. Try attaching them again.");
  }
  const entries = form.getAll("file");
  if (entries.length > MAX_FILES) throw new HttpError(413, `A task can carry at most ${MAX_FILES} files.`);
  const files: Upload[] = [];
  for (const e of entries) {
    if (typeof e === "string") throw new HttpError(400, "Each file must be sent as a file.");
    files.push({ name: e.name, bytes: new Uint8Array(await e.arrayBuffer()) });
  }
  return json(storeAttachments(db, space, files).map(({ id, name, size, type }) => ({ id, name, size, type })));
}
