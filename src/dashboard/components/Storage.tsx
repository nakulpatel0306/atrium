import { HardDrive } from "lucide-react";
import { useState } from "react";
import type { StorageView } from "../../engine/repos";
import { post, useFetched } from "../api";
import { bytes } from "../format";
import { storageRow } from "../repos";

type Repo = StorageView["repos"][number];

function RepoRow({ repo, onAsked }: { repo: Repo; onAsked(): void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const row = storageRow(repo);
  const ask = async () => {
    setBusy(true);
    const res = await post(`/api/clones/${repo.cloneId}/ask-remove`);
    setBusy(false);
    if (res.ok) onAsked();
    else setError(res.error);
  };
  return (
    <div className="entry">
      <div className="item storage-row">
        <span className="t">
          <b>{row.name}</b>
          <span>{row.path}</span>
        </span>
        <span className="num">{row.size}</span>
        <span className={`tag${repo.createdBy === "atrium" ? "" : " private"}`}>{row.owner}</span>
        <span className="faint">Used {row.lastUsed}</span>
        {row.reasons.length > 0 ? (
          <button className="btn link" onClick={() => setOpen(!open)} aria-expanded={open} title={row.reasons.join(" ")}>
            {row.status}
          </button>
        ) : (
          <span className="faint">{row.status}</span>
        )}
        {row.canAsk && (
          <button className="btn" disabled={busy} onClick={() => void ask()}>
            Ask to remove
          </button>
        )}
      </div>
      {open && (
        <div className="detail">
          <ul className="reasons">
            {row.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <div className="row-err err">{error}</div>}
    </div>
  );
}

// Disk used by Atrium itself and by every repo folder a space points at. Only folders Atrium cloned can be
// removed, and only through a yes in Needs you.
export function Storage() {
  const [version, setVersion] = useState(0);
  const view = useFetched<StorageView>("/api/storage", version);
  return (
    <>
      <h2>
        <HardDrive />
        Storage
      </h2>
      {!view ? (
        <div className="list">
          <div className="empty-row">Measuring folders…</div>
        </div>
      ) : (
        <div className="list">
          <div className="item">
            <span className="t">
              <b>Atrium data</b>
              <span>Database and transcripts</span>
            </span>
            <span className="num">{bytes(view.atrium.totalBytes)}</span>
          </div>
          {view.repos.map((r) => (
            <RepoRow key={r.spaceId} repo={r} onAsked={() => setVersion((v) => v + 1)} />
          ))}
          {view.repos.length === 0 && <div className="empty-row">No repo folders yet.</div>}
        </div>
      )}
    </>
  );
}
