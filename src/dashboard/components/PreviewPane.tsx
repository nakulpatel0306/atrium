import { useEffect, useRef, useState } from "react";
import { icsEvents, type FilePreview } from "../files";
import { Markdown } from "./Markdown";

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function Calendar({ text }: { text: string }) {
  const [raw, setRaw] = useState(false);
  const events = icsEvents(text);
  return (
    <>
      {events.length === 0 ? (
        <p className="preview-note">No events in this calendar file.</p>
      ) : (
        <ul className="ics">
          {events.map((e, i) => (
            <li key={i}>
              <b>{e.summary}</b>
              <span>
                {e.start}
                {e.end && ` to ${e.end.replace(/^.* · /, "")}`}
                {e.location && ` · ${e.location}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button className="btn link" onClick={() => setRaw(!raw)}>
        {raw ? "Hide raw" : "Show raw"}
      </button>
      {raw && <pre className="code">{text}</pre>}
    </>
  );
}

export function PreviewPane({ preview, rawUrl }: { preview: FilePreview; rawUrl: string }) {
  const { kind, text } = preview;
  const ref = useRef<HTMLDivElement>(null);
  // A preview opened near the bottom would otherwise sit under the command bar (main's scroll padding clears it).
  useEffect(() => ref.current?.scrollIntoView({ block: "nearest" }), []);
  return (
    <div className="preview" ref={ref}>
      {kind === "image" ? (
        <img src={rawUrl} alt={preview.path} />
      ) : text === null ? null : kind === "markdown" ? (
        <Markdown text={text} />
      ) : kind === "calendar" ? (
        <Calendar text={text} />
      ) : (
        <pre className="code">{preview.path.toLowerCase().endsWith(".json") && !preview.truncated ? prettyJson(text) : text}</pre>
      )}
      {preview.note && <p className="preview-note">{preview.note}</p>}
      {preview.truncated && <p className="preview-note">Showing the first 256 KB. Open the file to see all of it.</p>}
    </div>
  );
}
