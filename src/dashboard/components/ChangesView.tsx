import { ChevronDown, ChevronRight, MessageCircleQuestion } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import type { DiffFile, DiffHunk, DiffLine, DiffResult } from "../../engine/diff-parse";
import { post, type State, useDiffVersion } from "../api";
import type { ChangeSpot } from "../route";
import { Markdown } from "./Markdown";
import { middle } from "./WhatItMade";

type Task = State["tasks"][number];

// Files this long start folded, so one generated file doesn't bury the rest.
const FOLD_LINES = 400;

const STATUS = { added: "new", modified: "changed", deleted: "deleted", renamed: "renamed" };
const CHIP = { added: "created", modified: "changed", deleted: "deleted", renamed: "changed" };

const lineCount = (f: DiffFile) => f.hunks.reduce((n, h) => n + h.lines.length, 0);
const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

export function changesHeader(t: DiffResult["totals"]): string {
  return `${plural(t.files, "file")} changed · +${t.additions.toLocaleString("en-US")} −${t.deletions.toLocaleString("en-US")}`;
}

const anchor = (path: string) => `chg-${encodeURIComponent(path)}`;
const hunkAnchor = (path: string, i: number) => `${anchor(path)}-h${i}`;

// The hunk whose changed side holds `line`, else the file's first.
export function hunkAt(file: DiffFile, line: number | null): number {
  if (line === null) return 0;
  const i = file.hunks.findIndex((h) => {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(h.header);
    return m ? line >= Number(m[1]) && line < Number(m[1]) + Number(m[2] ?? 1) : false;
  });
  return Math.max(i, 0);
}

