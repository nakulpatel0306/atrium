import type { DetailLine } from "../detail";
import { Lines } from "./Lines";
import { Pane } from "./Pane";

type Props = { title: string; lines: DetailLine[]; scroll: number; focused: boolean; width: number; height: number };

// `lines` arrive wrapped to the pane, so scrolling is a slice.
export function DetailPane({ title, lines, scroll, focused, width, height }: Props) {
  const rows = height - 2;
  const top = Math.min(scroll, Math.max(0, lines.length - rows));
  return (
    <Pane n={0} title={title} focused={focused} width={width} height={height} padded>
      <Lines lines={lines.slice(top, top + rows)} />
    </Pane>
  );
}
