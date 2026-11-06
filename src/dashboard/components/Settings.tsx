import { KeyRound, PlugZap, Radio } from "lucide-react";
import { useState } from "react";
import type { DataStatus } from "../../engine/markets/data";
import type { Quote } from "../../engine/markets/providers/types";
import { del, post, put } from "../api";
import { absolute, money } from "../format";
import { useMarketDataSettings } from "../markets";
import { DataBudget } from "./DataBudget";
import { Freshness } from "./markets/Freshness";
import { MessagingSettings } from "./MessagingSettings";
import { Storage } from "./Storage";

const PROVIDERS: { id: DataStatus["usProvider"]; label: string; covers: string }[] = [
  { id: "finnhub", label: "Finnhub", covers: "US stocks and ETFs. Real-time quotes, symbol search, earnings dates and the news Claude reads. Atrium keeps its own daily closes from these prices." },
  { id: "demo", label: "Demo", covers: "Made-up prices for every market, to try Atrium out. Every price is labelled Demo data." },
];

// Once a key is saved there's nothing left to add.
export const tsxSourceHint = (hasAlphaVantage: boolean): string =>
  `TSX prices during the day come from Yahoo Finance's public feed (no key, unofficial). ${hasAlphaVantage ? "Alpha Vantage supplies the official closing prices." : "Add a free Alpha Vantage key for official closing prices."}`;

type KeyProvider = "finnhub" | "alphavantage" | "tiingo";
const KEY_FORMS: { id: KeyProvider; label: string; need: string; fields: { name: string; label: string }[]; help: string }[] = [
  {
    id: "finnhub",
    label: "Finnhub",
    need: "Required",
    fields: [{ name: "token", label: "Token" }],
    help: "The one key Atrium needs: live US prices, search, earnings dates and news. Sign up free at finnhub.io and copy the API token from your dashboard.",
  },
  {
    id: "alphavantage",
    label: "Alpha Vantage",
    need: "Optional · Canadian prices",
    fields: [{ name: "key", label: "Key" }],
    help: "Adds the official end-of-day close for your TSX and TSX-V holdings, and their charts. The free key allows 25 requests a day, so Canadian closes refresh once after the close.",
  },
  {
    id: "tiingo",
    label: "Tiingo",
    need: "Not needed",
    fields: [{ name: "token", label: "Token" }],
    help: "Atrium keeps its own daily closes from Finnhub prices, so this isn't needed. A free Tiingo key adds years of adjusted history and dividends for the Advanced tools.",
  },
];

function KeyForm({ form, saved }: { form: (typeof KEY_FORMS)[number]; saved: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const res = await post<{ message: string }>("/api/settings/market-data/keys", { provider: form.id, ...values });
    setBusy(false);
    // Keys are never read back; the inputs clear either way so nothing lingers on screen.
    setValues({});
    setMsg(res.ok ? { ok: true, text: res.data.message } : { ok: false, text: res.error });
  };
  const remove = async () => {
    const res = await del<{ message: string }>(`/api/settings/market-data/keys/${form.id}`);
    setMsg(res.ok ? { ok: true, text: res.data.message } : { ok: false, text: res.error });
  };
  return (
    <div className="set-card">
      <div className="set-title">
        <KeyRound />
        <b>{form.label}</b>
        <span className="tag">{form.need}</span>
        <span className={`tag${saved ? " ok" : ""}`}>{saved ? "Saved in your Mac's Keychain" : "Not set"}</span>
      </div>
      <p className="hint">{form.help}</p>
      <form
        className="mk-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {form.fields.map((f) => (
          <label key={f.name}>
            {f.label}
            <input
              className="mk-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          </label>
        ))}
        <button className="btn p" type="submit" disabled={busy || form.fields.some((f) => !values[f.name]?.trim())}>
          {busy ? "Checking…" : "Save"}
        </button>
        {saved && (
          <button className="btn" type="button" onClick={() => void remove()}>
            Remove
          </button>
        )}
        {msg && <span className={msg.ok ? "ok-line" : "err"}>{msg.text}</span>}
      </form>
    </div>
  );
}

