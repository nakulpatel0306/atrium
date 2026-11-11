import { MAX_FILES, MAX_TOTAL_BYTES, refusal } from "../engine/attachment-rules";
import type { PostResult } from "./api";

export type Attached = { id: string; name: string; size: number; type: string };

// A screenshot pasted from the clipboard arrives with a stand-in name ("image.png" in Chrome, "Pasted Graphic.png"
// from some apps); a file copied in Finder keeps its own.
const STAND_IN = /^(image|pasted graphic( \d+)?|untitled)\.\w+$/i;
const pad = (n: number) => String(n).padStart(2, "0");

export function pastedName(file: File, now: Date): string {
  if (file.name && !STAND_IN.test(file.name)) return file.name;
  const ext = file.name.match(/\.(\w+)$/)?.[1] ?? file.type.split("/")[1] ?? "png";
  return `pasted-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.${ext.toLowerCase()}`;
}

export const renamed = (file: File, name: string) => (name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified }));

// Which of the incoming files can join the ones already attached, in order, and why each of the rest can't. The
// engine checks again; this is so a refused file is named before anything is sent, without losing the good ones.
export function sortFiles(incoming: File[], already: File[]): { ok: File[]; refused: string[] } {
  const ok: File[] = [];
  const refused: string[] = [];
  let count = already.length;
  let total = already.reduce((n, f) => n + f.size, 0);
  for (const f of incoming) {
    const why = refusal(f.name, f.size);
    if (why) refused.push(why);
    else if (count + 1 > MAX_FILES) refused.push(`${f.name} would make more than ${MAX_FILES} files, the most one task can carry.`);
    else if (total + f.size > MAX_TOTAL_BYTES) refused.push(`${f.name} would take the files past 100 MB, the most one task can carry.`);
    else {
      ok.push(f);
      count++;
      total += f.size;
    }
  }
  return { ok, refused };
}

// The Files on a drag or paste, or none when it carries only text.
export function filesOf(data: DataTransfer | null): File[] {
  return data ? [...data.files] : [];
}

export const draggingFiles = (data: DataTransfer | null) => !!data && [...data.types].includes("Files");

// A multipart POST; the browser sets its length and boundary.
async function postForm<T>(path: string, form: FormData): Promise<PostResult<T>> {
  try {
    const res = await fetch(path, { method: "POST", body: form });
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) return { ok: false, error: data?.error ?? `Atrium couldn't attach those files (error ${res.status}). Try again.` };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "Can't reach the Atrium engine. Check that it's running, then try again." };
  }
}

const formOf = (files: File[], fields: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) form.append("file", f, f.name);
  return form;
};

export const uploadAttachments = (spaceId: string, files: File[]) =>
  postForm<Attached[]>(`/api/spaces/${encodeURIComponent(spaceId)}/attachments`, formOf(files));

// A new space's description with its files, which the engine gives to the space's first task.
export const setupWithFiles = <T>(text: string, files: File[]) => postForm<T & { attached: Attached[] }>("/api/command", formOf(files, { text }));
