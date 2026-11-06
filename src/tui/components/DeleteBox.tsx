import { type SpaceDeletePreview, spaceDeleteLines } from "../../dashboard/deletion";
import type { State } from "../../engine/state";
import { cursorParts } from "../edit";
import { wrapStyled } from "../detail";
import { color } from "../theme";
import type { Overlay } from "../ui";
import { Float } from "./Float";
import type { Segment } from "./Row";

type DeleteOverlay = Extract<Overlay, { kind: "delete" }>;
const WIDTH = 64;

// What goes, what stays, and the typed name, as lines, so it's tested without a terminal.
export function deleteBoxLines(overlay: DeleteOverlay, state: State, preview: SpaceDeletePreview | null, width: number): { title: string; lines: Segment[][] } {
  const name = [...state.spaces, ...(state.archived ?? [])].find((s) => s.id === overlay.spaceId)?.name ?? "this space";
  const wrap = (text: string, c?: (typeof color)[keyof typeof color]) => wrapStyled([{ text, color: c }], width - 2);
  const lines: Segment[][] = [];
  if (!preview) lines.push([{ text: "Counting what's in it…", color: color.muted }]);
  else {
    const { goes, stays } = spaceDeleteLines(preview);
    lines.push([{ text: "This removes:" }]);
    for (const g of goes) lines.push(...wrapStyled([{ text: `  · ${g}` }], width - 2));
    if (stays.length) lines.push([]);
    for (const l of stays) lines.push(...wrap(l, color.muted));
    if (preview.refusal) lines.push([], ...wrap(preview.refusal, color.bad));
  }
  const { before, at, after } = cursorParts(overlay);
  lines.push([], ...wrap(`Type ${name} to confirm. This can't be undone.`), [
    { text: "> ", color: color.bad },
    { text: before },
    { text: at, inverse: true },
    { text: after },
  ]);
  lines.push([{ text: "enter delete · esc keep it", color: color.muted }]);
  return { title: `Delete ${name} for good`, lines };
}

export function DeleteBox({ overlay, state, preview, cols, rows }: { overlay: DeleteOverlay; state: State; preview: SpaceDeletePreview | null; cols: number; rows: number }) {
  const width = Math.min(WIDTH, cols - 4);
  const { title, lines } = deleteBoxLines(overlay, state, preview, width);
  const top = Math.max(1, Math.floor((rows - lines.length - 2) / 2));
  return <Float title={title} rows={lines} width={width} top={top} left={Math.floor((cols - width) / 2)} />;
}