// Alpaca is off the default path. A key saved earlier can still be removed; nothing new can be added.
function AlpacaRemoval() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const remove = async () => {
    const res = await del<{ message: string }>("/api/settings/market-data/keys/alpaca");
    setMsg(res.ok ? { ok: true, text: res.data.message } : { ok: false, text: res.error });
  };
  return (
    <div className="set-card">
      <div className="set-title">
        <KeyRound />
        <b>Alpaca</b>
        <span className="tag">Not used anymore</span>
      </div>
      <p className="hint">Atrium gets US prices from Finnhub now. You can remove the old Alpaca key from your Keychain.</p>
      <div className="mk-form">
        <button className="btn" type="button" onClick={() => void remove()}>
          Remove
        </button>
        {msg && <span className={msg.ok ? "ok-line" : "err"}>{msg.text}</span>}
      </div>
    </div>
  );
}

type Probe = { ok: boolean; message: string; sample?: { key: string; price: number; at: number; freshness: Quote["freshness"]; source: Quote["source"] } };

export function Settings() {
  const s = useMarketDataSettings();
  const [test, setTest] = useState<{ us: Probe; ca: Probe; history: Probe } | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (provider: DataStatus["usProvider"]) => {
    const res = await put("/api/settings/market-data", { provider });
    setError(res.ok ? null : res.error);
    setTest(null);
  };
  const runTest = async () => {
    setTesting(true);
    const res = await post<{ us: Probe; ca: Probe; history: Probe }>("/api/settings/market-data/test");
    setTesting(false);
    if (res.ok) setTest(res.data);
    else setError(res.error);
  };

  return (
    <div className="wrap">
      <h1>Settings</h1>
      <p className="brief">How Atrium gets market prices for your investing spaces. Keys stay in your Mac's Keychain; agents only ever see prices.</p>
      <h2>Market data</h2>
      {!s ? (
        <div className="list">
          <div className="empty-row">Loading…</div>
        </div>
      ) : (
        <>
          <div className="list">
            {PROVIDERS.map((p) => (
              <label key={p.id} className="item set-radio">
                <input type="radio" name="provider" checked={s.data.usProvider === p.id} onChange={() => void choose(p.id)} />
                <span className="t">
                  <b>{p.label}</b>
                  <span>{p.covers}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="set-status">
            <span>
              <b>US</b> {s.data.us.message}
            </span>
            <span>
              <b>Canada</b> {s.data.ca.message}
            </span>
            <span>
              <b>History</b> {s.data.history.message}
            </span>
            <span className={`feedline ${s.feed.mode}`}>
              <Radio />
              {s.feed.reason}
            </span>
          </div>
          <p className="hint">{tsxSourceHint(s.data.keys.alphavantage)}</p>
          <div className="mk-form">
            <button className="btn" onClick={() => void runTest()} disabled={testing}>
              <PlugZap />
              {testing ? "Testing…" : "Test connection"}
            </button>
            {error && <span className="err">{error}</span>}
          </div>
          {test && (
            <div className="list">
              {(["us", "ca", "history"] as const).map((k) => (
                <div key={k} className="item">
                  <span className="who">{k === "us" ? "US (AAPL)" : k === "ca" ? "Canada (SHOP.TO)" : "History (SPY)"}</span>
                  <span className="t">{test[k].message}</span>
                  {test[k].sample && (
                    <>
                      <span className="num">{money(test[k].sample!.price, k === "us" ? "USD" : "CAD")}</span>
                      <Freshness quote={{ key: test[k].sample!.key, price: test[k].sample!.price, prevClose: null, at: test[k].sample!.at, source: test[k].sample!.source, freshness: test[k].sample!.freshness }} missing={null} />
                      <span className="faint" title={absolute(test[k].sample!.at)}>
                        {absolute(test[k].sample!.at)}
                      </span>
                    </>
                  )}
                  {!test[k].ok && <span className="tag bad">not working</span>}
                </div>
              ))}
            </div>
          )}
          <h2>Keys</h2>
          {KEY_FORMS.map((f) => (
            <KeyForm key={f.id} form={f} saved={s.data.keys[f.id]} />
          ))}
          {s.data.keys.alpaca && <AlpacaRemoval />}
          {s.advanced && (
            <>
              <h2>Data budget</h2>
              <p className="brief">Every call Atrium makes, against each free plan's limit. Free tiers only; nothing here costs money.</p>
              <DataBudget />
            </>
          )}
        </>
      )}
      <MessagingSettings />
      <Storage />
    </div>
  );
}