// A short fingerprint of a hunk's header and lines (FNV-1a), unique enough to tell a file's hunks apart.
function hunkKey(h: DiffHunk): string {
  let x = 0x811c9dc5;
  for (const c of `${h.header}\n${h.lines.map((l) => `${l.kind[0]}${l.text}`).join("\n")}`) x = Math.imul(x ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return `${h.header}#${x.toString(36)}`;
}

export type DiffMode = "unified" | "split";
export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

// A hunk side by side: context on both sides, and each run of removed lines paired with the added lines after it.
export function splitRows(h: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < h.lines.length) {
    const l = h.lines[i]!;
    if (l.kind === "ctx") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < h.lines.length && h.lines[i]!.kind === "del") dels.push(h.lines[i++]!);
    while (i < h.lines.length && h.lines[i]!.kind === "add") adds.push(h.lines[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

const SIGN = { add: "+", del: "−", ctx: " " };

function UnifiedLines({ hunk }: { hunk: DiffHunk }) {
  return (
    <>
      {hunk.lines.map((l, j) => (
        <tr key={j} className={`chg-${l.kind}`}>
          <td className="chg-no">{l.oldNo ?? ""}</td>
          <td className="chg-no">{l.newNo ?? ""}</td>
          <td className="chg-text">
            <span className="chg-sign">{SIGN[l.kind]}</span>
            {l.text}
          </td>
        </tr>
      ))}
    </>
  );
}

function SplitLines({ hunk }: { hunk: DiffHunk }) {
  const side = (l: DiffLine | null, no: number | undefined) =>
    l ? (
      <>
        <td className={`chg-no chg-${l.kind}`}>{no ?? ""}</td>
        <td className={`chg-text chg-${l.kind}`}>
          <span className="chg-sign">{SIGN[l.kind]}</span>
          {l.text}
        </td>
      </>
    ) : (
      <>
        <td className="chg-no chg-gap" />
        <td className="chg-text chg-gap" />
      </>
    );
  return (
    <>
      {splitRows(hunk).map((r, j) => (
        <tr key={j}>
          {side(r.left, r.left?.oldNo)}
          {side(r.right, r.right?.newNo)}
        </tr>
      ))}
    </>
  );
}

// A hunk's header row with "Explain this hunk": the cheap tier's conceptual answer, kept by the engine per hunk, shown
// in a row of its own under the header.
function HunkHead({ taskId, file, hunk, index, focused, cols }: { taskId: string | null; file: string; hunk: DiffHunk; index: number; focused: boolean; cols: number }) {
  const [state, setState] = useState<{ busy: boolean; note: string | null; error: string | null }>({ busy: false, note: null, error: null });
  const explain = async () => {
    setState({ busy: true, note: null, error: null });
    const res = await post<{ note: string }>(`/api/tasks/${taskId}/explain-hunk`, { file, header: hunk.header });
    setState(res.ok ? { busy: false, note: res.data.note, error: null } : { busy: false, note: null, error: res.error });
  };
  return (
    <>
      <tr className={`chg-hunk${focused ? " focus" : ""}`} id={hunkAnchor(file, index)}>
        <td colSpan={cols}>
          {hunk.header}
          {taskId && !state.note && (
            <button className="btn link subtle chg-explain" disabled={state.busy} onClick={() => void explain()}>
              <MessageCircleQuestion />
              {state.busy ? "Explaining…" : "Explain this hunk"}
            </button>
          )}
        </td>
      </tr>
      {(state.note || state.error) && (
        <tr className="chg-explained">
          <td colSpan={cols}>{state.note ? <Markdown text={state.note} /> : <span className="err">{state.error}</span>}</td>
        </tr>
      )}
    </>
  );
}

function FileDiff({ file, open, onToggle, taskId, focus, mode }: { file: DiffFile; open: boolean; onToggle: () => void; taskId: string | null; focus: number | null; mode: DiffMode }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="chg-file" id={anchor(file.path)}>
      <button className="chg-file-head" onClick={onToggle} aria-expanded={open}>
        <Chevron />
        <span className="mono chg-path" title={file.path}>
          {file.path}
        </span>
        <span className="chg-count">
          <span className="chg-add">+{file.additions}</span> <span className="chg-del">−{file.deletions}</span>
        </span>
      </button>
      {open &&
        (file.note ? (
          <p className="chg-note">{file.note}</p>
        ) : file.binary ? (
          <p className="chg-note">A binary file, so there are no lines to show.</p>
        ) : file.hunks.length === 0 ? (
          <p className="chg-note">{file.status === "renamed" ? "Moved without changes." : "No lines changed."}</p>
        ) : (
          <table className={`chg-lines mono ${mode}`}>
            {/* A fixed layout sizes columns from the first row, a full-width hunk header, so the widths are set here. */}
            {mode === "split" && (
              <colgroup>
                <col className="chg-no-col" />
                <col />
                <col className="chg-no-col" />
                <col />
              </colgroup>
            )}
            <tbody>
              {file.hunks.map((h, i) => (
                // Keyed by what the hunk holds, so on a live diff an explanation stays with its own hunk.
                <Fragment key={hunkKey(h)}>
                  <HunkHead taskId={taskId} file={file.path} hunk={h} index={i} focused={focus === i} cols={mode === "split" ? 4 : 3} />
                  {mode === "split" ? <SplitLines hunk={h} /> : <UnifiedLines hunk={h} />}
                </Fragment>
              ))}
            </tbody>
          </table>
        ))}
      {open && file.truncated && !file.note && <p className="chg-note">Showing the first 2,000 lines of this file.</p>}
    </section>
  );
}

// Without fetching, so a test can render it. `live` names the agent while its run is still going; with `taskId` each
// hunk offers an explanation, and `at` opens the list at one hunk. `controls` sits in the header (the turn and
// view pickers).
export function ChangesList({ diff, live, taskId = null, at = null, mode = "unified", controls = null }: { diff: DiffResult; live: string | null; taskId?: string | null; at?: ChangeSpot | null; mode?: DiffMode; controls?: ReactNode }) {
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const target = at ? diff.files.find((f) => f.path === at.file) : undefined;
  const focus = target ? { path: target.path, hunk: hunkAt(target, at!.line) } : null;
  useEffect(() => {
    if (!focus) return;
    setFolded((prev) => ({ ...prev, [focus.path]: false }));
    // After the unfolded file has rendered.
    requestAnimationFrame(() => document.getElementById(hunkAnchor(focus.path, focus.hunk))?.scrollIntoView({ block: "center" }));
  }, [focus?.path, focus?.hunk]);
  const isOpen = (f: DiffFile) => !(folded[f.path] ?? lineCount(f) > FOLD_LINES);
  const toggle = (f: DiffFile) => setFolded((prev) => ({ ...prev, [f.path]: isOpen(f) }));
  const jump = (f: DiffFile) => {
    setFolded((prev) => ({ ...prev, [f.path]: false }));
    document.getElementById(anchor(f.path))?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="changes">
      <div className="chg-head">
        <b>{changesHeader(diff.totals)}</b>
        {live && <span className="chg-live">Updating as {live} works</span>}
        {controls}
      </div>
      {diff.files.length === 0 ? (
        <p className="chg-empty">No changes yet.</p>
      ) : (
        <div className="chg-body">
          <ul className="chg-list">
            {diff.files.map((f) => (
              <li key={f.path}>
                <button onClick={() => jump(f)} title={f.path}>
                  <span className="mono chg-path">{middle(f.path, 40)}</span>
                  <span className={`tag chip-${CHIP[f.status]}`}>{STATUS[f.status]}</span>
                  <span className="chg-count">
                    <span className="chg-add">+{f.additions}</span> <span className="chg-del">−{f.deletions}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="chg-diff">
            {diff.files.map((f) => (
              <FileDiff key={f.path} file={f} open={isOpen(f)} onToggle={() => toggle(f)} taskId={taskId} focus={focus?.path === f.path ? focus.hunk : null} mode={mode} />
            ))}
          </div>
        </div>
      )}
      {diff.unchecked && diff.unchecked.length > 0 && (
        // Folded: these are probably unchanged, but Atrium couldn't read them to be sure.
        <details className="chg-unchecked">
          <summary>Large files not checked · {diff.unchecked.length}</summary>
          <ul>
            {diff.unchecked.map((u) => (
              <li key={u.path}>
                <span className="mono">{u.path}</span> <span className="chg-note-inline">{u.note}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {diff.truncated && <p className="chg-note">Some changes were left out to keep this view under 200 KB. Open the branch in your editor to see all of them.</p>}
    </div>
  );
}

// Read again on every diff-changed event for this task, and whenever the task itself changes (it finished, its
// branch moved). A failed read keeps what's shown and says why.
export function ChangesView({ task, agent, at = null }: { task: Task; agent: string; at?: ChangeSpot | null }) {
  const version = useDiffVersion(task.id);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One turn's commit on its own, or null for everything the task changed.
  const [turn, setTurn] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>(storedMode);
  // A running task's turns aren't committed yet, so it shows everything so far.
  useEffect(() => {
    if (task.status === "running") setTurn(null);
  }, [task.status]);
  // One read at a time: a change that arrives mid-read asks for exactly one more once it lands.
  const reads = useRef({ busy: false, again: false, live: true });

  useEffect(() => {
    const r = reads.current;
    r.live = true;
    return () => {
      r.live = false;
    };
  }, []);

  useEffect(() => {
    const r = reads.current;
    const read = async () => {
      if (r.busy) {
        r.again = true;
        return;
      }
      r.busy = true;
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/diff${turn ? `?turn=${turn}` : ""}`);
        const body = (await res.json().catch(() => null)) as (DiffResult & { error?: string }) | null;
        if (!r.live) return;
        if (res.ok && body) {
          setDiff(body);
          setError(null);
        } else setError(body?.error ?? `Atrium couldn't read the changes (error ${res.status}). Try again in a moment.`);
      } catch {
        if (r.live) setError("Can't reach the Atrium engine. Check that it's running, then try again.");
      } finally {
        r.busy = false;
        if (r.again && r.live) {
          r.again = false;
          void read();
        }
      }
    };
    void read();
  }, [task.id, task.status, task.updatedAt, version, turn]);

  const turns = diff?.turns ?? [];
  const controls = (
    <span className="chg-controls">
      {turns.length > 1 && (
        <select className="pick" aria-label="Which changes" value={turn ?? ""} onChange={(e) => setTurn(e.target.value || null)}>
          <option value="">All changes</option>
          {turns.map((t, i) => (
            <option key={t.sha} value={t.sha}>
              Turn {i + 1}: {t.title}
            </option>
          ))}
        </select>
      )}
      <span className="seg" role="group" aria-label="Diff layout">
        {(["unified", "split"] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={mode === m ? "on" : ""}
            aria-pressed={mode === m}
            onClick={() => {
              setMode(m);
              saveMode(m);
            }}
          >
            {m === "unified" ? "Unified" : "Split"}
          </button>
        ))}
      </span>
    </span>
  );
  return (
    <section className="changes-section">
      {error && <p className="err">{error}</p>}
      {diff ? <ChangesList diff={diff} live={task.status === "running" ? agent : null} taskId={task.id} at={at} mode={mode} controls={controls} /> : !error && <p className="chg-empty">Reading the changes…</p>}
    </section>
  );
}

// The layout is a viewer's preference, kept in this browser only.
const MODE_KEY = "atrium.diffMode";
function storedMode(): DiffMode {
  try {
    return localStorage.getItem(MODE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}
function saveMode(m: DiffMode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // Without storage the choice lasts until the page closes.
  }
}
