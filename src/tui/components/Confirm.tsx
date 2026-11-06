import type { State } from "../../engine/state";
import { displayHandle } from "../../engine/messaging/rules";
import { type DetailLine, wrapStyled } from "../detail";
import { color } from "../theme";
import type { Overlay } from "../ui";
import { Float } from "./Float";

const WIDTH = 50;

type Props = { confirm: Extract<Overlay, { kind: "confirm" }>; state: State; cols: number; rows: number };

// What each confirm says, as lines, so it's tested without a terminal.
export function confirmLines(confirm: Props["confirm"], state: State, width: number): { title: string; lines: DetailLine[] } {
  const wrap = (text: string) => wrapStyled([{ text }], width - 2);
  if (confirm.purpose === "send") {
    const m = state.messageActions.find((x) => x.id === confirm.targetId);
    const to = m?.handle ? `${m.toName} (${displayHandle(m.handle)})` : (m?.toName ?? "them");
    return {
      title: "Send a text",
      lines: [
        ...wrap(`Send this to ${to}?`),
        [{ text: `Via ${m?.service ?? "iMessage"}`, color: color.muted }],
        [],
        ...(m?.text ?? "").split("\n").flatMap((l) => wrapStyled([{ text: l, bold: true }], width - 2)),
        [],
        ...wrapStyled([{ text: "Sends from Messages on this Mac. Atrium can't confirm delivery.", color: color.muted }], width - 2),
        [{ text: "y send · n not now", color: color.muted }],
      ],
    };
  }
  if (confirm.purpose === "accept") {
    const a = state.approvals.find((x) => x.id === confirm.targetId);
    const task = a?.taskId ? state.tasks.find((t) => t.id === a.taskId) : undefined;
    const partial = task?.outcome === "partial";
    return {
      title: partial ? "Accept as is" : "Accept anyway",
      lines: [
        ...wrap(partial ? "Accept as is? It says it's only partly done." : "Accept anyway? It says it couldn't do this."),
        ...(task?.outcomeReason ? wrapStyled([{ text: task.outcomeReason, color: color.warn }], width - 2) : []),
        [],
        [{ text: "y accept · n not now", color: color.muted }],
      ],
    };
  }
  const name = state.spaces.find((s) => s.id === confirm.targetId)?.name ?? "this space";
  return {
    title: "Archive space",
    lines: [...wrap(`Archive ${name}? Its agents stop picking up tasks.`), [], [{ text: "y archive · n keep it", color: color.muted }]],
  };
}

export function Confirm({ confirm, state, cols, rows }: Props) {
  const width = Math.min(confirm.purpose === "send" ? 64 : WIDTH, cols - 4);
  const { title, lines } = confirmLines(confirm, state, width);
  const top = Math.max(1, Math.floor((rows - lines.length - 2) / 2));
  return <Float title={title} rows={lines} width={width} top={top} left={Math.floor((cols - width) / 2)} />;
}
