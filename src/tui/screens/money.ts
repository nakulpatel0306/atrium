// Money: the month, its totals, categories against their budgets, subscriptions, TFSA room and Claude's latest
// answer. Only what the money route returns is shown; it is already masked, and no transaction row is drawn here.
import { relative } from "../../dashboard/format";
import type { MoneySummary } from "../../engine/money/summary";
import { bar, type Block, columns, fit, type Hit, label, type Line, rowsOf } from "../canvas";
import { markdownLines } from "../markdown";
import { truncate, width } from "../text";
import { GLYPH, type Tone } from "../theme";
import type { Ui } from "../ui";
import { cad, monthYear, shortMonth } from "./format";

export type MoneyPage = MoneySummary & { starters: string[] };
type Category = { category: string; spent: number; limit: number | null };

// Spending by category with any budgets, plus budgets for categories with no spending this month: the rows j/k pick.
export function moneyCategories(v: MoneySummary): Category[] {
  const limits = new Map(v.budgets.map((b) => [b.category, b.limit]));
  const rows: Category[] = v.spending.map((s) => ({ category: s.category, spent: s.amount, limit: limits.get(s.category) ?? null }));
  for (const b of v.budgets) if (!rows.some((r) => r.category === b.category)) rows.push({ category: b.category, spent: 0, limit: b.limit });
  return rows;
}

const BAR = 16;

function categoryLine(c: Category, max: number, selected: boolean, cols: number): Line {
  const pct = c.limit ? (c.spent / c.limit) * 100 : null;
  // Without a limit the bar only compares categories, so it stays quiet.
  const tone: Tone = pct === null ? "faint" : pct >= 100 ? "bad" : pct >= 80 ? "warn" : "accent";
  const note: Line =
    pct === null
      ? [{ text: "  no budget", color: "faint" }]
      : [{ text: `  ${pct >= 80 ? `${GLYPH.notdone} ` : ""}${Math.round(pct)}% of ${cad(c.limit!, 0)}${pct >= 100 ? " · over" : ""}`, color: pct >= 80 ? tone : "faint" }];
  const name = truncate(c.category, 15);
  const fill = selected ? { bg: "soft" as const } : {};
  return fit(
    [
      { text: selected ? GLYPH.sel : " ", color: "accent" },
      { text: ` ${name}${" ".repeat(Math.max(1, 16 - width(name)))}`, color: selected ? undefined : "dim", bold: selected, ...fill },
      { text: cad(c.spent, 0).padStart(9), bold: true, ...fill },
      { text: "  ", ...fill },
      ...bar(c.limit ? Math.min(1, c.spent / c.limit) : c.spent / max, BAR, tone),
      ...note,
    ],
    cols,
  );
}

function subscriptionLines(v: MoneySummary, cols: number): Line[] {
  const s = v.subscriptions;
  const out: Line[] = [[label("Subscriptions"), { text: s.list.length ? `   ${cad(s.perMonth)}/mo` : "", color: "faint" }], []];
  if (!s.list.length) out.push([{ text: "None found yet. Three monthly charges make one.", color: "faint" }]);
  for (const x of s.list.slice(0, 8)) {
    const flags: Line = [];
    if (x.flags.includes("price-up")) flags.push({ text: `  ${GLYPH.up} was ${cad(x.was ?? 0)}`, color: "warn" });
    if (x.flags.includes("new")) flags.push({ text: "  new", color: "info" });
    if (x.flags.includes("forgotten")) flags.push({ text: "  maybe forgotten", color: "warn" });
    const name = truncate(x.merchant, 14);
    out.push(fit([{ text: `${name}${" ".repeat(Math.max(1, 15 - width(name)))}`, color: "dim" }, { text: cad(x.amount), bold: true }, { text: x.cadence === "yearly" ? "/yr" : "", color: "faint" }, ...flags], cols));
  }
  if (s.list.length > 8) out.push([{ text: `+${s.list.length - 8} more on the dashboard`, color: "faint" }]);
  if (s.bills.list.length) out.push([{ text: `Bills and rent: ${s.bills.list.length} · ${cad(s.bills.perMonth)}/mo`, color: "faint" }]);
  return out;
}

function roomLines(v: MoneySummary): Line[] {
  const r = v.room;
  return [[label("TFSA room")], [{ text: r.headline, bold: true, color: r.over > 0 ? "bad" : undefined }], ...(r.from ? [[{ text: r.from, color: "faint" as const }]] : []), ...(r.todo ? [[{ text: r.todo, color: "dim" as const }]] : [])];
}

function answerLines(v: MoneySummary, cols: number, now: number): Line[] {
  const a = v.asks[0];
  if (!a) return [[label("Ask Claude")], [{ text: "Press space and ask, like \"where did my money go last month?\"", color: "faint" }]];
  if (a.status === "queued" || a.status === "running") return [[label("Ask Claude")], [{ text: `${GLYPH.dot} Claude is looking at your money…`, color: "info" }], [{ text: a.question, color: "dim" }]];
  const body = markdownLines(a.body, cols).slice(0, 8);
  return [[label("Latest answer"), { text: `  ${relative(a.createdAt, now)}`, color: "faint" }], [{ text: a.question || "Explain my month", bold: true }], ...body, [{ text: "Facts from your files; not financial advice.", color: "faint" }]];
}

