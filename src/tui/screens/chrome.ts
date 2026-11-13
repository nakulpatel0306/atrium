// What every tab shares: the top bar with the tabs, the Ask box, and the key strip.
import { agentName } from "../../dashboard/agents";
import type { State } from "../../engine/state";
import { type Block, box, edgeWith, fit, type Hit, keycap, type Line, lineWidth } from "../canvas";
import { cursorParts } from "../edit";
import { askAgentCycles, type KeyContext, type StripKey } from "../keys";
import type { View } from "../select";
import { width } from "../text";
import { GLYPH, windowGauge } from "../theme";
import { TABS, type Ui } from "../ui";

const TAB_TEXT = { home: "Home", spaces: "Spaces", activity: "Activity" } as const;

// Right side of the top bar: Claude's window, power, overnight, and being offline, shortened to fit.
function status(state: State, online: boolean, room: number): Line {
  const power: Line = [{ text: state.power.source === "ac" ? "AC" : "battery", color: "faint" }];
  if (state.power.overnight) power.push({ text: " · overnight", color: "faint" });
  const offline: Line = online ? [] : [{ text: `${GLYPH.bad} offline · reconnecting`, color: "bad", bold: true }, { text: "  " }];
  const variants = [true, false].map((meter): Line => {
    const g = windowGauge(state, meter ? 30 : 24);
    const gauge: Line =
      "text" in g
        ? [{ text: g.text, color: "faint" }]
        : meter
          ? [{ text: g.label, color: "dim" }, { text: GLYPH.meter.repeat(g.filled), color: g.tone === "warn" ? "warn" : "accent" }, { text: GLYPH.meterEmpty.repeat(g.empty), color: "line" }, { text: g.pct, color: g.tone === "warn" ? "warn" : "dim" }]
          : [{ text: `Claude${g.pct}`, color: g.tone === "warn" ? "warn" : "dim" }];
    return [...offline, ...gauge, { text: "  ·  ", color: "faint" }, ...power, { text: " " }];
  });
  variants.push([...offline, ...power, { text: " " }]);
  return variants.find((v) => lineWidth(v) <= room) ?? fit(variants.at(-1)!, room);
}

export function topBar(ui: Ui, state: State, online: boolean, cols: number): Block {
  const hits: Hit[] = [];
  // The word "atrium" goes first when the window is narrow; the tabs never do.
  const brand: Line = cols >= 96 ? [{ text: " ◆ ", color: online ? "accent" : "bad" }, { text: "atrium", bold: true }, { text: "  " }] : [{ text: " ◆ ", color: online ? "accent" : "bad" }];
  const line: Line = [...brand];
  let x = lineWidth(brand);
  TABS.forEach((tab, i) => {
    const text = ` ${i + 1} ${TAB_TEXT[tab]} `;
    line.push(ui.tab === tab ? { text, bg: "accent", bold: true } : { text, color: "dim" });
    hits.push({ x, y: 0, w: width(text), h: 1, click: { tab: i } });
    x += width(text);
    if (i < TABS.length - 1) {
      line.push({ text: " " });
      x += 1;
    }
  });
  const right = status(state, online, Math.max(0, cols - x - 1));
  const gap = Math.max(1, cols - x - lineWidth(right));
  return { lines: [fit([...line, { text: " ".repeat(gap) }, ...right], cols), fit([{ text: "─".repeat(cols), color: "line" }], cols)], hits };
}

const segmenter = new Intl.Segmenter();

// The end of `s` that fits in `cols`, cut between graphemes.
function truncateStart(s: string, cols: number): string {
  let out = "";
  for (const { segment } of [...segmenter.segment(s)].reverse()) {
    if (width(segment + out) > cols) break;
    out = segment + out;
  }
  return out;
}

