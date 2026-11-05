import { Box, type Key, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import type { State } from "../../engine/state";
import type { EngineClient } from "../client";
import { activityDetail, approvalDetail, type DetailLine, spaceDetail, taskDetail, wrapStyled } from "../detail";
import { useEngineState, useMessages, useOnline, useReviewers, useRunOutput, useTick } from "../hooks";
import { runIntent } from "../effects";
import { commandsFor, hints, type Intent } from "../keys";
import { layout } from "../layout";
import { reviewTarget } from "../../dashboard/summary";
import { deriveView, type View } from "../select";
import { clean, wrapLines } from "../text";
import { absolute } from "../../dashboard/format";
import { color } from "../theme";
import { type Action, type Flash, initialUi, reduce, type Rows, type Ui } from "../ui";
import { ActivityPane } from "./ActivityPane";
import { AgentsView, agentsLines } from "./AgentsView";
import { Confirm } from "./Confirm";
import { DetailPane } from "./DetailPane";
import { Help } from "./Help";
import { LivePane } from "./LivePane";
import { Header } from "./Header";
import { NeedsPane } from "./NeedsPane";
import { Pane } from "./Pane";
import { Picker } from "./Picker";
import { Prompt } from "./Prompt";
import { SpacesPane } from "./SpacesPane";
import { StatusBar } from "./StatusBar";
import { TasksPane } from "./TasksPane";
import { Transcript } from "./Transcript";

const NO_KEY = {} as Key;
const SETTING_UP = "Setting up your space. This usually takes under a minute.";
const inPrompt = (u: Ui) => u.overlay?.kind === "prompt";

type Size = { columns: number; rows: number };
type Fetched = { ok: true; text: string } | { ok: false; error: string };

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
  // Setting up a space takes a while; a second submit meanwhile would set up a second space.
  const settingUp = useRef(false);
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
  // Full-screen views: the header, one pane, and the status bar.
  const viewRows = height - 4;
  const fullInner = cols - 4;
  const transcript = ui.overlay?.kind === "transcript" ? ui.overlay : null;
  const transcriptRuns = transcript && state ? state.runs.filter((r) => r.taskId === transcript.taskId) : [];
  const transcriptRun = transcript ? (transcriptRuns[transcript.runIndex] ?? null) : null;
  // Fetched once per run opened; a transcript only grows while its run is live, and Live shows that.
  const fetched = useRef(new Map<string, Fetched>());
  const [, setFetchedCount] = useState(0);
  useEffect(() => {
    const id = transcriptRun?.id;
    if (!id || fetched.current.has(id)) return;
    void client.transcript(id).then((res) => {
      fetched.current.set(id, res);
      setFetchedCount(fetched.current.size);
    });
  }, [transcriptRun?.id, client]);
  const loaded = transcriptRun ? fetched.current.get(transcriptRun.id) : undefined;
  const transcriptLines = !transcriptRun
    ? []
    : !loaded
      ? ["Loading the transcript…"]
      : loaded.ok
        ? wrapLines(clean(loaded.text).replace(/\n$/, ""), fullInner)
        : [loaded.error];
  const agentLines = ui.overlay?.kind === "agents" && view ? agentsLines(view.state).flatMap((l) => wrapStyled(l, fullInner)) : [];

  const rows: Rows =
    "tooSmall" in lay
      ? { detail: 1, live: 1 }
      : { detail: lay.detail - 2, live: lay.live - 3, detailLines: detailLines.length, liveLines: liveLines.length };

  // G in a full-screen view asks for "the end"; it's pinned to the last screenful of what's loaded.
  const clampOverlay = (next: Ui): Ui => {
    const o = next.overlay;
    if (o?.kind === "transcript") return { ...next, overlay: { ...o, scroll: Math.min(o.scroll, Math.max(0, transcriptLines.length - viewRows)) } };
    if (o?.kind === "agents") return { ...next, overlay: { ...o, scroll: Math.min(o.scroll, Math.max(0, agentLines.length - viewRows)) } };
    return next;
  };
  const commit = (next: Ui) => {
    const clamped = clampOverlay(next);
    uiRef.current = clamped;
    setUi(clamped);
  };

  const dispatch = (action: Action) => {
    const s = client.state();
    if (s) commit(reduce(uiRef.current, action, deriveView(s, uiRef.current), rows));
  };
  const flash = (f: Flash) => dispatch({ type: "flash", flash: f });

  const act = async (intent: Intent) => {
    const s = client.state();
    if (!s) return;
    if (intent.type === "newSpace") {
      if (settingUp.current) return flash({ tone: "info", text: SETTING_UP });
      settingUp.current = true;
      flash({ tone: "info", text: SETTING_UP });
    }
    const out = await runIntent(client, intent, s);
    if (intent.type === "newSpace") settingUp.current = false;
    if (out.spaceId) {
      dispatch({ type: "select", pane: "spaces", id: out.spaceId });
      dispatch({ type: "focus", pane: "tasks" });
    }
    flash({ tone: out.tone, text: out.text });
  };

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
    for (const intent of intents) void act(intent);
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
      {transcript ? (
        <Transcript
          title={`Transcript · ${view.state.tasks.find((t) => t.id === transcript.taskId)?.title ?? "task"} · run ${transcript.runIndex + 1}/${transcriptRuns.length}${transcriptRun ? ` · ${absolute(transcriptRun.startedAt)}` : ""}`}
          lines={transcriptLines}
          scroll={transcript.scroll}
          width={cols}
          height={height - 2}
        />
      ) : ui.overlay?.kind === "agents" ? (
        <AgentsView lines={agentLines} scroll={ui.overlay.scroll} width={cols} height={height - 2} />
      ) : (
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
      )}
      <StatusBar state={view.state} cols={cols} hints={hints(ui, view)} flash={ui.flash} online={online} />
      {ui.overlay?.kind === "prompt" && (
        <Prompt prompt={ui.overlay} state={view.state} width={lay.right} top={height - 5} left={lay.left} />
      )}
      {ui.overlay?.kind === "picker" && (
        <Picker picker={ui.overlay} state={view.state} reviewers={reviewers} cols={cols} rows={height} />
      )}
      {ui.overlay?.kind === "help" && <Help cols={cols} rows={height} />}
      {ui.overlay?.kind === "confirm" && <Confirm confirm={ui.overlay} state={view.state} cols={cols} rows={height} />}
    </Box>
  );
}
