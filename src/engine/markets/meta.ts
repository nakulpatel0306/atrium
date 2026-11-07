import type { Database } from "bun:sqlite";
import { anyAdvanced } from "./advanced";
import { backedOff, backOff } from "./backoff";
import type { MarketData } from "./data";
import { refreshEdgar } from "./edgar";
import { trackedInstruments } from "./feed";
import { fileSource } from "./funds/lookthrough";
import { isFund } from "./funds/sources";
import type { FundFile } from "./funds/types";
import { instrumentKey, parseInstrumentKey } from "./instrument";
import type { Job } from "./jobs";
import { ProviderError, type Metrics, type Profile } from "./providers/types";
import { redact } from "./redact";

export type Meta = {
  key: string;
  name: string | null;
  kind: "stock" | "etf" | "unknown";
  sector: string | null;
  sectorSource: string | null;
  country: string | null;
  currency: string | null;
  pe: number | null;
  high52: number | null;
  low52: number | null;
  divYield: number | null;
  metricsAt: number | null;
  listing: string | null;
  marketCap: number | null;
};

const DAY_MS = 86_400_000;
const PROFILE_MAX_AGE = 30 * DAY_MS;
const METRICS_MAX_AGE = 7 * DAY_MS;
export const FINNHUB_INDUSTRY = "Finnhub industry";

type Row = {
  key: string;
  name: string | null;
  kind: Meta["kind"];
  sector: string | null;
  sector_source: string | null;
  country: string | null;
  currency: string | null;
  pe: number | null;
  high52: number | null;
  low52: number | null;
  div_yield: number | null;
  metrics_at: number | null;
  profile_at: number | null;
  listing: string | null;
  market_cap: number | null;
};

export function getMeta(db: Database, keys: string[]): Map<string, Meta> {
  const out = new Map<string, Meta>();
  if (!keys.length) return out;
  const rows = db.query(`SELECT * FROM instrument_meta WHERE key IN (${keys.map(() => "?").join(",")})`).all(...keys) as Row[];
  for (const r of rows) {
    out.set(r.key, {
      key: r.key,
      name: r.name,
      kind: r.kind,
      sector: r.sector,
      sectorSource: r.sector_source,
      country: r.country,
      currency: r.currency,
      pe: r.pe,
      high52: r.high52,
      low52: r.low52,
      divYield: r.div_yield,
      metricsAt: r.metrics_at,
      listing: r.listing,
      marketCap: r.market_cap,
    });
  }
  return out;
}

const ensure = (db: Database, key: string) => db.query("INSERT OR IGNORE INTO instrument_meta (key) VALUES (?)").run(key);
const trackedKeys = (db: Database) => trackedInstruments(db).map(instrumentKey);

// Issuer files know each company's sector, country and currency; iShares files are preferred over SSGA's.
const RANK: Record<string, number> = { "ishares-ca": 0, "ishares-us": 0, ssga: 1, roundhill: 2, invesco: 2, "ndx-estimate": 3 };

export function metaFromFunds(db: Database): number {
  let n = 0;
  const find = db.query(
    `SELECT l.sector, l.country, l.currency, f.fund, f.source, f.as_of FROM fund_lines l JOIN fund_files f ON f.fund = l.fund
     WHERE l.key = ? AND l.kind = 'stock'`,
  );
  const put = db.query("UPDATE instrument_meta SET sector = ?, sector_source = ?, country = COALESCE(?, country), currency = COALESCE(?, currency) WHERE key = ?");
  const place = db.query("UPDATE instrument_meta SET country = COALESCE(country, ?), currency = COALESCE(currency, ?) WHERE key = ?");
  db.transaction(() => {
    for (const key of trackedKeys(db)) {
      const rows = (find.all(key) as { sector: string | null; country: string | null; currency: string | null; fund: string; source: FundFile["source"]; as_of: string }[]).sort(
        (a, b) => (RANK[a.source] ?? 9) - (RANK[b.source] ?? 9),
      );
      if (!rows.length) continue;
      ensure(db, key);
      const withSector = rows.find((r) => r.sector);
      if (withSector) {
        const label = fileSource({ fund: withSector.fund, source: withSector.source, asOf: withSector.as_of, lines: [], note: null }).source;
        put.run(withSector.sector, label, withSector.country, withSector.currency, key);
      } else place.run(rows[0]!.country, rows[0]!.currency, key);
      n++;
    }
  })();
  return n;
}

const ages = (db: Database, key: string) =>
  (db.query("SELECT profile_at, metrics_at FROM instrument_meta WHERE key = ?").get(key) as { profile_at: number | null; metrics_at: number | null } | null) ?? {
    profile_at: null,
    metrics_at: null,
  };
