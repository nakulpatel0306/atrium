import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { DiffFile, DiffResult } from "../../engine/diff-parse";
import { type State, useDiffVersion } from "../api";
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

function FileDiff({ file, open, onToggle }: { file: DiffFile; open: boolean; onToggle: () => void }) {
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
          <table className="chg-lines mono">
            <tbody>
              {file.hunks.map((h, i) => [
                <tr key={`h${i}`} className="chg-hunk">
                  <td colSpan={3}>{h.header}</td>
                </tr>,
                ...h.lines.map((l, j) => (
                  <tr key={`${i}-${j}`} className={`chg-${l.kind}`}>
                    <td className="chg-no">{l.oldNo ?? ""}</td>
                    <td className="chg-no">{l.newNo ?? ""}</td>
                    <td className="chg-text">
                      <span className="chg-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                      {l.text}
                    </td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        ))}
      {open && file.truncated && !file.note && <p className="chg-note">Showing the first 2,000 lines of this file.</p>}
    </section>
  );
}

// Without fetching, so a test can render it. `live` names the agent while its run is still going.
export function ChangesList({ diff, live }: { diff: DiffResult; live: string | null }) {
  const [folded, setFolded] = useState<Record<string, boolean>>({});
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
              <FileDiff key={f.path} file={f} open={isOpen(f)} onToggle={() => toggle(f)} />
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
export function ChangesView({ task, agent }: { task: Task; agent: string }) {
  const version = useDiffVersion(task.id);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/tasks/${encodeURIComponent(task.id)}/diff`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as (DiffResult & { error?: string }) | null;
        if (!live) return;
        if (res.ok && body) {
          setDiff(body);
          setError(null);
        } else setError(body?.error ?? `Atrium couldn't read the changes (error ${res.status}). Try again in a moment.`);
      })
      .catch(() => live && setError("Can't reach the Atrium engine. Check that it's running, then try again."));
    return () => {
      live = false;
    };
  }, [task.id, task.status, task.updatedAt, version]);

  return (
    <section className="changes-section">
      {error && <p className="err">{error}</p>}
      {diff ? <ChangesList diff={diff} live={task.status === "running" ? agent : null} /> : !error && <p className="chg-empty">Reading the changes…</p>}
    </section>
  );
}
