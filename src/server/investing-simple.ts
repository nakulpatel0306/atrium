import type { Database } from "bun:sqlite";
import { getSpace } from "../engine/spaces";
import { isAdvanced, setAdvanced } from "../engine/markets/advanced";
import { instrumentKey, parseInstrumentKey } from "../engine/markets/instrument";
import { addToList, createList, deleteList, getList, removeFromList, renameList } from "../engine/markets/lists";
import { redact } from "../engine/markets/redact";
import { searchSymbols } from "../engine/markets/search";
import { refreshSymbol, symbolView } from "../engine/markets/symbol";
import { earningsView, glanceView, listsView, portfolioView } from "../engine/markets/views";
import { HttpError, json, readBody } from "./http";
import type { MarketsDeps } from "./markets";

const BAD_SYMBOL = "Type a symbol like AAPL or SHOP.TO.";
const keyOf = (raw: string): string => {
  const i = parseInstrumentKey(decodeURIComponent(raw).trim().toUpperCase());
  if (!i) throw new HttpError(400, BAD_SYMBOL);
  return instrumentKey(i);
};

// Engine validation throws plain sentences written for Nakul; here they become 400s.
function check<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
}

// The simple investing views. Handles only the /api/investing/:space/… paths it owns and returns null for the rest,
// so Plan 7's routes in investing.ts keep theirs. Every GET reads SQLite only.
const OWNED = /^\/api\/investing\/([^/]+)(\/(?:advanced|portfolio|lists(?:\/.*)?|earnings|glance|symbol\/.*))$/;

export async function simpleRoute(db: Database, m: MarketsDeps, req: Request, url: URL): Promise<Response | null> {
  const search = req.method === "POST" && url.pathname === "/api/investing/search";
  const owned = url.pathname.match(OWNED);
  if (!search && !owned) return null;
  try {
    if (search) {
      const b = await readBody(req);
      await m.data.refreshKeys();
      // searchSymbols turns provider failures into a note; what it throws is a validation sentence.
      const result = await searchSymbols(m.data.research?.() ?? null, typeof b.q === "string" ? b.q : "", m.now).catch((e: Error) => {
        throw new HttpError(400, e.message);
      });
      return json(result);
    }
    return await route(db, m, req, decodeURIComponent(owned![1]!), owned![2]!);
  } catch (e) {
    if (e instanceof HttpError) throw new HttpError(e.status, redact(e.message, m.data.secrets()));
    console.error(`Investing error: ${redact(e instanceof Error ? (e.stack ?? e.message) : String(e), m.data.secrets())}`);
    throw new HttpError(500, "Something went wrong in Atrium's investing code. Check the engine log.");
  }
}

async function route(db: Database, m: MarketsDeps, req: Request, spaceId: string, rest: string): Promise<Response | null> {
  const space = getSpace(db, spaceId);
  if (!space || space.kind !== "markets") throw new HttpError(404, "No such markets space.");
  const now = (m.now ?? Date.now)();
  const sub = (verb: string, pattern: RegExp) => (req.method === verb ? rest.match(pattern) : null);
  const listIn = (raw: string) => {
    const list = getList(db, decodeURIComponent(raw));
    if (!list || list.spaceId !== spaceId) throw new HttpError(404, "No such list in this space.");
    return list;
  };

  if (sub("PUT", /^\/advanced$/)) {
    const b = await readBody(req);
    if (typeof b.on !== "boolean") throw new HttpError(400, "on must be true or false.");
    setAdvanced(db, spaceId, b.on);
    await m.feed.reevaluate();
    return json({ advanced: isAdvanced(db, spaceId) });
  }
  const symbol = sub("GET", /^\/symbol\/([^/]+)$/);
  if (symbol) return json(symbolView(db, m.data, spaceId, keyOf(symbol[1]!), now));
  const refresh = sub("POST", /^\/symbol\/([^/]+)\/refresh$/);
  if (refresh) {
    const key = keyOf(refresh[1]!);
    await m.data.refreshKeys();
    return json(await refreshSymbol(db, m.data, key, now));
  }
  if (sub("GET", /^\/portfolio$/)) return json(portfolioView(db, m.data, spaceId, now));
  if (sub("GET", /^\/lists$/)) return json(listsView(db, m.data, spaceId, now));
  if (sub("GET", /^\/earnings$/)) return json(earningsView(db, spaceId, now));
  if (sub("GET", /^\/glance$/)) return json(glanceView(db, m.data, spaceId, now));
  if (sub("POST", /^\/lists$/)) {
    const b = await readBody(req);
    return json(check(() => createList(db, spaceId, typeof b.name === "string" ? b.name : "")));
  }
  const rename = sub("PATCH", /^\/lists\/([^/]+)$/);
  if (rename) {
    const list = listIn(rename[1]!);
    const b = await readBody(req);
    return json(check(() => renameList(db, list.id, typeof b.name === "string" ? b.name : "")));
  }
  const drop = sub("DELETE", /^\/lists\/([^/]+)$/);
  if (drop) {
    const list = listIn(drop[1]!);
    check(() => deleteList(db, list.id));
    return json({ ok: true });
  }
  const add = sub("POST", /^\/lists\/([^/]+)\/items$/);
  if (add) {
    const list = listIn(add[1]!);
    const b = await readBody(req);
    const i = typeof b.key === "string" ? parseInstrumentKey(b.key) : null;
    if (!i) throw new HttpError(400, BAD_SYMBOL);
    return json(addToList(db, list.id, i, typeof b.name === "string" ? b.name.slice(0, 120) : ""));
  }
  const remove = sub("DELETE", /^\/lists\/([^/]+)\/items\/([^/]+)$/);
  if (remove) {
    const list = listIn(remove[1]!);
    removeFromList(db, list.id, decodeURIComponent(remove[2]!));
    return json({ ok: true });
  }
  return null;
}
