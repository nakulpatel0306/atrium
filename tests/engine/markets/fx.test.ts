import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { dataBudget } from "../../../src/engine/markets/budget";
import { fetchUsdCad, fxJob, fxOn, fxSeries, latestFx, saveFx } from "../../../src/engine/markets/fx";
import { tempHome } from "../../helpers";
import { fixture, jsonResponse, stubFetch } from "./fakes";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const NOW = Date.parse("2026-11-04T22:05:00Z"); // Wed 17:05 ET
const boc = (name: string) => () => jsonResponse(fixture(`investing/${name}`));

test("parses the recent observations", async () => {
  const s = stubFetch(boc("boc-recent.json"));
  const rows = await fetchUsdCad({ fetch: s.fetch, now: () => NOW });
  expect(rows).toHaveLength(5);
  expect(rows.at(-1)).toEqual({ date: "2026-11-04", rate: 1.3961 });
  expect(s.calls[0]!.url.searchParams.get("recent")).toBe("5");
});

test("holidays without a rate are skipped", async () => {
  const body = { observations: [{ d: "2026-11-10", FXUSDCAD: { v: "1.40" } }, { d: "2026-11-11", FXUSDCAD: {} }, { d: "2026-11-12" }] };
  const rows = await fetchUsdCad({ fetch: stubFetch(() => jsonResponse(body)).fetch, now: () => NOW });
  expect(rows).toEqual([{ date: "2026-11-10", rate: 1.4 }]);
});

test("latestFx, fxOn and fxSeries read the table", () => {
  saveFx(db, [
    { date: "2026-11-04", rate: 1.3961 },
    { date: "2026-11-05", rate: 1.401 },
    { date: "2026-11-06", rate: 1.4033 },
  ]);
  const fx = latestFx(db)!;
  expect(fx.value).toBe(1.4033);
  expect(fx.source).toBe("Bank of Canada · Nov 6");
  expect(fx.tone).toBe("official");
  expect(fx.asOf).toBe(Date.parse("2026-11-06T21:30:00Z"));
  expect(fxOn(db, "2026-11-08")).toBe(1.4033);
  expect(fxOn(db, "2026-11-04")).toBe(1.3961);
  expect(fxOn(db, "2026-11-14")).toBeNull();
  expect(fxOn(db, "2026-11-01")).toBeNull();
  expect(fxSeries(db, "2026-11-05").map((r) => r.date)).toEqual(["2026-11-05", "2026-11-06"]);
  saveFx(db, [{ date: "2026-11-04", rate: 1.3966 }]);
  expect(fxOn(db, "2026-11-04")).toBe(1.3966);
});

test("latestFx is null with no rates", () => {
  expect(latestFx(db)).toBeNull();
});

test("the fx job backfills once, then asks for the recent days", async () => {
  const s = stubFetch((url) => jsonResponse(fixture(url.searchParams.has("start_date") ? "investing/boc-history.json" : "investing/boc-recent.json")));
  const job = fxJob(db, { fetch: s.fetch, now: () => NOW });
  expect(job.name).toBe("fx");
  expect(job.slot).toEqual({ at: "17:00", days: "weekdays" });
  await job.run(NOW);
  expect(s.calls[0]!.url.searchParams.get("start_date")).toBe("2025-09-30");
  expect(fxSeries(db, "2000-01-01").length).toBeGreaterThan(250);
  await job.run(NOW + 86_400_000);
  expect(s.calls[1]!.url.searchParams.get("recent")).toBe("5");
  for (const c of s.calls) expect(c.url.host).toBe("www.bankofcanada.ca");
  const row = dataBudget(db, NOW).find((r) => r.source === "boc")!;
  expect(row.callsToday).toBe(2); // the job clock stayed on NOW for both runs
  expect(row.lastOkAt).not.toBeNull();
});

test("a malformed reply leaves the table alone", async () => {
  saveFx(db, [{ date: "2026-11-03", rate: 1.3994 }]);
  const job = fxJob(db, { fetch: stubFetch(() => jsonResponse({})).fetch, now: () => NOW });
  await expect(job.run(NOW)).rejects.toThrow("Bank of Canada sent a reply Atrium couldn't read; it will try again.");
  expect(fxSeries(db, "2000-01-01")).toEqual([{ date: "2026-11-03", rate: 1.3994 }]);
  expect(dataBudget(db, NOW).find((r) => r.source === "boc")!.lastError).toBe("Bank of Canada sent a reply Atrium couldn't read; it will try again.");
});

test("a reply bigger than the cap is cut off while it streams, not after", async () => {
  const { fetchBytes } = await import("../../../src/engine/markets/providers/http");
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls++;
      if (pulls > 1000) return c.close();
      c.enqueue(new Uint8Array(1024));
    },
  });
  const f = (async () => new Response(body)) as unknown as typeof fetch;
  await expect(fetchBytes("https://www.ssga.com/x.xlsx", { fetch: f, name: "SSGA", now: () => NOW, maxBytes: 4096 })).rejects.toThrow("SSGA sent a reply Atrium couldn't read; it will try again.");
  expect(pulls).toBeLessThan(10);
});
