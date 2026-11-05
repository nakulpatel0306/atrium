import { FileUp, X } from "lucide-react";
import { useState } from "react";
import type { FieldMap, ImportField, ImportPreview } from "../../../engine/markets/import";
import type { Exchange } from "../../../engine/markets/instrument";
import { post } from "../../api";
import { money } from "../../format";

const FORMAT: Record<ImportPreview["format"], string> = {
  wealthsimple_holdings: "Wealthsimple holdings report",
  wealthsimple_activity: "Wealthsimple activity export",
  unknown: "Unrecognised CSV",
};
const EXCHANGES: Exchange[] = ["TSX", "TSXV", "US", "NEO", "OTC"];
const PICKABLE: { field: ImportField; label: string; required?: boolean }[] = [
  { field: "symbol", label: "Symbol", required: true },
  { field: "quantity", label: "Quantity", required: true },
  { field: "account", label: "Account" },
  { field: "bookValue", label: "Book value" },
  { field: "currency", label: "Currency" },
];

export function ImportDialog({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<FieldMap>({});
  const [overrides, setOverrides] = useState<Record<string, Exchange>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/markets/${encodeURIComponent(spaceId)}/import`;

  const run = async (next: { csv?: string; mapping?: FieldMap; overrides?: Record<string, Exchange> } = {}) => {
    const body = { csv: next.csv ?? csv, mapping: Object.keys(next.mapping ?? mapping).length ? (next.mapping ?? mapping) : undefined, exchangeOverrides: next.overrides ?? overrides };
    setBusy(true);
    const res = await post<ImportPreview>(`${base}/preview`, body);
    setBusy(false);
    setDone(null);
    if (!res.ok) return setError(res.error);
    setError(null);
    setPreview(res.data);
  };

  const commit = async () => {
    setBusy(true);
    const res = await post<{ added: number; replaced: number }>(base, {
      csv,
      mapping: Object.keys(mapping).length ? mapping : undefined,
      exchangeOverrides: overrides,
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDone(`Imported ${res.data.added}, replaced ${res.data.replaced}`);
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setFileName(file.name);
    setCsv(text);
    setMapping({});
    setOverrides({});
    await run({ csv: text, mapping: {}, overrides: {} });
  };

  return (
    <div className="mk-dialog" role="dialog" aria-label="Import holdings">
      <div className="mk-dialog-head">
        <b>Import holdings</b>
        <span className="hint">A Wealthsimple holdings report (best) or activity export. Re-importing an account replaces what the last import put there; holdings you added by hand stay.</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <X />
        </button>
      </div>
      <div className="mk-form">
        <label className="btn">
          <FileUp />
          {fileName ?? "Choose a CSV file"}
          <input type="file" accept=".csv,text/csv" hidden onChange={(e) => void pickFile(e.target.files?.[0])} />
        </label>
        <span className="hint">or paste it:</span>
        <textarea className="mk-input mk-paste" rows={2} value={csv} placeholder="Account Name,Account Type,…" onChange={(e) => setCsv(e.target.value)} />
        <button className="btn" disabled={!csv.trim() || busy} onClick={() => void run()}>
          Preview
        </button>
      </div>
      {error && <div className="err">{error}</div>}
      {preview && (
        <>
          <div className="mk-preview-meta">
            <span className="tag">{FORMAT[preview.format]}</span>
            {preview.asOf && <span>As of {preview.asOf}</span>}
            <span>
              {preview.rows.length} to import · {preview.skipped.length} skipped
            </span>
          </div>
          {preview.format === "unknown" && (
            <div className="mk-form">
              {PICKABLE.map(({ field, label, required }) => (
                <label key={field}>
                  {label}
                  {required ? "" : " (optional)"}
                  <select
                    className="pick"
                    value={mapping[field] ?? ""}
                    onChange={(e) => {
                      const next = { ...mapping };
                      if (e.target.value === "") delete next[field];
                      else next[field] = Number(e.target.value);
                      setMapping(next);
                      void run({ mapping: next });
                    }}
                  >
                    <option value="">—</option>
                    {preview.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          {preview.warnings.map((w) => (
            <div key={w} className="mk-warn">
              {w}
            </div>
          ))}
          {preview.guessed.length > 0 && (
            <div className="mk-form">
              <span className="hint">Activity exports don't say where each stock trades. Check these:</span>
              {preview.guessed.map((sym) => {
                const row = preview.rows.find((r) => r.symbol === sym);
                return (
                  <label key={sym}>
                    {sym}
                    <select
                      className="pick"
                      value={overrides[sym] ?? row?.exchange ?? "TSX"}
                      onChange={(e) => {
                        const next = { ...overrides, [sym]: e.target.value as Exchange };
                        setOverrides(next);
                        void run({ overrides: next });
                      }}
                    >
                      {EXCHANGES.map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          )}
          {preview.rows.length > 0 && (
            <div className="list mk-preview">
              {preview.rows.map((r, i) => (
                <div key={i} className="item mk-row">
                  <span className="who">{r.account}</span>
                  <span className="sym">
                    {r.symbol}
                    <small> {r.exchange}</small>
                  </span>
                  <span className="t">{r.name}</span>
                  <span className="num">{r.quantity}</span>
                  <span className="num">{r.bookValue === null ? "—" : money(r.bookValue, r.currency)}</span>
                </div>
              ))}
            </div>
          )}
          {preview.skipped.length > 0 && (
            <ul className="mk-skipped">
              {preview.skipped.map((s) => (
                <li key={s.line}>
                  Line {s.line}: {s.reason}
                </li>
              ))}
            </ul>
          )}
          <div className="mk-form">
            <button className="btn p" disabled={!preview.rows.length || busy || !!done} onClick={() => void commit()}>
              Import {preview.rows.length} {preview.rows.length === 1 ? "holding" : "holdings"}
            </button>
            {done && <span className="ok-line">{done}</span>}
          </div>
        </>
      )}
    </div>
  );
}
