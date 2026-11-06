import type { Space } from "../engine/spaces";
import type { FilePreview } from "../engine/outputs/files";
import { type FileKind, OPENABLE, extOf } from "../engine/outputs/kinds";
import type { SpaceFiles, TaskOutputs } from "../engine/outputs/views";
import { fileSize } from "../engine/text";
import { post, useEngineState, useFetched } from "./api";

export type { FilePreview, SpaceFiles, TaskOutputs };

export type FileRef = { spaceId: string; taskId: string; root: "space" | "branch"; path: string };

// A task's results change whenever a run ends or a decision lands, which any state push can mean.
export const useTaskOutputs = (taskId: string | null) =>
  useFetched<TaskOutputs>(taskId ? `/api/tasks/${encodeURIComponent(taskId)}/outputs` : null, useEngineState());

export const useSpaceFiles = (spaceId: string) => useFetched<SpaceFiles>(`/api/spaces/${encodeURIComponent(spaceId)}/files`, useEngineState());

// Read once per file and version, so a preview doesn't refetch on every unrelated push.
export const useFilePreview = (file: FileRef | null, at: number) => useFetched<FilePreview>(file ? fileUrl(file) : null, at);

export function fileUrl(f: FileRef, raw = false): string {
  const base = f.root === "branch" ? `/api/tasks/${encodeURIComponent(f.taskId)}` : `/api/spaces/${encodeURIComponent(f.spaceId)}`;
  return `${base}/file${raw ? "/raw" : ""}?path=${encodeURIComponent(f.path)}`;
}

export type FileAction = "open" | "reveal" | "calendar" | "copyPath" | "copyText";

export const ACTION_LABEL: Record<FileAction, string> = {
  open: "Open",
  reveal: "Reveal in Finder",
  calendar: "Add to Calendar",
  copyPath: "Copy path",
  copyText: "Copy text",
};

// In display order. Open never shows for anything that could run code; a branch file's newest version isn't in
// the working copy, so it can only be revealed; an .ics opens in Calendar, which is what "Add to Calendar" does.
export function fileActions(f: { root: "space" | "branch"; kind: FileKind; path: string; exists: boolean }, _spaceKind: Space["kind"]): FileAction[] {
  if (!f.exists) return ["copyPath"];
  const text: FileAction[] = f.kind === "markdown" || f.kind === "text" ? ["copyText"] : [];
  if (f.root === "branch") return ["reveal", "copyPath", ...text];
  const first: FileAction[] = f.kind === "calendar" ? ["calendar"] : OPENABLE.has(extOf(f.path)) ? ["open"] : [];
  return [...first, "reveal", "copyPath", ...text];
}

export const sizeText = (n: number | null): string => (n === null ? "" : fileSize(n));

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "20261109T070000" → "Mon, Nov 9 · 7:00 AM". A time ending in Z is UTC and shown in local time; any other time
// (floating or with a TZID) is shown as written, which is how the agent meant it.
function icsDate(value: string): string | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  const date = z ? new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!)) : new Date(+y!, +mo! - 1, +d!, h ? +h : 0, mi ? +mi : 0);
  const day = `${DAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
  if (h === undefined) return day;
  const hour = date.getHours() % 12 || 12;
  return `${day} · ${hour}:${String(date.getMinutes()).padStart(2, "0")} ${date.getHours() < 12 ? "AM" : "PM"}`;
}

const unescape = (v: string) => v.replace(/\\([\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? " " : c));

export function icsEvents(text: string): { summary: string; start: string; end: string | null; location: string | null }[] {
  // A line starting with a space or tab continues the one before it.
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events: { summary: string; start: string; end: string | null; location: string | null }[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT" && cur) {
      events.push({
        summary: unescape(cur.SUMMARY ?? "Untitled event"),
        start: (cur.DTSTART && icsDate(cur.DTSTART)) ?? cur.DTSTART ?? "",
        end: cur.DTEND ? (icsDate(cur.DTEND) ?? cur.DTEND) : null,
        location: cur.LOCATION ? unescape(cur.LOCATION) : null,
      });
      cur = null;
      if (events.length === 50) break;
    } else if (cur) {
      const colon = line.indexOf(":");
      if (colon > 0) cur[line.slice(0, colon).split(";")[0]!.toUpperCase()] = line.slice(colon + 1);
    }
  }
  return events;
}

const nameOf = (path: string) => (path === "." ? "the folder" : path.slice(path.lastIndexOf("/") + 1));

// Runs one action and returns the line to show under the row.
export async function runFileAction(action: FileAction, f: FileRef & { absPath: string }): Promise<{ ok: boolean; text: string }> {
  const name = nameOf(f.path);
  if (action === "copyPath" || action === "copyText") {
    try {
      let text = f.absPath;
      let cut = false;
      if (action === "copyText") {
        const res = await fetch(fileUrl(f));
        const preview = res.ok ? ((await res.json()) as FilePreview) : null;
        if (preview?.text == null) return { ok: false, text: "Couldn't copy. Select the text in the preview instead." };
        text = preview.text;
        cut = preview.truncated;
      }
      await navigator.clipboard.writeText(text);
      return { ok: true, text: action === "copyPath" ? "Copied the path." : cut ? "Copied the first 256 KB. Open the file for the rest." : "Copied the text." };
    } catch {
      return { ok: false, text: "Couldn't copy. Select the text in the preview instead." };
    }
  }
  const res = await post<{ app: string; copy: boolean }>(`/api/spaces/${encodeURIComponent(f.spaceId)}/file/open`, { path: f.path, how: action });
  if (!res.ok) return { ok: false, text: res.error };
  if (action === "reveal") return { ok: true, text: `Showing ${name} in Finder.` };
  if (action === "calendar") return { ok: true, text: `Sent ${name} to Calendar. Confirm the import there.` };
  return { ok: true, text: `Opened a copy of ${name} in ${res.data.app}. To change the file itself, use Reveal in Finder.` };
}
