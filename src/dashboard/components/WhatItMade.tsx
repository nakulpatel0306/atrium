import { CalendarDays, File, FileText, Image } from "lucide-react";
import { useState } from "react";
import type { OutputFile } from "../../engine/outputs/views";
import type { State } from "../api";
import { ACTION_LABEL, type FileAction, fileActions, fileUrl, runFileAction, sizeText, type TaskOutputs, useFilePreview, useTaskOutputs } from "../files";
import { absolute, relative } from "../format";
import { Markdown } from "./Markdown";
import { PreviewPane } from "./PreviewPane";

type SpaceKind = State["spaces"][number]["kind"];

const ICON = { markdown: FileText, text: FileText, image: Image, calendar: CalendarDays, other: File };
const CHIP = { created: "new", changed: "changed", deleted: "deleted" };

// Long paths keep their start and their file name: "reports/2026/…/week-of-nov-9.ics".
export function middle(path: string, max = 56): string {
  if (path.length <= max) return path;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.length >= max - 4) return `…${name.slice(-(max - 1))}`;
  return `${path.slice(0, max - name.length - 2)}…/${name}`;
}

function decided(s: NonNullable<TaskOutputs["summary"]>): string {
  if (s.status === "pending") return "Waiting for you";
  if (s.status === "rejected") return `Sent back · ${relative(s.at)}`;
  return `${s.decidedBy === "rule" ? "Approved by your rule" : "Approved by you"} · ${relative(s.at)}`;
}

function FileRow({ file, spaceId, taskId, spaceKind }: { file: OutputFile; spaceId: string; taskId: string; spaceKind: SpaceKind }) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const ref = { spaceId, taskId, root: file.root, path: file.path };
  const preview = useFilePreview(open ? ref : null, file.at);
  const Icon = ICON[file.kind];
  const exists = file.exists && file.change !== "deleted";
  const act = async (a: FileAction) => setSaid(await runFileAction(a, { ...ref, absPath: file.absPath }));
  const amount = file.insertions !== null || file.deletions !== null ? `+${file.insertions ?? 0} −${file.deletions ?? 0}` : sizeText(file.size);
  return (
    <li className={`made-row${exists ? "" : " gone"}`}>
      <div className="made-line" onClick={() => exists && setOpen(!open)} aria-expanded={exists ? open : undefined}>
        <Icon className="made-icon" />
        <span className="made-path mono" title={file.absPath}>
          {middle(file.path)}
        </span>
        <span className={`tag chip-${file.change}`}>{CHIP[file.change]}</span>
        {exists ? amount && <span className="made-size">{amount}</span> : <span className="made-size">No longer in the folder</span>}
        <span className="made-acts">
          {fileActions({ ...file, exists }, spaceKind).map((a) => (
            <button
              key={a}
              className="btn"
              title={a === "open" ? "Opens a copy, so the agent's file stays as it is" : undefined}
              onClick={(e) => {
                e.stopPropagation();
                void act(a);
              }}
            >
              {ACTION_LABEL[a]}
            </button>
          ))}
        </span>
      </div>
      {said && <p className={said.ok ? "made-said" : "made-said err"}>{said.text}</p>}
      {open && preview && <PreviewPane preview={preview} rawUrl={fileUrl(ref, true)} />}
    </li>
  );
}

export function WhatItMadeList({ outputs, spaceId, taskId, spaceKind }: { outputs: TaskOutputs; spaceId: string; taskId: string; spaceKind: SpaceKind }) {
  const { summary, files } = outputs;
  if (!summary && files.length === 0) return null;
  return (
    <div className="made">
      {summary && (
        <section>
          <h4>Summary</h4>
          <Markdown text={summary.text} />
          <p className="made-decided" title={absolute(summary.at)}>
            {decided(summary)}
          </p>
        </section>
      )}
      <section>
        <h4>What it made</h4>
        {files.length === 0 ? (
          <p className="made-none">No files. This run answered in text only.</p>
        ) : (
          <ul className="made-files">
            {files.map((f) => (
              <FileRow key={f.id} file={f} spaceId={spaceId} taskId={taskId} spaceKind={spaceKind} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function WhatItMade({ taskId, spaceId, spaceKind }: { taskId: string; spaceId: string; spaceKind: SpaceKind }) {
  const outputs = useTaskOutputs(taskId);
  return outputs ? <WhatItMadeList outputs={outputs} spaceId={spaceId} taskId={taskId} spaceKind={spaceKind} /> : null;
}
