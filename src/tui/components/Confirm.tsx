import type { State } from "../../engine/state";
import { wrapStyled } from "../detail";
import { color } from "../theme";
import type { Overlay } from "../ui";
import { Float } from "./Float";

const WIDTH = 50;

type Props = { confirm: Extract<Overlay, { kind: "confirm" }>; state: State; cols: number; rows: number };

export function Confirm({ confirm, state, cols, rows }: Props) {
  const name = state.spaces.find((s) => s.id === confirm.targetId)?.name ?? "this space";
  const width = Math.min(WIDTH, cols - 4);
  const lines = [
    ...wrapStyled([{ text: `Archive ${name}? Its agents stop picking up tasks.` }], width - 2),
    [],
    [{ text: "y archive · n keep it", color: color.muted }],
  ];
  const top = Math.max(1, Math.floor((rows - lines.length - 2) / 2));
  return <Float title="Archive space" rows={lines} width={width} top={top} left={Math.floor((cols - width) / 2)} />;
}
