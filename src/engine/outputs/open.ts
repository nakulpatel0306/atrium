import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../config";
import { CHANGED, FileRefused, readBytes, readOpen, type Target } from "./files";
import { extOf, OPENABLE } from "./kinds";

export { OPENABLE } from "./kinds";

export type OpenHow = "open" | "reveal" | "calendar";


const RUNS_CODE = "Atrium won't open this kind of file directly, since it could run code. Use Reveal in Finder to look at it.";
const OPEN_CAP = 100 * 1024 * 1024;
const COPY_TTL_MS = 24 * 60 * 60_000;

const TEXT = new Set(["md", "markdown", "txt", "csv", "tsv", "json", "yaml", "yml", "rtf"]);
const VIEW = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "heic"]);
// Office files go to whichever suite is installed; TextEdit reads .docx too.
const OFFICE: Record<string, string[]> = {
  docx: ["Microsoft Word", "Pages", "TextEdit"],
  xlsx: ["Microsoft Excel", "Numbers"],
  pptx: ["Microsoft PowerPoint", "Keynote"],
};

const installed = (app: string) =>
  app === "TextEdit" || ["/Applications", "/System/Applications"].some((d) => existsSync(join(d, `${app}.app`)));

// A named app per type, never the file's default handler: a default can be anything, including something that
// runs what it opens.
export function appFor(absPath: string, how: OpenHow): string {
  const ext = extOf(absPath);
  if (how === "calendar") {
    if (ext !== "ics") throw new FileRefused(403, "Only .ics files can be added to Calendar.");
    return "Calendar";
  }
  if (!OPENABLE.has(ext)) throw new FileRefused(403, RUNS_CODE);
  if (ext === "ics") return "Calendar";
  if (TEXT.has(ext)) return "TextEdit";
  if (VIEW.has(ext)) return "Preview";
  const app = OFFICE[ext]!.find(installed);
  if (!app) throw new FileRefused(403, `No app on this Mac opens .${ext} files. Use Reveal in Finder to look at it.`);
  return app;
}

// Open and Add to Calendar launch a copy in Atrium's own data folder, which agents can't reach: whatever an agent
// does to the space folder afterwards, the app gets exactly the bytes Atrium checked. Reveal only selects the file
// in Finder, which can't run it, so it uses the real path once that still names the checked file.
export async function openFile(t: Target, how: OpenHow): Promise<{ app: string; copy: boolean }> {
  let argv: string[];
  let result: { app: string; copy: boolean };
  if (how === "reveal") {
    const st = lstatSync(t.absPath, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || st.dev !== t.dev || st.ino !== t.ino) throw new FileRefused(409, CHANGED);
    argv = ["-R", t.absPath];
    result = { app: "Finder", copy: false };
  } else {
    if (t.isDir) throw new FileRefused(403, how === "calendar" ? "Only .ics files can be added to Calendar." : RUNS_CODE);
    const app = appFor(t.absPath, how);
    const bytes = readOpen(t, (fd, st) => {
      if (st.mode & 0o111) throw new FileRefused(403, RUNS_CODE);
      if (st.size > OPEN_CAP) throw new FileRefused(413, "This file is too big to open from Atrium. Use Reveal in Finder to open it.");
      return readBytes(fd, st.size);
    });
    const safe = app === "Calendar" ? new TextEncoder().encode(safeAlarms(bytes)) : bytes;
    argv = ["-a", app, privateCopy(basename(t.absPath), safe)];
    result = { app, copy: true };
  }
  const proc = Bun.spawn([config().openBin, ...argv], { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10_000, env: { ...process.env } });
  const code = await proc.exited;
  if (code !== 0 || proc.signalCode !== null) {
    throw new Error(`macOS couldn't open ${basename(t.absPath)}. Use Reveal in Finder and open it from there.`);
  }
  return result;
}

const NOT_UTF8 = "This calendar file isn't plain UTF-8 text, so Atrium won't send it to Calendar. Use Reveal in Finder to look at it.";
const DURATION = /^[+-]?P(\d+W|(\d+D)?(T(\d+H)?(\d+M)?(\d+S)?)?)$/;
const DATE_TIME = /^\d{8}T\d{6}Z$/;

