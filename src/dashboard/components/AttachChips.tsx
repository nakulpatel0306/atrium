import { File as FileIcon, FileSpreadsheet, FileText, X } from "lucide-react";
import { useEffect, useState } from "react";
import { isImageName } from "../../engine/attachment-rules";
import { fileSize } from "../../engine/text";

// Browsers can draw these inline; HEIC gets an icon like any other file.
const DRAWABLE = /\.(png|jpe?g|gif|webp)$/i;

export function TypeIcon({ name }: { name: string }) {
  if (/\.(csv|xlsx)$/i.test(name)) return <FileSpreadsheet />;
  if (/\.(txt|md|json|pdf|docx)$/i.test(name)) return <FileText />;
  return <FileIcon />;
}

function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!DRAWABLE.test(file.name)) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url ? <img className="att-thumb" src={url} alt="" /> : <span className={`att-thumb icon${isImageName(file.name) ? " img" : ""}`}><TypeIcon name={file.name} /></span>;
}

export function AttachChips({ files, onRemove, disabled }: { files: File[]; onRemove: (f: File) => void; disabled?: boolean }) {
  if (!files.length) return null;
  return (
    <ul className="att-chips" aria-label="Attached files">
      {files.map((f, i) => (
        <li key={`${f.name}-${f.size}-${f.lastModified}-${i}`} className="att-chip" aria-label={`${f.name}, ${fileSize(f.size)}`}>
          <Thumb file={f} />
          <span className="att-name" title={f.name}>
            {f.name}
          </span>
          <span className="att-size">{fileSize(f.size)}</span>
          <button type="button" className="att-x" aria-label={`Remove ${f.name}`} title={`Remove ${f.name}`} disabled={disabled} onClick={() => onRemove(f)}>
            <X />
          </button>
        </li>
      ))}
    </ul>
  );
}
