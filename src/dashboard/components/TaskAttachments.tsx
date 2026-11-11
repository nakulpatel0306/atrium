import { useState } from "react";
import { kindOf } from "../../engine/outputs/kinds";
import { fileSize } from "../../engine/text";
import type { State } from "../api";
import { fileUrl, runFileAction, useFilePreview } from "../files";
import { TypeIcon } from "./AttachChips";
import { PreviewPane } from "./PreviewPane";

type Attachment = State["attachments"][number];

const DRAWABLE = /\.(png|jpe?g|gif|webp)$/i;

// What Atrium can show in place; the rest (PDF, Word, Excel, HEIC) opens in its app, like the Files tab's Open.
const previewable = (name: string) => DRAWABLE.test(name) || kindOf(name) !== "other";

function Item({ a, open, onToggle }: { a: Attachment; open: boolean; onToggle: () => void }) {
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const ref = { spaceId: a.spaceId, taskId: a.taskId ?? "", root: "space" as const, path: a.path };
  const click = async () => {
    if (previewable(a.name)) return onToggle();
    setSaid(await runFileAction("open", { ...ref, absPath: "" }));
  };
  return (
    <li>
      <button className="att-file" aria-expanded={previewable(a.name) ? open : undefined} onClick={() => void click()} title={a.path}>
        {DRAWABLE.test(a.name) ? <img className="att-thumb" src={fileUrl(ref, true)} alt="" loading="lazy" /> : <span className="att-thumb icon"><TypeIcon name={a.name} /></span>}
        <span className="att-name">{a.name}</span>
        <span className="att-size">{fileSize(a.size)}</span>
      </button>
      {said && <p className={said.ok ? "made-said" : "made-said err"}>{said.text}</p>}
    </li>
  );
}

function Preview({ a }: { a: Attachment }) {
  const ref = { spaceId: a.spaceId, taskId: a.taskId ?? "", root: "space" as const, path: a.path };
  const preview = useFilePreview(ref, a.createdAt);
  return preview ? <PreviewPane preview={preview} rawUrl={fileUrl(ref, true)} /> : null;
}

export function TaskAttachments({ attachments }: { attachments: Attachment[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!attachments.length) return null;
  const shown = attachments.find((a) => a.id === open);
  return (
    <section className="att-list">
      <h4>Attached files</h4>
      <ul>
        {attachments.map((a) => (
          <Item key={a.id} a={a} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} />
        ))}
      </ul>
      {shown && <Preview key={shown.id} a={shown} />}
    </section>
  );
}
