import type { DetailLine } from "../detail";
import { Lines } from "./Lines";
import { Pane } from "./Pane";

// `focusLine` is a line that must be on screen (the made file picked with f); the view moves to it when it isn't.
type Props = { title: string; lines: DetailLine[]; scroll: number; focusLine?: number; focused: boolean; width: number; height: number; online?: boolean };

// `lines` arrive wrapped to the pane, so scrolling is a slice.
export function DetailPane({ title, lines, scroll, focusLine, focused, width, height, online }: Props) {
  const rows = height - 2;
  let top = Math.min(scroll, Math.max(0, lines.length - rows));
  if (focusLine !== undefined && (focusLine < top || focusLine >= top + rows)) top = Math.max(0, Math.min(focusLine - Math.floor(rows / 2), lines.length - rows));
  return (
    <Pane n={0} title={title} focused={focused} width={width} height={height} online={online} padded>
      <Lines lines={lines.slice(top, top + rows)} />
    </Pane>
  );
}
