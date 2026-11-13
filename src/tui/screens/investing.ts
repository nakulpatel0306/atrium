// Investing, read-only: the portfolio in CAD with today's change, holdings, watchlists, alerts and earnings. The rows
// j/k pick are the symbols the Ask box asks Claude about.
import type { Alert } from "../../engine/markets/alerts";
import { currencyOfKey, describeRule } from "../../engine/markets/labels";
import type { GlanceView, PortfolioView } from "../../engine/markets/views";
import { type Block, columns, fit, type Hit, label, type Line, rowsOf } from "../canvas";
import { truncate, width } from "../text";
import { GLYPH } from "../theme";
import type { Ui } from "../ui";
import { cad, change, dayText, hourText, price, signedCad } from "./format";

export type InvestData = { portfolio: PortfolioView | null; glance: GlanceView | null; alerts: Alert[] | null };

type Row = { key: string; line: (cols: number, selected: boolean) => Line };

const padEnd = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));
const padStart = (s: string, w: number) => " ".repeat(Math.max(0, w - width(s))) + s;

function selectable(segs: Line, cols: number, selected: boolean): Line {
  const fill = selected ? { bg: "soft" as const } : {};
  return fit([{ text: selected ? GLYPH.sel : " ", color: "accent" }, { text: " ", ...fill }, ...segs.map((s) => ({ ...s, ...fill }))], cols, fill);
}

// Holdings first, then each watchlist's symbols not already listed: the order j/k walks.
function rowsOf_(d: InvestData): { holdings: Row[]; lists: { name: string; rows: Row[] }[] } {
  const seen = new Set<string>();
  const holdings: Row[] = (d.portfolio?.holdings ?? []).map((h) => {
    seen.add(h.key);
    return {
      key: h.key,
      line: (cols, sel) => {
        const wide = cols >= 60;
        return selectable(
          [
            { text: padEnd(truncate(h.key, 9), 10), bold: true },
            { text: padStart(h.price ? price(h.price.value, currencyOfKey(h.key)) : "no price", 12), color: h.price ? undefined : "faint" },
            { text: "  " },
            { ...change(h.dayPct), text: padEnd(change(h.dayPct).text, 9) },
            { text: padStart(h.valueCad === null ? "—" : cad(h.valueCad, 0), 12) },
            ...(wide && h.weightPct !== null ? [{ text: padStart(`${h.weightPct.toFixed(0)}%`, 8), color: "faint" as const }] : []),
          ],
          cols,
          sel,
        );
      },
    };
  });
  const lists = (d.glance?.lists ?? []).map((l) => ({
    name: l.name,
    rows: l.rows
      .filter((r) => !seen.has(r.key) && (seen.add(r.key), true))
      .map((r): Row => ({
        key: r.key,
        line: (cols, sel) =>
          selectable(
            [
              { text: padEnd(truncate(r.key, 9), 10), bold: true },
              { text: padStart(r.price === null ? "no price" : price(r.price, r.ccy), 12), color: r.price === null ? "faint" : undefined },
              { text: "  " },
              change(r.dayPct),
              ...(r.tag ? [{ text: `  ${r.tag}`, color: "faint" as const }] : []),
            ],
            cols,
            sel,
          ),
      })),
  }));
  return { holdings, lists };
}

// The symbols j/k walk, in order.
export function investKeys(d: InvestData): string[] {
  const { holdings, lists } = rowsOf_(d);
  return [...holdings, ...lists.flatMap((l) => l.rows)].map((r) => r.key);
}

function headLines(d: InvestData): Line[] {
  const p = d.portfolio;
  if (!p) return [[{ text: "  Loading your portfolio…", color: "faint" }]];
  if (p.empty || !p.total) return [[{ text: "  No holdings yet. Import them in the app; the Watchlists below still work.", color: "dim" }]];
  const out: Line[] = [
    [
      { text: "  Portfolio ", color: "dim" },
      { text: cad(p.total.value, 0), bold: true },
      { text: "   " },
      change(p.dayPct, ` ${p.dayLabel ?? "today"}`),
      ...(p.dayCad !== null ? [{ text: ` (${signedCad(p.dayCad)})`, color: "dim" as const }] : []),
      ...(p.gain ? [{ text: "    Gain ", color: "dim" as const }, { text: signedCad(p.gain.cad), color: p.gain.cad >= 0 ? ("ok" as const) : ("bad" as const) }] : []),
    ],
  ];
  if (p.mix || p.left) out.push([{ text: `  ${[p.mix, p.left].filter(Boolean).join(" · ")}`, color: "faint" }]);
  if (d.glance?.paper) out.push([{ text: `  Paper ${signedCad(d.glance.paper.dayPnl, 2)} today (${signedCad(d.glance.paper.totalPnl, 2)} total)`, color: "faint" }]);
  return out;
}

