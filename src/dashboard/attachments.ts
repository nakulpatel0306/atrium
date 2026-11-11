import { batchRefusal } from "../engine/attachment-rules";
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

// The engine checks again; this is so a refused file is named before anything is sent.
export const checkFiles = (files: File[], already: File[]) => batchRefusal(files, already);

// The Files on a drag or paste, or none when it carries only text.
export function filesOf(data: DataTransfer | null): File[] {
  return data ? [...data.files] : [];
}

export const draggingFiles = (data: DataTransfer | null) => !!data && [...data.types].includes("Files");

export async function uploadAttachments(spaceId: string, files: File[]): Promise<PostResult<Attached[]>> {
  const form = new FormData();
  for (const f of files) form.append("file", f, f.name);
  try {
    const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/attachments`, { method: "POST", body: form });
    const data = (await res.json().catch(() => null)) as (Attached[] & { error?: string }) | null;
    if (!res.ok) return { ok: false, error: data?.error ?? `Atrium couldn't attach those files (error ${res.status}). Try again.` };
    return { ok: true, data: data as Attached[] };
  } catch {
    return { ok: false, error: "Can't reach the Atrium engine. Check that it's running, then try again." };
  }
}
