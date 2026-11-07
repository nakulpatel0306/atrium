// Plan 14 re-review repros (W1–W3 in .superpowers/plan-14-review.md). Each failed on 47e3a28; all pass now.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const W = join(import.meta.dir, "../../..");
const { openDb } = await import(`${W}/src/engine/db`);
const { createSpace } = await import(`${W}/src/engine/spaces`);
const { importMoney, isMasked, maskNumbers, previewMoney } = await import(`${W}/src/engine/money/import`);
const { requestMoneyAsk } = await import(`${W}/src/engine/money/summary`);
const { createRunner } = await import(`${W}/src/engine/runner`);
const { createMarketsHooks } = await import(`${W}/src/engine/markets/agent`);
const { createMarketData } = await import(`${W}/src/engine/markets/data`);
const { demoProvider } = await import(`${W}/src/engine/markets/providers/demo`);
const { setSetting } = await import(`${W}/src/engine/settings`);
const { getTask } = await import(`${W}/src/engine/tasks`);
const { config } = await import(`${W}/src/engine/config`);
const { tempHome } = await import(`${W}/tests/helpers`);

const NOW = Date.parse("2026-11-05T15:00:00Z");
let home: { home: string; cleanup(): void };
let db: Database;
let runner: any = null;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(async () => {
  await runner?.stop();
  runner = null;
  db.close();
  home.cleanup();
});
const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 300 && !fn(); i++) await Bun.sleep(10);
};
function start(impl: (input: any) => any) {
  const calls: any[] = [];
  const adapter = { id: "claude", label: "Claude Code", async run(input: any) { calls.push(input); return impl(input); } };
  setSetting(db, "markets.provider", "demo");
  const noKeys = { get: async () => null, set: async () => {}, remove: async () => {} };
  const data = createMarketData({ db, keychain: noKeys, now: () => NOW, providers: { demo: demoProvider({ now: () => NOW }) } });
  runner = createRunner({ db, adapters: { claude: adapter }, power: async () => "ac", keepAwake: { start() {}, stop() {}, active: () => false }, markets: createMarketsHooks(db, { data, now: () => NOW }) });
  runner.start();
  return calls;
}
const ok = (summary: string) => ({ status: "ok", summary, inputTokens: 1, outputTokens: 1 });

// W1: "Oct 30, 2026" in the facts is a 6-digit cluster that is neither a date nor an amount, so the guard refuses.
test("W1 an ordinary money question over the four fixture files reaches Claude", async () => {
  const space = createSpace(db, { name: "Investing", kind: "markets", goal: "g" });
  for (const f of ["td-chequing.csv", "td-credit.csv", "amex.csv", "ws-cash.csv"]) importMoney(db, space.id, previewMoney(readFileSync(join(W, "tests/fixtures/money", f), "utf8")));
  const calls = start(() => ok("Rent was the biggest part.\n\nAnalysis, not advice."));
  const task = requestMoneyAsk(db, space.id, "Where did my money go last month?");
  await waitFor(() => ["done", "failed", "blocked"].includes(getTask(db, task.id)!.status));
  expect({ status: getTask(db, task.id)!.status, calls: calls.length }).toEqual({ status: "done", calls: 1 });
});

// W2: the re-mask rewrites rows, but the raw text stays in the WAL file on disk.
test("W2 after the re-mask runs, the raw old description is not left in the database files", () => {
  const s = createSpace(db, { name: "I", kind: "markets", goal: "g" }).id;
  const ins = db.query("INSERT INTO money_transactions (id, space_id, source, account, date, description, merchant, amount, currency, kind, symbol, fingerprint, imported_at) VALUES (?, ?, 'bank', 'Imported', '2026-09-02', ?, 'Payment', -5, 'CAD', 'spend', NULL, ?, 1)");
  for (let i = 0; i < 50; i++) ins.run(`mtx_${i}`, s, `PAYMENT 4111.1111.1111.${1000 + i}`, `fp_${i}`);
  db.close();
  db = openDb();
  expect((db.query("SELECT description FROM money_transactions").all() as { description: string }[]).every((r) => isMasked(r.description))).toBe(true);
  db.close();
  const raw = readdirSync(home.home).filter((f) => f.includes(".db")).map((f) => readFileSync(join(home.home, f)).toString("latin1")).join("");
  db = openDb();
  expect(raw.includes("4111.1111.1111")).toBe(false);
});

// W3: masking per chunk lets a number Claude writes across several text blocks through whole.
test("W3 a number spread over four assistant text blocks is not left whole in the transcript", async () => {
  const space = createSpace(db, { name: "Investing", kind: "markets", goal: "g" });
  importMoney(db, space.id, previewMoney("Date,Description,Amount\n2026-10-02,LOBLAWS,-20.00", { account: "Amex" }));
  start((input) => {
    for (const part of ["Card 4111", "1111", "1111", "1111"]) input.onChunk(part);
    return ok("Done.\n\nAnalysis, not advice.");
  });
  const task = requestMoneyAsk(db, space.id, "Where did it go?");
  await waitFor(() => ["done", "failed", "blocked"].includes(getTask(db, task.id)!.status));
  const { transcriptsDir } = config();
  const logs = readdirSync(transcriptsDir).map((f) => readFileSync(join(transcriptsDir, f), "utf8")).join("\n");
  expect(logs.replace(/\D/g, "")).not.toContain("4111111111111111");
});

// The facts line that tripped W1: "Mon DD, YYYY" is now one date.
test("control: a month-name date with its year is kept", () => {
  expect(maskNumbers("from Aug 1, 2026 to Oct 30, 2026")).toBe("from Aug 1, 2026 to Oct 30, 2026");
});