export function moneyScreen(v: MoneyPage | null, ui: Ui, investing: boolean, cols: number, rows: number, y0: number, now: number): Block {
  if (!investing) return { lines: rowsOf([[], [{ text: "  There's no Investing space yet, and Money lives there.", bold: true }], [{ text: '  Press space and ask Atrium to set one up, like "track my investing".', color: "dim" }]], cols, rows), hits: [] };
  if (!v) return { lines: rowsOf([[], [{ text: "  Loading your money…", color: "faint" }]], cols, rows), hits: [] };
  if (!v.month) {
    return {
      lines: rowsOf([[], [{ text: "  Import a bank, card or Wealthsimple file to see where your money went.", bold: true }], [{ text: "  Press i and type the file's path. It's read on this Mac and nothing leaves it.", color: "dim" }]], cols, rows),
      hits: [],
    };
  }
  const hits: Hit[] = [];
  const at = v.months.indexOf(v.month);
  const earlier = v.months[at + 1];
  const later = v.months[at - 1];
  const head: Line = [{ text: "  " }, { text: ` ${monthYear(v.month)} `, bg: "accent", bold: true }, { text: "  " }];
  let x = 2 + width(` ${monthYear(v.month)} `) + 2;
  if (earlier) {
    const t = `‹ ${shortMonth(earlier)}`;
    head.push({ text: t, color: "dim" }, { text: "   " });
    hits.push({ x, y: y0 + 1, w: width(t), h: 1, click: { input: "[" } });
    x += width(t) + 3;
  }
  if (later) {
    const t = `${shortMonth(later)} ›`;
    head.push({ text: t, color: "dim" });
    hits.push({ x, y: y0 + 1, w: width(t), h: 1, click: { input: "]" } });
  }
  const meta = [v.coverLine, v.lastImportAt !== null ? `Last import ${relative(v.lastImportAt, now)}` : null, `${v.accounts.length} ${v.accounts.length === 1 ? "account" : "accounts"}`].filter(Boolean).join(" · ");
  head.push({ text: `     ${meta}`, color: "faint" });
  const r = v.recap;
  const net = r ? r.net : v.income - v.spent;
  const totals: Line = [
    { text: "  Spent ", color: "dim" },
    { text: cad(v.spent), bold: true },
    { text: "    In ", color: "dim" },
    { text: cad(v.income), bold: true, color: "ok" },
    { text: "    Left over ", color: "dim" },
    { text: cad(net), bold: true, color: net >= 0 ? "ok" : "bad" },
    ...(r?.refunds.count ? [{ text: "    Refunds ", color: "dim" as const }, { text: cad(r.refunds.total), bold: true }] : []),
  ];
  const cats = moneyCategories(v);
  const max = Math.max(1, ...cats.map((c) => Math.max(c.spent, c.limit ?? 0)));
  const sel = Math.min(ui.money.row, Math.max(0, cats.length - 1));
  const top: Line[] = [[], head, [], totals, []];
  const wide = cols >= 100;
  const leftW = wide ? Math.min(74, cols - 42) : cols;
  const catHead: Line = [{ text: "  " }, label("Spending by category"), { text: "   b sets a budget", color: "faint" }];
  const catLines = cats.length ? cats.map((c, i) => categoryLine(c, max, i === sel, leftW)) : [[{ text: "  No spending this month.", color: "faint" as const }]];
  const recapLines: Line[] = r?.lines.length ? [[], ...r.lines.slice(0, 2).map((l): Line => [{ text: `  ${l}`, color: "dim" }])] : [];
  const bodyRows = rows - top.length;
  if (wide) {
    const rightW = cols - leftW - 1;
    const right = [...subscriptionLines(v, rightW - 2), [], ...roomLines(v), [], ...answerLines(v, rightW - 2, now)].map((l): Line => [{ text: "  " }, ...l]);
    // The category list scrolls inside its column when there are more than fit.
    const room = bodyRows - 2 - recapLines.length;
    const first = Math.max(0, Math.min(sel - Math.floor(room / 2), catLines.length - room));
    const left = [catHead, [], ...catLines.slice(first, first + room), ...recapLines];
    catLines.slice(first, first + room).forEach((_, i) => hits.push({ x: 0, y: y0 + top.length + 2 + i, w: leftW, h: 1, click: { row: { list: "money", index: first + i } }, wheel: "list" }));
    const divider = Array.from({ length: bodyRows }, (): Line => [{ text: "│", color: "line" }]);
    return { lines: rowsOf([...top, ...columns([{ lines: left, w: leftW }, { lines: divider, w: 1 }, { lines: right, w: rightW }], bodyRows)], cols, rows), hits };
  }
  // Narrow: one column that scrolls to keep the picked category on screen.
  const stacked: Line[] = [catHead, [], ...catLines, ...recapLines, [], ...[...subscriptionLines(v, cols - 2), [], ...roomLines(v), [], ...answerLines(v, cols - 2, now)].map((l): Line => [{ text: "  " }, ...l])];
  const selLine = 2 + sel;
  const first = Math.max(0, Math.min(selLine - Math.floor(bodyRows / 2), stacked.length - bodyRows));
  catLines.forEach((_, i) => {
    const y = 2 + i - first;
    if (y >= 0 && y < bodyRows) hits.push({ x: 0, y: y0 + top.length + y, w: cols, h: 1, click: { row: { list: "money", index: i } }, wheel: "list" });
  });
  return { lines: rowsOf([...top, ...stacked.slice(first, first + bodyRows)], cols, rows), hits };
}
