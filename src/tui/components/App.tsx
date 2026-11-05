import { Box, type Key, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import type { State } from "../../engine/state";
import type { EngineClient } from "../client";
import { activityDetail, approvalDetail, type DetailLine, spaceDetail, taskDetail, wrapStyled } from "../detail";
import { useEngineState, useMessages, useOnline, useReviewers, useRunOutput, useTick } from "../hooks";
import { commandsFor, hints, type Intent } from "../keys";
import { layout } from "../layout";
import { reviewTarget } from "../../dashboard/summary";
import { deriveView, type View } from "../select";
import { clean, wrapLines } from "../text";
import { color } from "../theme";
import { type Flash, initialUi, reduce, type Rows, type Ui } from "../ui";
import { ActivityPane } from "./ActivityPane";
import { DetailPane } from "./DetailPane";
import { LivePane } from "./LivePane";
import { Header } from "./Header";
import { NeedsPane } from "./NeedsPane";
import { Pane } from "./Pane";
import { SpacesPane } from "./SpacesPane";
import { StatusBar } from "./StatusBar";
import { TasksPane } from "./TasksPane";

const NO_KEY = {} as Key;
const inPrompt = (u: Ui) => u.overlay?.kind === "prompt";

type Size = { columns: number; rows: number };

// The agent thread a subject needs: a work task's own, or an approval's once its review has finished.
function threadOf(view: View): string | null {
  if (view.subject === "task") return view.task?.kind === "work" ? view.task.id : null;
  if (view.subject === "approval" && view.approval) return reviewTarget(view.approval, view.state);
  return null;
}

function detailOf(view: View, messages: ReturnType<typeof useMessages>, reviewers: ReturnType<typeof useReviewers>): DetailLine[] {
  if (view.subject === "task") return taskDetail(view, messages);
  if (view.subject === "approval") return approvalDetail(view, messages);
  if (view.subject === "activity") return activityDetail(view);
  return spaceDetail(view, reviewers);
}

export function App({ client, size }: { client: EngineClient; size?: Size }) {
  const win = useWindowSize();
  const cols = size?.columns ?? win.columns;
  const height = size?.rows ?? win.rows;
  const state = useEngineState(client);
  const online = useOnline(client);
  const { exit } = useApp();
  const [ui, setUi] = useState<Ui>(initialUi);
  // Keys can arrive several to a chunk; each must see the UI the previous one left, not the last render's.
  const uiRef = useRef(ui);
  const briefing = useRef<State["briefing"] | null>(null);
  const seen = useRef(false);
  if (state && !briefing.current) briefing.current = state.briefing;

  useEffect(() => {
    if (!state || seen.current) return;
    seen.current = true;
    void client.post("/api/seen");
  }, [state, client]);

  useTick(60_000, true);
  useTick(15_000, state?.tasks.some((t) => t.status === "running") ?? false);

  const lay = layout(cols, height, ui.focus, ui.lastLeft);
  // Detail and Live keep a column of padding inside each border, for prose rather than a list.
  const inner = "tooSmall" in lay ? 1 : lay.right - 4;
  const view = state ? deriveView(state, ui) : null;
  const messages = useMessages(client, view ? threadOf(view) : null);
  const reviewers = useReviewers(client, view?.subject === "space" && view.space?.kind === "repo" ? view.space : null);
  const output = useRunOutput(client, view?.live?.run.id ?? null);
  const detailLines = view ? detailOf(view, messages, reviewers).flatMap((l) => wrapStyled(l, inner)) : [];
  const liveLines = output ? wrapLines(clean(output).replace(/\n$/, ""), inner) : [];
  const rows: Rows =
    "tooSmall" in lay
      ? { detail: 1, live: 1 }
      : { detail: lay.detail - 2, live: lay.live - 3, detailLines: detailLines.length, liveLines: liveLines.length };

  const commit = (next: Ui) => {
    uiRef.current = next;
    setUi(next);
  };

  const flash = (f: Flash) => {
    const s = client.state();
    if (s) commit(reduce(uiRef.current, { type: "flash", flash: f }, deriveView(s, uiRef.current), rows));
  };

  const runIntent = (_intent: Intent) => flash({ tone: "info", text: "Not wired yet." });

  const handle = (input: string, key: Key) => {
    const s = client.state();
    if (!s) {
      if (input === "q") exit();
      return;
    }
    let cur = uiRef.current;
    const intents: Intent[] = [];
    let quit = false;
    const run = (text: string) => {
      for (const cmd of commandsFor(text, key, cur, deriveView(s, cur))) {
        if (cmd.kind === "ui") cur = reduce(cur, cmd.action, deriveView(s, cur), rows);
        else if (cmd.kind === "intent") intents.push(cmd.intent);
        else quit = true;
      }
    };
    const chars = [...input];
    if (inPrompt(cur) || chars.length <= 1 || key.ctrl || key.meta) run(input);
    else {
      for (let i = 0; i < chars.length && !quit; i++) {
        // A key that opened a prompt hands the rest of the chunk to it as text.
        if (inPrompt(cur)) {
          run(chars.slice(i).join(""));
          break;
        }
        run(chars[i]!);
      }
    }
    commit(cur);
    if (quit) return exit();
    for (const intent of intents) runIntent(intent);
  };

  useInput(handle);
  // Bracketed paste keeps pasted text out of the command keys; outside a prompt there is nowhere for it to go.
  usePaste((text) => {
    if (inPrompt(uiRef.current)) handle(text, NO_KEY);
  });

  if ("tooSmall" in lay) {
    return (
      <Text>
        Atrium needs at least 80×24. This window is {cols}×{height}.
      </Text>
    );
  }
  if (!state) {
    if (online) return <Text color={color.muted}>Connecting to Atrium…</Text>;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={color.bad}>Can't reach the Atrium engine at {client.base}.</Text>
        <Text>Start it with atrium start, or run atrium install to have it start at login.</Text>
        <Text color={color.muted}>This screen reconnects on its own. Press q to quit.</Text>
      </Box>
    );
  }

  if (!view) return null;
  const focused = (p: Ui["focus"]) => ui.focus === p;
  const filterTag = (p: keyof Ui["filters"]) => (ui.filters[p] ? ` · /${ui.filters[p]}` : "");
  const list = (p: keyof Ui["filters"]) => ({ view, ui, cols: lay.left - 2, rows: lay.heights[p] - 2, focused: focused(p) });
  const needs = view.state.approvals.length;
  const detailTitle =
    view.subject === "space" ? view.space?.name : view.subject === "task" ? view.task?.title : view.subject === "approval" ? view.approval?.title : view.activityRow ? "Activity" : undefined;

  return (
    <Box flexDirection="column" width={cols} height={height} flexShrink={0}>
      <Header state={view.state} briefing={briefing.current ?? state.briefing} cols={cols} />
      <Box>
        <Box flexDirection="column" width={lay.left} flexShrink={0}>
          <Pane n={1} title={`Spaces${filterTag("spaces")}`} focused={focused("spaces")} width={lay.left} height={lay.heights.spaces}>
            <SpacesPane {...list("spaces")} />
          </Pane>
          <Pane n={2} title={`Tasks${view.space ? ` · ${view.space.name}` : ""}${filterTag("tasks")}`} focused={focused("tasks")} width={lay.left} height={lay.heights.tasks}>
            <TasksPane {...list("tasks")} />
          </Pane>
          <Pane n={3} title={`Needs you${needs ? ` · ${needs}` : ""}${filterTag("needs")}`} focused={focused("needs")} width={lay.left} height={lay.heights.needs}>
            <NeedsPane {...list("needs")} />
          </Pane>
          <Pane n={4} title={`Activity${filterTag("activity")}`} focused={focused("activity")} width={lay.left} height={lay.heights.activity}>
            <ActivityPane {...list("activity")} />
          </Pane>
        </Box>
        <Box flexDirection="column" width={lay.right} flexShrink={0}>
          <DetailPane
            title={`Detail${detailTitle ? ` · ${detailTitle}` : ""}`}
            lines={detailLines}
            scroll={ui.detailScroll}
            focused={focused("detail")}
            width={lay.right}
            height={lay.detail}
          />
          <LivePane view={view} lines={liveLines} scroll={ui.liveScroll} focused={focused("live")} width={lay.right} height={lay.live} />
        </Box>
      </Box>
      <StatusBar state={view.state} cols={cols} hints={hints(ui, view)} flash={ui.flash} online={online} />
    </Box>
  );
}