const usStock = (key: string) => parseInstrumentKey(key)?.exchange === "US" && !isFund(key);

// A tracked key with no metadata row, or a US stock whose Finnhub profile or figures are missing or past their age.
export function metaStale(db: Database, now: number): boolean {
  const out = backedOff(db, "meta", now);
  return trackedKeys(db).some((key) => {
    const row = db.query("SELECT kind FROM instrument_meta WHERE key = ?").get(key) as { kind: string | null } | null;
    if (!row) return true;
    if (!usStock(key) || out.has(key)) return false;
    const a = ages(db, key);
    return now - (a.profile_at ?? 0) > PROFILE_MAX_AGE || now - (a.metrics_at ?? 0) > METRICS_MAX_AGE;
  });
}

export function saveProfile(db: Database, key: string, pr: Profile | null, now: number): void {
  const m = getMeta(db, [key]).get(key);
  const useIndustry = !!pr?.industry && (!m?.sector || m.sectorSource === FINNHUB_INDUSTRY);
  db.query(
    `UPDATE instrument_meta SET name = COALESCE(?, name), listing = COALESCE(?, listing), country = COALESCE(country, ?), currency = COALESCE(currency, ?), profile_at = ?,
       sector = CASE WHEN ? THEN ? ELSE sector END, sector_source = CASE WHEN ? THEN ? ELSE sector_source END WHERE key = ?`,
  ).run(pr?.name || null, pr?.exchange ?? null, pr?.country ?? null, pr?.currency ?? null, now, useIndustry ? 1 : 0, pr?.industry ?? null, useIndustry ? 1 : 0, FINNHUB_INDUSTRY, key);
}

export function saveMetrics(db: Database, key: string, mt: Metrics, now: number): void {
  db.query("UPDATE instrument_meta SET pe = ?, high52 = ?, low52 = ?, div_yield = ?, market_cap = ?, metrics_at = ? WHERE key = ?").run(mt.pe, mt.high52, mt.low52, mt.divYield, mt.marketCap ?? null, now, key);
}

// Weekly: sectors from fund files, then Finnhub profiles (monthly) and metrics (weekly) for US stocks. Catch-up runs
// it too when a key is added or something is missing. Without a Finnhub key that part is reported as skipped.
export function metaJob(db: Database, deps: { data: MarketData; now: () => number; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Job {
  return {
    name: "meta",
    slot: { at: "10:00", days: [6] },
    async run(now) {
      const keys = trackedKeys(db);
      for (const key of keys) {
        ensure(db, key);
        db.query("UPDATE instrument_meta SET kind = ? WHERE key = ?").run(isFund(key) ? "etf" : "stock", key);
      }
      metaFromFunds(db);
      try {
        if (anyAdvanced(db)) await refreshEdgar(db, deps);
      } catch (e) {
        console.error(`SEC EDGAR cross-check: ${e instanceof Error ? e.message : String(e)}`);
      }
      const stocks = keys.filter(usStock);
      if (!stocks.length) return;
      await deps.data.prepare?.();
      const p = deps.data.research?.();
      if (!p) return { skipped: [{ step: "finnhub", reason: "Company profiles and key stats weren't fetched: add your Finnhub key in Settings → Market data." }] };
      const out = backedOff(db, "meta", now);
      const failed: { key: string; why: string }[] = [];
      for (const key of stocks.filter((k) => !out.has(k))) {
        const i = parseInstrumentKey(key)!;
        const a = ages(db, key);
        try {
          if (p.profile && now - (a.profile_at ?? 0) > PROFILE_MAX_AGE) saveProfile(db, key, await p.profile(i), now);
          if (p.metric && now - (a.metrics_at ?? 0) > METRICS_MAX_AGE) saveMetrics(db, key, await p.metric(i), now);
        } catch (e) {
          const why = redact(e instanceof Error ? e.message : String(e), deps.data.secrets?.() ?? []);
          // Catch-up's staleness check brings these back, so they wait rather than rerun as failed steps.
          if (e instanceof ProviderError && (e.kind === "auth" || e.kind === "rate_limited")) {
            return { skipped: [{ step: "finnhub", reason: `Company profiles and key stats stopped at ${key}: ${why}`, status: "waiting" as const }] };
          }
          // One symbol's own failure sits out its back-off; the rest carry on.
          failed.push({ key, why });
        }
      }
      if (failed.length) {
        backOff(db, "meta", failed.map((f) => f.key), now);
        return { skipped: [{ step: "finnhub", reason: `Key stats for ${failed.map((f) => f.key).join(", ")} failed: ${failed[0]!.why}`, status: "waiting" as const }] };
      }
    },
  };
}
