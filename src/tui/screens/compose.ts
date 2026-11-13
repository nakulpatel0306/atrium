// The whole screen for one frame: top bar, the tab (or a full view over it), the Ask box and the key strip, with
// any box spliced over the tab and every clickable region in screen cells.
import { absolute } from "../../dashboard/format";
import type { SpaceDeletePreview } from "../../dashboard/deletion";
import { type Block, type Hit, type Line, rowsOf, shift } from "../canvas";
import { approvalDetail, type DetailLine, proposalDetail, wrapStyled } from "../detail";
import { type KeyContext, strip } from "../keys";
import type { View } from "../select";
import type { Message } from "../../engine/messages";
import type { Rows, Ui } from "../ui";
import { activityDetailRows, activityLines, activityScreen } from "./activity";
import { askBox, keyStrip, topBar } from "./chrome";
import { type HomeData, homeScreen } from "./home";
import { agentsLines, answerOver, confirmOver, deleteOver, fullView, helpOver, pickerOver } from "./overlays";
import { leftWidth, spacesRows, spacesScreen } from "./spaces";

export const CHROME_ROWS = 6;
export const BODY_TOP = 2;

export type Frame = {
  view: View;
  ui: Ui;
  online: boolean;
  cols: number;
  rows: number;
  ctx: KeyContext;
  home: HomeData;
  detail: DetailLine[];
  live: string[];
  transcript: { title: string; lines: string[] };
  messages: Message[] | null;
  reviewers: Record<string, string | null> | null;
  deletePreview: SpaceDeletePreview | null;
  frame: number;
  now: number;
};

// Detail lines are wrapped to this width on the Spaces tab.
export const detailWidth = (cols: number) => cols - leftWidth(cols) - 1 - 2;
export const bodyRows = (rows: number) => rows - CHROME_ROWS;

// The full text of the Needs you item picked on Home.
export function needsLines(view: View, messages: Message[] | null, cols: number): DetailLine[] {
  const w = cols - 4;
  const lines = view.proposal ? proposalDetail(view) : approvalDetail(view, w);
  return lines.flatMap((l) => wrapStyled(l, w));
}

// A transcript can be 5 MB of lines, so only its visible slice is turned into segments; its length is all the rest
// needs.
export function fullCount(f: Frame): number {
  return f.ui.overlay?.kind === "transcript" ? f.transcript.lines.length : fullLines(f).length;
}

export function fullLines(f: Frame, from = 0, to = Number.MAX_SAFE_INTEGER): Line[] {
  const o = f.ui.overlay;
  const w = f.cols - 4;
  if (o?.kind === "transcript") return f.transcript.lines.slice(from, to).map((t): Line => [{ text: t }]);
  if (o?.kind === "agents") return agentsLines(f.view.state).flatMap((l) => wrapStyled(l, w));
  if (o?.kind === "detail") return needsLines(f.view, f.messages, f.cols);
  return [];
}

// What scrolling needs to know about this frame.
export function rowsFor(f: Pick<Frame, "rows" | "cols" | "detail" | "live" | "view">): Rows {
  const body = bodyRows(f.rows);
  const s = spacesRows(body);
  return {
    detail: s.detail,
    live: s.live,
    detailLines: f.detail.length,
    liveLines: f.live.length,
    activity: activityDetailRows(body, f.cols),
    activityLines: f.view.subject === "activity" ? activityLines(f.view, f.cols).length : 0,
  };
}

function body(f: Frame): Block {
  const rows = bodyRows(f.rows);
  const o = f.ui.overlay;
  if (o?.kind === "transcript" || o?.kind === "agents" || o?.kind === "detail") {
    const title =
      o.kind === "transcript"
        ? f.transcript.title
        : o.kind === "agents"
          ? "Agents and usage · u or q to close"
          : titleOf(f.view);
    const shown = rows - 2;
    const total = fullCount(f);
    const top = Math.min(o.scroll, Math.max(0, total - shown));
    return { lines: fullView(title, fullLines(f, top, top + shown), total - top - shown, f.cols, rows), hits: [] };
  }
  switch (f.ui.tab) {
    case "home": {
      const b = homeScreen(f.view, f.ui, f.home, f.cols, rows);
      return { lines: b.lines, hits: shift(b.hits, 0, BODY_TOP) };
    }
    case "spaces":
      return spacesScreen(f.view, f.ui, { detail: f.detail, live: f.live, frame: f.frame, now: f.now }, f.cols, rows, BODY_TOP);
    case "activity":
      return activityScreen(f.view, f.ui, f.cols, rows, BODY_TOP, f.now);
  }
}

function titleOf(view: View): string {
  if (view.proposal) return `Suggestion · ${view.proposal.label}`;
  return view.approval?.title ?? "Needs you";
}

export function compose(f: Frame): Block {
  const rows = bodyRows(f.rows);
  const top = topBar(f.ui, f.view.state, f.online, f.cols);
  let main = body(f);
  let boxHits: Hit[] | null = null;
  const o = f.ui.overlay;
  const lines = rowsOf(main.lines, f.cols, rows);
  if (o?.kind === "confirm") ({ lines: main.lines, hits: boxHits } = confirmOver(lines, o, f.view.state, f.cols, BODY_TOP));
  else if (o?.kind === "delete") ({ lines: main.lines, hits: boxHits } = deleteOver(lines, o, f.view.state, f.deletePreview, f.cols, BODY_TOP));
  else if (o?.kind === "picker") ({ lines: main.lines, hits: boxHits } = pickerOver(lines, o, f.view.state, f.reviewers, f.cols, BODY_TOP));
  else if (o?.kind === "answer") ({ lines: main.lines, hits: boxHits } = answerOver(lines, o, f.view.state, f.cols, BODY_TOP));
  else if (o?.kind === "help") ({ lines: main.lines, hits: boxHits } = helpOver(lines, f.ui, f.cols, BODY_TOP));
  else main = { ...main, lines };
  const ask = askBox(f.ui, f.view, f.ctx, f.cols, BODY_TOP + rows);
  const keys = keyStrip(strip(f.ui, f.view), f.cols, BODY_TOP + rows + 3);
  // A box over the tab takes every click but its own keys and the strip's.
  const hits = boxHits ? [...boxHits, ...keys.hits] : [...top.hits, ...main.hits, ...ask.hits, ...keys.hits];
  return { lines: [...top.lines, ...rowsOf(main.lines, f.cols, rows), ...ask.lines, ...keys.lines], hits };
}

export const transcriptTitle = (task: string, index: number, total: number, startedAt: number | null) =>
  `Transcript · ${task} · run ${total - index}/${total}${startedAt !== null ? ` · ${absolute(startedAt)}` : ""}`;
