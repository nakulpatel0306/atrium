import type { Database } from "bun:sqlite";
import { MAX_FILES, MAX_TOTAL_BYTES } from "../engine/attachment-rules";
import { type Attachment, storeAttachments, type Upload } from "../engine/attachments";
import { getSpace } from "../engine/spaces";
import { HttpError, json } from "./http";

// Room for the multipart boundaries, headers and text fields around the files themselves.
const OVERHEAD = 1024 * 1024;
// The engine's whole request cap: the biggest upload allowed plus its overhead. Nothing else sends more than a few MB.
export const MAX_BODY_BYTES = MAX_TOTAL_BYTES + OVERHEAD;
const TOO_BIG = "Those files add up to more than 100 MB, the most one task can carry.";

export const isMultipart = (req: Request) => (req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");

// The text fields and files of a multipart body. Its length must be stated, and is refused before reading when it's
// too big; Bun's body cap (MAX_BODY_BYTES) stops one that understates it.
export async function readUploads(req: Request): Promise<{ fields: Record<string, string>; files: Upload[] }> {
  if (!isMultipart(req)) throw new HttpError(415, "Send the files as multipart/form-data.");
  const length = req.headers.get("content-length");
  if (length === null) throw new HttpError(411, "Atrium needs to know how big the upload is. Try attaching the files again.");
  if (Number(length) > MAX_BODY_BYTES) throw new HttpError(413, TOO_BIG);
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
  const fields: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k !== "file" && typeof v === "string") fields[k] = v;
  return { fields, files };
}

export const attachedView = (list: Attachment[]) => list.map(({ id, name, size, type }) => ({ id, name, size, type }));

// Files from the ask bar, saved into the space's Attachments/ folder. The same-origin guard covers this POST like
// any other, so another website can't drop files into a space.
export async function attachmentsRoute(db: Database, req: Request, url: URL): Promise<Response | null> {
  const m = req.method === "POST" ? url.pathname.match(/^\/api\/spaces\/([^/]+)\/attachments$/) : null;
  if (!m) return null;
  const space = getSpace(db, m[1]!);
  if (!space) throw new HttpError(404, "No such space.");
  const { files } = await readUploads(req);
  return json(attachedView(storeAttachments(db, space, files)));
}
