import type { Database } from "bun:sqlite";
import { meteredFetch, noteSourceResult, type DataSource } from "../budget";
import { etDate } from "../calendar";
import type { Job } from "../jobs";
import { fetchBytes, fetchText } from "../providers/http";
import { ndxEstimate, parseNdxMembers } from "./nasdaq100";
import { parseInvesco } from "./parse-invesco";
import { parseIshares } from "./parse-ishares";
import { parseRoundhill, ROUNDHILL_HEADER, roundhillUrl } from "./parse-roundhill";
import { parseSsga } from "./parse-ssga";
import { FUND_SOURCES, fileFundFor, fundUrl, isFund, NDX_WIKI_URL } from "./sources";
import { loadFundFile, noteFundError, saveFundFile } from "./store";
import { FundFileError, type FundFile } from "./types";

// Issuers get an honest User-Agent, at most one file per fund a day (even by hand) and one a week from the job.
export const USER_AGENT = "Atrium/1.0 (personal portfolio dashboard)";
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const ROUNDHILL_LOOKBACK_DAYS = 6;
const NAMES: Record<string, string> = { ishares: "iShares", ssga: "SSGA", roundhill: "Roundhill", invesco: "Invesco", wikipedia: "Wikipedia" };

// cache: daily files already fetched in this run, by URL (MARS and DRAM share Roundhill's).
type Deps = { fetch?: typeof fetch; now: () => number; cache?: Map<string, string> };

function getter(db: Database, source: DataSource, deps: Deps) {
  const f = meteredFetch(db, source, deps.fetch ?? fetch, deps.now);
  const opts = { fetch: f, name: NAMES[source]!, now: deps.now, headers: { "User-Agent": USER_AGENT } };
  return {
    text: async (url: string) => {
      const hit = deps.cache?.get(url);
      if (hit !== undefined) return hit;
      const t = await fetchText(url, opts);
      deps.cache?.set(url, t);
      return t;
    },
    bytes: (url: string) => fetchBytes(url, opts),
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function fetchFile(db: Database, fund: string, deps: Deps): Promise<{ file: FundFile; source: DataSource }> {
  const src = FUND_SOURCES[fund];
  if (!src) throw new FundFileError(`Atrium has no holdings source for ${fund}.`);
  switch (src.kind) {
    case "ishares-ca":
    case "ishares-us":
      return { file: parseIshares(await getter(db, "ishares", deps).text(fundUrl(src)!), fund, src.kind), source: "ishares" };
    case "ssga":
      return { file: parseSsga(await getter(db, "ssga", deps).bytes(fundUrl(src)!), fund), source: "ssga" };
    case "roundhill": {
      const get = getter(db, "roundhill", deps);
      for (let i = 0; i <= ROUNDHILL_LOOKBACK_DAYS; i++) {
        const text = await get.text(roundhillUrl(etDate(deps.now() - i * DAY_MS)));
        if (text.startsWith(ROUNDHILL_HEADER)) return { file: parseRoundhill(text, fund), source: "roundhill" };
      }
      throw new FundFileError("Roundhill hasn't published a holdings file in the last week that Atrium could find.");
    }
    case "qqq": {
      try {
        return { file: parseInvesco(await getter(db, "invesco", deps).text(fundUrl(src)!)), source: "invesco" };
      } catch (e) {
        noteSourceResult(db, "invesco", false, message(e), deps.now());
      }
      const spy = loadFundFile(db, "SPY") ?? (await refreshFund(db, "SPY", deps));
      const members = parseNdxMembers(await getter(db, "wikipedia", deps).text(NDX_WIKI_URL));
      return { file: ndxEstimate(members, spy), source: "wikipedia" };
    }
    case "alias":
      throw new FundFileError(`${fund} is shown through ${src.of}.`);
  }
}

// Fetch, parse and save one fund's file. On failure the old file stays in use and the error is recorded with it.
export async function refreshFund(db: Database, fund: string, deps: Deps): Promise<FundFile> {
  const target = fileFundFor(fund);
  if (target !== fund) return refreshFund(db, target, deps);
  const now = deps.now();
  const cur = loadFundFile(db, fund);
  if (cur && now - cur.fetchedAt < DAY_MS) throw new FundFileError(`Holdings for ${fund} were already refreshed today.`);
  try {
    const { file, source } = await fetchFile(db, fund, deps);
    saveFundFile(db, file, now);
    noteSourceResult(db, source, true, undefined, now);
    return file;
  } catch (e) {
    const text = message(e);
    noteFundError(db, fund, text, now);
    const src = FUND_SOURCES[fund];
    const source: DataSource | null = src?.kind === "ishares-ca" || src?.kind === "ishares-us" ? "ishares" : src?.kind === "ssga" || src?.kind === "roundhill" ? src.kind : null;
    if (source) noteSourceResult(db, source, false, text, now);
    throw e instanceof FundFileError ? e : new FundFileError(text);
  }
}

// Funds held or watched in an active markets space, through their file fund (VFV.TO → SPY).
function trackedFunds(db: Database): string[] {
  const active = "SELECT id FROM spaces WHERE kind = 'markets' AND status = 'active'";
  const rows = db
    .query(
      `SELECT symbol, exchange FROM market_holdings WHERE space_id IN (${active})
       UNION SELECT symbol, exchange FROM market_watchlist WHERE space_id IN (${active})`,
    )
    .all() as { symbol: string; exchange: string }[];
  const keys = rows.map((r) => (r.exchange === "US" ? r.symbol : r.exchange === "TSX" ? `${r.symbol}.TO` : r.exchange === "TSXV" ? `${r.symbol}.V` : ""));
  return [...new Set(keys.filter(isFund).map(fileFundFor))];
}

export function fundsJob(db: Database, deps: { fetch?: typeof fetch; now: () => number }): Job {
  return {
    name: "funds",
    slot: { at: "10:00", days: [6] },
    async run(now) {
      const cache = new Map<string, string>();
      const queue = trackedFunds(db);
      const failed: string[] = [];
      for (let i = 0; i < queue.length; i++) {
        const fund = queue[i]!;
        const cur = loadFundFile(db, fund);
        let file: FundFile | null = cur && now - cur.fetchedAt < WEEK_MS ? cur : null;
        if (!file) {
          try {
            file = await refreshFund(db, fund, { ...deps, cache });
          } catch {
            failed.push(fund);
            file = cur;
          }
        }
        // Sleeves with a source of their own are refreshed too, so look-through can go down into them.
        for (const l of file?.lines ?? []) if (l.kind === "fund" && l.key && isFund(l.key) && !queue.includes(fileFundFor(l.key))) queue.push(fileFundFor(l.key));
      }
      if (failed.length) throw new FundFileError(`Couldn't refresh holdings for ${failed.join(", ")}; the last good files stay in use.`);
    },
  };
}
