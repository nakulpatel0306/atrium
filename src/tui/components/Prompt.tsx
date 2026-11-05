import { agentName } from "../../dashboard/agents";
import { cursorParts } from "../edit";
import type { State } from "../../engine/state";
import { width as textWidth } from "../text";

const segmenter = new Intl.Segmenter();

// The end of `s` that fits in `cols`, cut between graphemes.
function truncateStart(s: string, cols: number): string {
  let out = "";
  for (const { segment } of [...segmenter.segment(s)].reverse()) {
    if (textWidth(segment + out) > cols) break;
    out = segment + out;
  }
  return out;
}
import { color } from "../theme";
import type { Overlay } from "../ui";
import { Float } from "./Float";
import type { Segment } from "./Row";

type PromptOverlay = Extract<Overlay, { kind: "prompt" }>;

function titleOf(p: PromptOverlay, state: State): string {
  const space = state.spaces.find((s) => s.id === p.targetId);
  switch (p.purpose) {
    case "task":
      return `New task in ${space?.name ?? "this space"} · agent: ${agentName(p.agent)} (tab)`;
    case "space":
      return "New space · describe it";
    case "reply":
      return "Send back · what should change?";
    case "goal":
      return `Goal${space ? ` · ${space.name}` : ""}`;
    case "filter":
      return "/ filter";
  }
}

// A one-line input along the bottom of the right column. The cursor is the inverted cell.
export function Prompt({ prompt, state, width, top, left }: { prompt: PromptOverlay; state: State; width: number; top: number; left: number }) {
  const inner = width - 2;
  const { before, at, after } = cursorParts(prompt);
  // Long input scrolls so the cursor stays in view.
  const room = inner - 3;
  const shownBefore = textWidth(before) > room ? `…${truncateStart(before, room - 1)}` : before;
  const line: Segment[] = [
    { text: "> ", color: color.accent },
    { text: shownBefore },
    { text: at, inverse: true },
    { text: after },
  ];
  const hint: Segment[] = [{ text: "enter to send · esc to cancel", color: color.muted }];
  return <Float title={titleOf(prompt, state)} rows={[line, hint]} width={width} top={top} left={left} />;
}
