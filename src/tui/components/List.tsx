import { Box } from "ink";
import { pick, type View } from "../select";
import { viewport, width } from "../text";
import type { ListPane, Ui } from "../ui";
import { Empty, Row, type Segment } from "./Row";

export type ListProps = { view: View; ui: Ui; cols: number; rows: number; focused: boolean };

export function List<T extends { id: string }>({
  items,
  pane,
  ui,
  cols,
  rows,
  focused,
  empty,
  render,
}: Omit<ListProps, "view"> & { items: T[]; pane: ListPane; empty: string; render: (item: T) => Segment[] }) {
  if (items.length === 0) return <Empty text={empty} />;
  const { index } = pick(items, ui.selected[pane]);
  const { top, rows: shown } = viewport(items, index, rows);
  return (
    <Box flexDirection="column">
      {shown.map((item, i) => (
        <Row
          key={item.id}
          cols={cols}
          segments={render(item)}
          selected={top + i === index ? (focused ? "focused" : "idle") : undefined}
        />
      ))}
    </Box>
  );
}

export const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));