function alertLines(alerts: Alert[] | null): Line[] {
  const out: Line[] = [[label("Alerts")]];
  if (!alerts) return [...out, [{ text: "Loading…", color: "faint" }]];
  const live = alerts.filter((a) => a.status !== "off");
  if (!live.length) return [...out, [{ text: "No alerts. Set one from a symbol's page in the app.", color: "faint" }]];
  for (const a of live.slice(0, 6)) {
    out.push([{ text: `${a.status === "fired" ? GLYPH.notdone : "○"} `, color: a.status === "fired" ? "warn" : "faint" }, { text: `${a.key} `, bold: true }, { text: describeRule(a.rule, a.key), color: "dim" }, { text: a.status === "fired" ? "  fired" : "  armed", color: a.status === "fired" ? "warn" : "faint" }]);
  }
  return out;
}

function earningsLines(g: GlanceView | null): Line[] {
  const out: Line[] = [[label("Earnings · next 30 days")]];
  if (!g) return [...out, [{ text: "Loading…", color: "faint" }]];
  if (!g.earnings.length) return [...out, [{ text: "No earnings in the next 30 days.", color: "faint" }]];
  for (const e of g.earnings.slice(0, 8)) out.push([{ text: `${dayText(e.date)}  `, color: "dim" }, { text: e.key, bold: true }, { text: `  ${hourText(e.hour)}`, color: "faint" }, ...(e.held ? [{ text: "  · you hold this", color: "faint" as const }] : [])]);
  return out;
}

export function investingScreen(d: InvestData, ui: Ui, investing: boolean, cols: number, rows: number, y0: number): Block {
  if (!investing) return { lines: rowsOf([[], [{ text: "  There's no Investing space yet.", bold: true }], [{ text: '  Press space and ask Atrium to set one up, like "track my investing".', color: "dim" }]], cols, rows), hits: [] };
  const { holdings, lists } = rowsOf_(d);
  const all = [...holdings, ...lists.flatMap((l) => l.rows)];
  const sel = Math.min(ui.invest.row, Math.max(0, all.length - 1));
  const head = [[], ...headLines(d), []];
  const wide = cols >= 100;
  const leftW = wide ? Math.min(70, cols - 44) : cols;
  // The symbol lists, each row tagged with its index among the selectable rows.
  const listLines: { line: Line; index: number | null }[] = [];
  const tableHead = (cols: number): Line => [{ text: `  ${padEnd("Symbol", 10)}${padStart("Price", 12)}  ${padEnd("Today", 9)}${padStart("Value CA$", 12)}${cols >= 60 ? padStart("Weight", 8) : ""}`, color: "faint" }];
  listLines.push({ line: [{ text: "  " }, label("Holdings"), { text: holdings.length ? `  ${holdings.length}` : "", color: "faint" }], index: null });
  if (holdings.length) listLines.push({ line: tableHead(leftW), index: null });
  else listLines.push({ line: [{ text: "  None yet.", color: "faint" }], index: null });
  holdings.forEach((h, i) => listLines.push({ line: h.line(leftW, i === sel), index: i }));
  let n = holdings.length;
  // A list whose symbols are all held already adds nothing here.
  for (const l of lists.filter((x) => x.rows.length)) {
    listLines.push({ line: [], index: null }, { line: [{ text: "  " }, label(l.name)], index: null });
    for (const r of l.rows) {
      listLines.push({ line: r.line(leftW, n === sel), index: n });
      n++;
    }
  }
  const side = [...alertLines(d.alerts), [], ...earningsLines(d.glance), [], [{ text: "Not financial advice. Market data sees only ticker symbols.", color: "faint" as const }]];
  const bodyRows = rows - head.length;
  const hits: Hit[] = [];
  const at = listLines.findIndex((l) => l.index === sel);
  const visible = (lines: typeof listLines, room: number) => {
    const first = Math.max(0, Math.min(at - Math.floor(room / 2), lines.length - room));
    lines.slice(first, first + room).forEach((l, i) => {
      if (l.index !== null) hits.push({ x: 0, y: y0 + head.length + i, w: leftW, h: 1, click: { row: { index: l.index } }, wheel: "list" });
    });
    return lines.slice(first, first + room).map((l) => l.line);
  };
  if (wide) {
    const rightW = cols - leftW - 1;
    const divider = Array.from({ length: bodyRows }, (): Line => [{ text: "│", color: "line" }]);
    const body = columns([{ lines: visible(listLines, bodyRows), w: leftW }, { lines: divider, w: 1 }, { lines: side.map((l): Line => [{ text: "  " }, ...l]), w: rightW }], bodyRows);
    return { lines: rowsOf([...head, ...body], cols, rows), hits };
  }
  const stacked = [...listLines, { line: [], index: null }, ...side.map((l) => ({ line: [{ text: "  " }, ...l] as Line, index: null }))];
  return { lines: rowsOf([...head, ...visible(stacked, bodyRows)], cols, rows), hits };
}