type Prop = { name: string; params: Record<string, string>; value: string };

// "NAME;PARAM=x;P2=\"a:b\":value", with quoted parameter values allowed to hold ":" and ";". Null when malformed.
function parseLine(line: string): Prop | null {
  let i = 0;
  let quoted = false;
  const parts: string[] = [];
  let cur = "";
  for (; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') quoted = !quoted;
    if (!quoted && (c === ";" || c === ":")) {
      parts.push(cur);
      cur = "";
      if (c === ":") break;
      continue;
    }
    cur += c;
  }
  if (i >= line.length || quoted) return null;
  const [name, ...params] = parts;
  if (!name || !/^[A-Za-z0-9-]+$/.test(name)) return null;
  const out: Record<string, string> = {};
  for (const p of params) {
    const eq = p.indexOf("=");
    if (eq <= 0) return null;
    out[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params: out, value: line.slice(i + 1) };
}

// An alarm survives only as a fresh display alarm built from its trigger and a plain description.
function rebuiltAlarm(props: Prop[]): string[] | null {
  const actions = props.filter((p) => p.name === "ACTION");
  const triggers = props.filter((p) => p.name === "TRIGGER");
  if (actions.length !== 1 || actions[0]!.value.trim().toUpperCase() !== "DISPLAY" || triggers.length !== 1) return null;
  if (props.some((p) => p.name === "ATTACH" || p.name === "URL" || p.name.startsWith("X-"))) return null;
  const t = triggers[0]!;
  const value = t.value.trim().toUpperCase();
  const absolute = t.params.VALUE?.toUpperCase() === "DATE-TIME";
  if (absolute ? !DATE_TIME.test(value) : !DURATION.test(value) || value.replace(/[+-]?P/, "").replace("T", "") === "") return null;
  const related = t.params.RELATED?.toUpperCase();
  const params = absolute ? ";VALUE=DATE-TIME" : related === "END" ? ";RELATED=END" : "";
  const said = props.find((p) => p.name === "DESCRIPTION")?.value ?? "";
  const description = said.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200).trim() || "Reminder";
  return ["BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER${params}:${value}`, `DESCRIPTION:${description}`, "END:VALARM"];
}

// Calendar would keep an agent's alarms: a PROCEDURE alarm runs a file, an EMAIL alarm mails someone, an ATTACH or
// URL fetches from wherever it points. This fails closed: odd encodings are refused, lines are unfolded before
// anything is read, names are matched in any case, only plain display alarms come back (rebuilt, never copied),
// and any alarm structure that doesn't parse cleanly drops every alarm while the events stay.
export function safeAlarms(bytes: Uint8Array): string {
  const bom = (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) || (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe);
  if (bom || bytes.includes(0)) throw new FileRefused(403, NOT_UTF8);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FileRefused(403, NOT_UTF8);
  }
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  const out: (string | string[])[] = [];
  let alarm: Prop[] | null = null;
  let broken = false;
  for (const line of lines) {
    if (line === "") continue;
    const prop = parseLine(line);
    const begin = prop?.name === "BEGIN" && prop.value.trim().toUpperCase() === "VALARM";
    const end = prop?.name === "END" && prop.value.trim().toUpperCase() === "VALARM";
    if (alarm) {
      if (!prop || begin) {
        broken = true;
        alarm = null;
      } else if (end) {
        const rebuilt = rebuiltAlarm(alarm);
        if (rebuilt) out.push(rebuilt);
        alarm = null;
      } else alarm.push(prop);
      continue;
    }
    if (begin) alarm = [];
    else if (end || !prop) broken = true;
    else out.push(line);
  }
  if (alarm) broken = true;
  return out.flatMap((x) => (Array.isArray(x) ? (broken ? [] : x) : [x])).join("\r\n") + "\r\n";
}

function privateCopy(name: string, bytes: Uint8Array): string {
  const root = join(config().home, "open-copies");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Old copies go when the next one is made; nothing runs on a timer.
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (Date.now() - statSync(p).mtimeMs > COPY_TTL_MS) rmSync(p, { recursive: true, force: true });
  }
  const dir = mkdtempSync(join(root, "c-"));
  const path = join(dir, name);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return path;
}