// The box's title and its greyed-out suggestion, from what it's for and where.
export function askLabels(ui: Ui, view: View, ctx: KeyContext): { title: string; placeholder: string } {
  const a = ui.ask;
  const space = view.space && ui.selected.spaces.id === view.space.id ? view.space : null;
  const target = a?.targetId ?? null;
  switch (a?.purpose) {
    case "reply":
      return { title: "Send back · what should change?", placeholder: "A note for the agent, or leave it empty." };
    case "goal":
      return { title: `Goal · ${view.state.spaces.find((s) => s.id === target)?.name ?? "this space"}`, placeholder: "What this space is for." };
    case "filter":
      return { title: "Filter", placeholder: "Type to narrow the list. Enter keeps it, esc clears it." };
    case "space":
      return { title: "New space · describe it", placeholder: 'Like "add dark mode to my site" or "start a new project called…"' };
  }
  if (ui.tab === "spaces" && space && space.status !== "archived") {
    const agent = a ? ` · agent ${agentName(a.agent)}${askAgentCycles(ui, view) ? " (tab)" : ""}` : "";
    return { title: `New task in ${space.name}${agent}`, placeholder: `Give ${space.name} a task…` };
  }
  return { title: "Ask Atrium", placeholder: 'Describe something new, like "add dark mode to my site" or "start a new project called…".' };
}

const FLASH = { ok: { glyph: GLYPH.ok, color: "ok" }, bad: { glyph: GLYPH.bad, color: "bad" }, info: { glyph: "•", color: "info" } } as const;

// Three rows: the title in the top edge, the line being typed (or the suggestion), and what just happened in the
// bottom edge, next to where it was asked.
export function askBox(ui: Ui, view: View, ctx: KeyContext, cols: number, y: number): Block {
  const { title, placeholder } = askLabels(ui, view, ctx);
  const focused = ui.ask !== null;
  const inner = cols - 4;
  let body: Line;
  if (ui.ask && (ui.ask.value || focused)) {
    const { before, at, after } = cursorParts(ui.ask);
    const room = inner - 3;
    const shownBefore = width(before) > room ? `…${truncateStart(before, room - 1)}` : before;
    body = [{ text: "› ", color: "accent" }, { text: shownBefore, bold: true }, { text: at, inverse: true }, { text: after, bold: true }];
    if (!ui.ask.value) body = [{ text: "› ", color: "accent" }, { text: " ", inverse: true }, { text: placeholder, color: "faint" }];
  } else {
    body = [{ text: "› ", color: "accent" }, { text: placeholder, color: "faint" }];
  }
  const tone = focused ? "accent" : "line";
  const [top, mid] = box([{ text: title, color: focused ? "accent" : "dim", bold: focused }], [body], cols, 3, tone);
  const f = ui.flash ? FLASH[ui.flash.tone] : null;
  const bottom = edgeWith(f ? [{ text: `${f.glyph} `, color: f.color }, { text: ui.flash!.text, color: f.color }] : [], cols, tone);
  return { lines: [top!, mid!, bottom], hits: [{ x: 0, y, w: cols, h: 3, click: { ask: true } }] };
}

// The keys that work right now. Keys that don't fit are left off, but help always shows.
export function keyStrip(keys: StripKey[], cols: number, y: number): Block {
  const line: Line = [{ text: " " }];
  const hits: Hit[] = [];
  let x = 1;
  const help = keys.find((k) => k.key === "?");
  const helpWidth = help ? lineWidth(keycap(help.key, help.label)) + 2 : 0;
  for (const k of keys) {
    const cap = keycap(k.key, k.label);
    const w = lineWidth(cap) + 2;
    const room = cols - x - (k === help ? 0 : helpWidth);
    if (w > room && k !== help) continue;
    if (w > cols - x) break;
    line.push(...cap, { text: "  " });
    if (k.input !== undefined) hits.push({ x, y, w: w - 2, h: 1, click: { input: k.input, strip: true } });
    x += w;
  }
  return { lines: [fit(line, cols)], hits };
}
