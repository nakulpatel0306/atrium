import { Box } from "ink";
import type { DetailLine } from "../detail";
import type { Layout } from "../layout";
import type { View } from "../select";
import type { ListPane, Ui } from "../ui";
import { ActivityPane } from "./ActivityPane";
import { DetailPane } from "./DetailPane";
import { LivePane } from "./LivePane";
import { NeedsPane } from "./NeedsPane";
import { Pane } from "./Pane";
import { SpacesPane } from "./SpacesPane";
import { TasksPane } from "./TasksPane";

type Props = { view: View; ui: Ui; lay: Layout; detailLines: DetailLine[]; liveLines: string[]; online: boolean };

function detailTitle(view: View): string | undefined {
  if (view.subject === "space") return view.space?.name;
  if (view.subject === "task") return view.task?.title;
  if (view.subject === "approval") return view.proposal ? `Suggestion · ${view.proposal.label}` : view.approval?.title;
  return view.activityRow ? "Activity" : undefined;
}

// The main screen: four lists on the left, Detail and Live on the right.
export function Body({ view, ui, lay, detailLines, liveLines, online }: Props) {
  const focused = (p: Ui["focus"]) => ui.focus === p;
  const filterTag = (p: ListPane) => (ui.filters[p] ? ` · /${ui.filters[p]}` : "");
  const list = (p: ListPane) => ({ view, ui, cols: lay.left - 2, rows: lay.heights[p] - 2, focused: focused(p) });
  const pane = (p: ListPane, n: number, title: string) => ({
    n,
    title: `${title}${filterTag(p)}`,
    focused: focused(p),
    width: lay.left,
    height: lay.heights[p],
    online,
  });
  const needs = view.state.approvals.length + view.state.proposals.length;
  const subject = detailTitle(view);
  return (
    <Box>
      <Box flexDirection="column" width={lay.left} flexShrink={0}>
        <Pane {...pane("spaces", 1, "Spaces")}>
          <SpacesPane {...list("spaces")} />
        </Pane>
        <Pane {...pane("tasks", 2, `Tasks${view.space ? ` · ${view.space.name}` : ""}`)}>
          <TasksPane {...list("tasks")} />
        </Pane>
        <Pane {...pane("needs", 3, `Needs you${needs ? ` · ${needs}` : ""}`)}>
          <NeedsPane {...list("needs")} />
        </Pane>
        <Pane {...pane("activity", 4, "Activity")}>
          <ActivityPane {...list("activity")} />
        </Pane>
      </Box>
      <Box flexDirection="column" width={lay.right} flexShrink={0}>
        <DetailPane
          title={`Detail${subject ? ` · ${subject}` : ""}`}
          lines={detailLines}
          scroll={ui.detailScroll}
          focused={focused("detail")}
          width={lay.right}
          height={lay.detail}
          online={online}
        />
        <LivePane view={view} lines={liveLines} scroll={ui.liveScroll} focused={focused("live")} width={lay.right} height={lay.live} online={online} />
      </Box>
    </Box>
  );
}
