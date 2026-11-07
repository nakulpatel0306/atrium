import { useState } from "react";
import type { DateOrder, MoneyField, MoneyMap, MoneyPreview, Signs } from "../../../engine/money/import";
import { post } from "../../api";
import { investPath } from "../../simple";

type Preview = MoneyPreview & { total: number; choices: string[] };
const OTHER = "Imported";
const FIELDS: { id: MoneyField; label: string }[] = [
  { id: "date", label: "Date" },
  { id: "description", label: "Description" },
  { id: "amount", label: "Amount" },
  { id: "debit", label: "Money out" },
  { id: "credit", label: "Money in" },
  { id: "account", label: "Account" },
];
const amountText = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Read on this Mac: a file is previewed, its columns and signs can be corrected, and only then imported.
export function MoneyImport({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [opts, setOpts] = useState<{ mapping?: MoneyMap; signs?: Signs; dates?: DateOrder; account?: string }>({});
  const [line, setLine] = useState<{ ok: boolean; text: string } | null>(null);
  // A file from a bank Atrium knows keeps its column choices out of the way until asked for.
  const [columns, setColumns] = useState(false);
  const base = `${investPath(spaceId)}/money`;

  const look = async (text: string, next = opts) => {
    setOpts(next);
    const res = await post<Preview>(`${base}/preview`, { csv: text, ...next });
    if (res.ok) {
      setPreview(res.data);
      setLine(null);
    } else setLine({ ok: false, text: res.error });
  };
  const load = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    await look(text, {});
  };
  const save = async () => {
    const res = await post<{ added: number; duplicates: number }>(`${base}/import`, { csv, ...opts });
    if (!res.ok) return setLine({ ok: false, text: res.error });
    const { added, duplicates } = res.data;
    setLine({ ok: true, text: `Added ${added} ${added === 1 ? "entry" : "entries"}. ${duplicates} ${duplicates === 1 ? "was" : "were"} already here.` });
    setPreview(null);
    setCsv("");
  };

  return (
    <section className="money-import">
      <div className="money-import-pick">
        <label className="btn">
          Choose a CSV file
          <input type="file" accept=".csv,text/csv" hidden onChange={(e) => void load(e.target.files?.[0])} />
        </label>
        <span className="faint">TD, Amex and Wealthsimple Cash are recognised. Most other bank and card exports work too.</span>
        <button className="btn link" onClick={onClose}>
          Close
        </button>
      </div>
      {preview && (
        <>
          <p className="money-format">
            {preview.format === "unknown" ? "Columns not found" : preview.bank.id === "generic" ? "Bank or card export" : preview.bank.confidence === "high" ? `${preview.bank.label} export` : `Looks like a ${preview.bank.label} export`} · {preview.total}{" "}
            {preview.total === 1 ? "row" : "rows"}
            {preview.accounts.length ? ` · ${preview.accounts.length === 1 ? "1 account" : `${preview.accounts.length} accounts`}` : ""}
            {preview.skipped.length ? ` · ${preview.skipped.length} skipped` : ""}
          </p>
          {preview.account !== null && (
            <label className="money-account">
              Account
              <select value={preview.account} onChange={(e) => void look(csv, { ...opts, account: e.target.value })}>
                {preview.choices.map((c) => (
                  <option key={c} value={c}>
                    {c === OTHER ? "Another account" : c}
                  </option>
                ))}
              </select>
            </label>
          )}
          {[...preview.guessed, ...preview.warnings].map((w) => (
            <p key={w} className="hint">
              {w}
            </p>
          ))}
          {preview.format !== "wealthsimple" && preview.bank.id !== "generic" && preview.format !== "unknown" && !columns && (
            <button className="btn link money-columns" onClick={() => setColumns(true)}>
              Columns look wrong?
            </button>
          )}
          {preview.format !== "wealthsimple" && (preview.bank.id === "generic" || preview.format === "unknown" || columns) && (
            <div className="money-map">
              {FIELDS.map((f) => (
                <label key={f.id}>
                  {f.label}
                  <select
                    value={preview.mapping[f.id] ?? ""}
                    onChange={(e) => {
                      const mapping = { ...preview.mapping };
                      if (e.target.value === "") delete mapping[f.id];
                      else mapping[f.id] = Number(e.target.value);
                      void look(csv, { ...opts, mapping });
                    }}
                  >
                    <option value="">Not in this file</option>
                    {preview.headers.map((h, i) => (
                      <option key={`${h}-${i}`} value={i}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label>
                Money spent is
                <select value={preview.signs} onChange={(e) => void look(csv, { ...opts, signs: e.target.value as Signs })}>
                  <option value="negative-out">Negative</option>
                  <option value="positive-out">Positive</option>
                </select>
              </label>
              <label>
                Dates read as
                <select value={preview.dates} onChange={(e) => void look(csv, { ...opts, dates: e.target.value as DateOrder })}>
                  <option value="mdy">Month first</option>
                  <option value="dmy">Day first</option>
                </select>
              </label>
            </div>
          )}
          {preview.rows.length > 0 && (
            <table className="money-sample">
              <tbody>
                {preview.rows.slice(0, 8).map((r, i) => (
                  <tr key={i}>
                    <td>{r.date}</td>
                    <td>{r.description}</td>
                    <td className="faint">{r.account}</td>
                    <td className={r.amount < 0 ? "neg" : "pos"}>{amountText(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button className="btn p" disabled={!preview.total} onClick={() => void save()}>
            Import {preview.total} {preview.total === 1 ? "entry" : "entries"}
          </button>
        </>
      )}
      {line && <p className={line.ok ? "ok-line" : "err"}>{line.text}</p>}
    </section>
  );
}
