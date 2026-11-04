import { useEffect, useState } from "react";
import { fetchTranscript } from "../api";

type Props = {
  runId: string;
  title: string;
  onClose: () => void;
};

type Loaded = { kind: "loading" } | { kind: "ok"; text: string } | { kind: "error"; text: string };

export function Transcript({ runId, title, onClose }: Props) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);

  useEffect(() => {
    let live = true;
    setLoaded({ kind: "loading" });
    void fetchTranscript(runId).then((res) => {
      if (live) setLoaded(res.ok ? { kind: "ok", text: res.text } : { kind: "error", text: res.error });
    });
    return () => {
      live = false;
    };
  }, [runId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    if (loaded.kind !== "ok") return;
    try {
      await navigator.clipboard.writeText(loaded.text);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Transcript: ${title}`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-title">
            <b>{title}</b>
            <span className="sub">Transcript · {runId}</span>
          </div>
          {copied && <span className="sub">{copied === "yes" ? "Copied" : "Couldn't copy. Select the text instead."}</span>}
          <button className="btn" disabled={loaded.kind !== "ok"} onClick={() => void copy()}>
            Copy
          </button>
          <button className="btn" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        {loaded.kind === "loading" && <p className="sheet-note">Loading transcript…</p>}
        {loaded.kind === "error" && <p className="sheet-note err">{loaded.text}</p>}
        {loaded.kind === "ok" && <pre className="mono">{loaded.text || "This run didn't write anything."}</pre>}
      </div>
    </div>
  );
}
