import { CalendarDays, File, FileText, Image } from "lucide-react";
import { useState } from "react";
import type { SpaceFile } from "../../engine/outputs/views";
import type { State } from "../api";
import { ACTION_LABEL, type FileAction, fileActions, fileUrl, runFileAction, sizeText, type SpaceFiles, useFilePreview, useSpaceFiles } from "../files";
import { absolute, relative } from "../format";
import { navigate } from "../route";
import { PreviewPane } from "./PreviewPane";
import { middle } from "./WhatItMade";

type Space = State["spaces"][number];

const ICON = { markdown: FileText, text: FileText, image: Image, calendar: CalendarDays, other: File };
const KEPT = /^runs\/[^/]+\//;

function Row({ file, space }: { file: SpaceFile; space: Space }) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const ref = { spaceId: space.id, taskId: file.madeBy?.taskId ?? "", root: file.root, path: file.path };
  const preview = useFilePreview(open ? ref : null, file.at);
  const Icon = ICON[file.kind];
  const kept = KEPT.test(file.path);
  const act = async (a: FileAction) => setSaid(await runFileAction(a, { ...ref, absPath: file.absPath }));
  return (
    <li className="made-row">
      <div className="made-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon className="made-icon" />
        <span className="made-path mono" title={file.absPath}>
          {kept && <span className="kept">kept from a run · </span>}
          {middle(kept ? file.path.replace(KEPT, "") : file.path)}
        </span>
        <span className="made-size">{sizeText(file.size)}</span>
        <span className="made-size" title={absolute(file.at)}>
          {relative(file.at)}
        </span>
        <span className="made-by">
          {file.madeBy ? (
            <a
              href={`/space/${space.id}?task=${file.madeBy.taskId}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                navigate(`/space/${space.id}?task=${file.madeBy!.taskId}`);
              }}
            >
              by "{file.madeBy.title}"
            </a>
          ) : (
            "added outside Atrium"
          )}
        </span>
        <span className="made-acts">
          {fileActions({ ...file, exists: true }, space.kind).map((a) => (
            <button
              key={a}
              className="btn"
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

function FolderLine({ files, space }: { files: SpaceFiles; space: Space }) {
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  if (space.kind === "repo") return <p className="files-head">Files Atrium's tasks changed in {files.shown ?? "this repo"}</p>;
  const reveal = async () => setSaid(await runFileAction("reveal", { spaceId: space.id, taskId: "", root: "space", path: ".", absPath: files.folder ?? "" }));
  const copy = async () => setSaid(await runFileAction("copyPath", { spaceId: space.id, taskId: "", root: "space", path: ".", absPath: files.folder ?? "" }));
  return (
    <div className="files-head">
      <span>
        Folder <span className="mono">{files.shown}</span>
      </span>
      <span className="made-acts">
        <button className="btn" onClick={() => void reveal()}>
          Reveal in Finder
        </button>
        <button className="btn" onClick={() => void copy()}>
          Copy path
        </button>
      </span>
      {said && <p className={said.ok ? "made-said" : "made-said err"}>{said.text}</p>}
    </div>
  );
}

export function FilesList({ files, space }: { files: SpaceFiles; space: Space }) {
  return (
    <div className="files-tab">
      <FolderLine files={files} space={space} />
      {files.files.length === 0 ? (
        <div className="list">
          <div className="empty-row">
            {space.kind === "repo"
              ? "No changes yet. Files a task changes on its branch show up here."
              : `No files yet. Files the agents make in ${space.name} show up here.`}
          </div>
        </div>
      ) : (
        <ul className="made-files">
          {files.files.map((f) => (
            <Row key={`${f.root}:${f.path}`} file={f} space={space} />
          ))}
        </ul>
      )}
      {files.truncated && <p className="preview-note">Showing the newest 2,000 files.</p>}
    </div>
  );
}

export function FilesTab({ space }: { space: Space }) {
  const files = useSpaceFiles(space.id);
  return files ? <FilesList files={files} space={space} /> : null;
}
