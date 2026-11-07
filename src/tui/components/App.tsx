import { Box, type Key, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { reviewTarget } from "../../dashboard/summary";
import type { Alert } from "../../engine/markets/alerts";
import type { GlanceView, PortfolioView } from "../../engine/markets/views";
import type { State } from "../../engine/state";
import type { Click, Hit } from "../canvas";
import type { EngineClient } from "../client";
import { type DetailLine, spaceDetail, taskDetail, wrapStyled } from "../detail";
import { runIntent, sendFollowUp } from "../effects";
import { useDeletePreview, useEngineRead, useEngineState, useMarketsGlance, useMessages, useOnline, useOutputs, useReviewers, useRunOutput, useTick, useTranscript } from "../hooks";
import { commandsFor, type Intent, type KeyContext } from "../keys";
import type { MouseBus, MouseEvent } from "../mouse";
import { deriveView, type View } from "../select";
import { clean, wrapLines } from "../text";
import { type Action, type Flash, initialUi, listPaneOf, pin, reduce, type Ui } from "../ui";
import { bodyRows, compose, detailWidth, fullCount, rowsFor, transcriptTitle } from "../screens/compose";
import { thisMonth } from "../screens/format";
import { investKeys } from "../screens/investing";
import { type MoneyPage, moneyCategories } from "../screens/money";
import { Screen } from "./Screen";

const NO_KEY = {} as Key;
const SETTING_UP = "Setting up your space. This usually takes under a minute.";
const MIN_COLS = 80;
const MIN_ROWS = 24;
// A spinner frame costs Ink a full redraw (about 40 ms of CPU), so it turns once a second: enough to show something
// is alive without keeping a laptop's core busy for the length of a run.
const SPIN_MS = 1000;
const inBox = (u: Ui) => (u.ask !== null && !u.overlay) || u.overlay?.kind === "delete";

type Size = { columns: number; rows: number };

// Cleaning and wrapping a long transcript is the costly part of a frame, so it's done once per text and width,
// not on every keypress.
function useWrapped(text: string, cols: number): string[] {
  return useMemo(() => (text ? wrapLines(clean(text).replace(/\n$/, ""), cols) : []), [text, cols]);
}

// The agent thread a subject needs: a work task's own, or an approval's once its review has finished.
function threadOf(view: View): string | null {
  if (view.subject === "task") return view.task?.kind === "work" ? view.task.id : null;
  if (view.subject === "approval" && view.approval) return reviewTarget(view.approval, view.state);
  return null;
}

// The key a click on a key cap stands for, as Ink would have parsed it.
function keyOf(input: string): Key {
  return { ...NO_KEY, return: input === "\r", escape: input === "\x1b", tab: input === "\t" } as Key;
}

const hitAt = (hits: Hit[], x: number, y: number) => [...hits].reverse().find((h) => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h);

export function App({ client, size, mouse }: { client: EngineClient; size?: Size; mouse?: MouseBus }) {
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
  // A text that's on its way, so the Ask box can say when it went (or didn't).
  const sending = useRef<{ toName: string; at: number } | null>(null);
  if (state && !briefing.current) briefing.current = state.briefing;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!state || seen.current) return;
    seen.current = true;
    void client.post("/api/seen");
  }, [state, client]);

  // Each list's selection is pinned to a row id as soon as it shows one, so a row arriving later can't slide
  // under the cursor before the next key.
  useEffect(() => {
    if (!state) return;
    const pinnedUi = pin(uiRef.current, deriveView(state, uiRef.current));
    if (pinnedUi !== uiRef.current) {
      uiRef.current = pinnedUi;
      setUi(pinnedUi);
    }
  }, [state, ui]);

  const running = state?.tasks.some((t) => t.status === "running") ?? false;
  // Only Home and Spaces draw a spinner, and not under a full view.
  const spinning = running && (ui.tab === "home" || ui.tab === "spaces") && !["transcript", "agents", "detail"].includes(ui.overlay?.kind ?? "");
  useTick(60_000, true);
  useEffect(() => {
    if (!spinning) return;
    const id = setInterval(() => setFrame((n) => n + 1), SPIN_MS);
    return () => clearInterval(id);
  }, [spinning]);

  // The spinner redraws four times a second with nothing else changed; the view (activity grouping and all) is kept.
  const view = useMemo(() => (state ? deriveView(state, ui) : null), [state, ui]);
  const investSpace = state?.spaces.find((s) => s.kind === "markets") ?? null;
  const base = investSpace ? `/api/investing/${encodeURIComponent(investSpace.id)}` : null;
  const tab = ui.tab;
  const money = useEngineRead<MoneyPage>(client, base && (tab === "money" || tab === "home") ? `${base}/money?month=${tab === "home" ? thisMonth() : (ui.money.month ?? "")}` : null);
  const glance = useMarketsGlance(client, investSpace && (tab === "home" || tab === "investing") ? investSpace : null) as GlanceView | null;
  const portfolio = useEngineRead<PortfolioView>(client, base && tab === "investing" ? `${base}/portfolio` : null);
  const markets = useEngineRead<{ alerts: Alert[] }>(client, investSpace && tab === "investing" ? `/api/markets/${encodeURIComponent(investSpace.id)}` : null);
  const invest = { portfolio, glance, alerts: markets?.alerts ?? null };
  const messages = useMessages(client, view && (tab === "spaces" || tab === "home") ? threadOf(view) : null);
  const reviewers = useReviewers(client, view && tab === "spaces" && view.subject === "space" && view.space?.kind === "repo" ? view.space : null);
  const spaceGlance = useMarketsGlance(client, view && tab === "spaces" && view.subject === "space" && view.space?.kind === "markets" ? view.space : null);
  const outputs = useOutputs(client, view && tab === "spaces" && view.subject === "task" ? (view.task?.id ?? null) : null);
  const madeFiles = outputs?.files ?? [];
  const deletePreview = useDeletePreview(client, ui.overlay?.kind === "delete" ? ui.overlay.spaceId : null);
  // Live output is read only where it's drawn: the Spaces tab, and Home's Running line.
  const fullScreen = ui.overlay?.kind === "transcript" || ui.overlay?.kind === "agents" || ui.overlay?.kind === "detail";
  const homeRun = state?.runs.find((r) => r.endedAt === null && state.tasks.some((t) => t.id === r.taskId && t.status === "running")) ?? null;
  const liveRunId = fullScreen ? null : tab === "spaces" ? (view?.live?.run.id ?? null) : tab === "home" ? (homeRun?.id ?? null) : null;
  const output = useRunOutput(client, liveRunId);
  const dWidth = detailWidth(cols);
  const detail: DetailLine[] =
    view && tab === "spaces"
      ? (view.subject === "task" ? taskDetail(view, messages, outputs, ui.detailFile, dWidth) : spaceDetail(view, reviewers, spaceGlance)).flatMap((l) => wrapStyled(l, dWidth))
      : [];
  const live = useWrapped(tab === "spaces" ? output : "", dWidth);
  const lastLine = tab === "home" ? (output.trimEnd().split("\n").at(-1) ?? "") : "";
  const transcript = ui.overlay?.kind === "transcript" ? ui.overlay : null;
  const transcriptRuns = transcript && state ? state.runs.filter((r) => r.taskId === transcript.taskId) : [];
  const transcriptRun = transcript ? (transcriptRuns[transcript.runIndex] ?? null) : null;
  const loaded = useTranscript(client, transcriptRun);
  const wrappedTranscript = useWrapped(loaded?.ok ? loaded.text : "", cols - 4);
  const transcriptLines = !transcriptRun ? [] : !loaded ? ["Loading the transcript…"] : loaded.ok ? wrappedTranscript : [loaded.error];

  const ctx: KeyContext = {
    files: madeFiles,
    money: investSpace ? { spaceId: investSpace.id, month: money?.month ?? null, months: money?.months ?? [], categories: money ? moneyCategories(money).map((c) => c.category) : [] } : null,
    invest: investSpace ? { spaceId: investSpace.id, keys: investKeys(invest) } : null,
  };
  const now = Date.now();
  const f = view
    ? {
        view,
        ui,
        online,
        cols,
        rows: height,
        ctx,
        investing: !!investSpace,
        home: { glance, money, investing: !!investSpace, lastLine, frame, now, briefing: briefing.current ?? view.state.briefing },
        money,
        invest,
        detail,
        live,
        transcript: {
          title: transcript ? transcriptTitle(view.state.tasks.find((t) => t.id === transcript.taskId)?.title ?? "task", transcript.runIndex, transcriptRuns.length, transcriptRun?.startedAt ?? null) : "",
          lines: transcriptLines,
        },
        messages,
        reviewers,
        deletePreview,
        frame,
        now,
      }
    : null;
  const rows = f ? rowsFor(f) : { detail: 1, live: 1 };
  const screen = f && cols >= MIN_COLS && height >= MIN_ROWS ? compose(f) : null;
  const hitsRef = useRef<Hit[]>([]);
  hitsRef.current = screen?.hits ?? [];

  // G in a full view asks for "the end"; it's pinned to the last screenful of what's loaded.
  const clampOverlay = (next: Ui): Ui => {
    const o = next.overlay;
    if (!f || !(o?.kind === "transcript" || o?.kind === "agents" || o?.kind === "detail")) return next;
    const total = fullCount({ ...f, ui: next });
    return { ...next, overlay: { ...o, scroll: Math.min(o.scroll, Math.max(0, total - (bodyRows(height) - 2))) } };
  };
  const commit = (next: Ui) => {
    const s = client.state();
    const clamped = clampOverlay(s ? pin(next, deriveView(s, next)) : next);
    uiRef.current = clamped;
    setUi(clamped);
  };

  const dispatch = (action: Action) => {
    const s = client.state();
    if (s) commit(reduce(uiRef.current, action, deriveView(s, uiRef.current), rows));
  };
  const flash = (fl: Flash) => dispatch({ type: "flash", flash: fl });

  const act = async (intent: Intent) => {
    const s = client.state();
    if (!s) return;
    if (intent.type === "newSpace") {
      if (settingUp.current) return flash({ tone: "info", text: SETTING_UP });
      settingUp.current = true;
      flash({ tone: "info", text: SETTING_UP });
    }
    const started = Date.now();
    const out = await runIntent(client, intent, s);
    if (intent.type === "newSpace") settingUp.current = false;
    // A decided item leaves the list; the next one is picked deliberately, never slid into.
    if (["approve", "reject", "answer", "dismissNudge"].includes(intent.type) && out.tone === "ok") dispatch({ type: "unpin", pane: "needs" });
    if (out.spaceId) {
      dispatch({ type: "select", pane: "spaces", id: out.spaceId });
      dispatch({ type: "focus", pane: "tasks" });
    }
    if (out.overlay) dispatch({ type: "open", overlay: out.overlay });
    flash({ tone: out.tone, text: out.text });
    if (intent.type === "send_message" && out.tone === "ok") {
      sending.current = { toName: intent.toName, at: started };
      // The send can finish before this request does; then no later push would bring the news.
      const latest = client.state();
      const done = latest ? sendFollowUp(latest, sending.current) : null;
      if (done) {
        sending.current = null;
        flash(done);
      }
    }
  };

  useEffect(() => {
    if (!state || !sending.current) return;
    const next = sendFollowUp(state, sending.current);
    if (!next) return;
    sending.current = null;
    flash(next);
  }, [state]);

  const handle = (input: string, key: Key) => {
    const s = client.state();
    if (!s) {
      if (input === "q") exit();
      return;
    }
    let cur = pin(uiRef.current, deriveView(s, uiRef.current));
    const intents: Intent[] = [];
    let quit = false;
    const run = (text: string) => {
      for (const cmd of commandsFor(text, key, cur, deriveView(s, cur), ctx)) {
        if (cmd.kind === "ui") cur = reduce(cur, cmd.action, deriveView(s, cur), rows);
        else if (cmd.kind === "intent") intents.push(cmd.intent);
        else quit = true;
      }
    };
    const chars = [...input];
    if (inBox(cur) || chars.length <= 1 || key.ctrl || key.meta) run(input);
    else {
      for (let i = 0; i < chars.length && !quit; i++) {
        // A key that opened the Ask box hands the rest of the chunk to it as text.
        if (inBox(cur)) {
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

  // A click does what the region it lands on says: switch tab, pick a row, focus a pane, or press a key.
  const click = (c: Click) => {
    const s = client.state();
    if (!s) return;
    const actions: Action[] = [];
    if (uiRef.current.ask && !c.ask && !c.input) actions.push({ type: "ask", ask: null });
    if (c.tab !== undefined) actions.push({ type: "tab", tab: (["home", "spaces", "money", "investing", "activity"] as const)[c.tab]! });
    if (c.select) actions.push({ type: "select", pane: c.select.pane, id: c.select.id });
    if (c.focus) actions.push({ type: "focus", pane: c.focus });
    if (c.row) actions.push({ type: "row", list: c.row.list, index: c.row.index });
    if (c.ask && !uiRef.current.ask && !uiRef.current.overlay) actions.push({ type: "ask", ask: { purpose: "ask", value: "", cursor: 0, agent: "auto", targetId: null } });
    let cur = uiRef.current;
    for (const a of actions) cur = reduce(cur, a, deriveView(s, cur), rows);
    commit(cur);
    if (c.input !== undefined) handle(c.input, keyOf(c.input));
  };

  const onMouse = (e: MouseEvent) => {
    const hit = hitAt(hitsRef.current, e.x, e.y);
    if (e.kind === "click") return hit && click(hit.click);
    if (uiRef.current.overlay && uiRef.current.overlay.kind !== "transcript" && uiRef.current.overlay.kind !== "agents" && uiRef.current.overlay.kind !== "detail") return;
    if (hit?.wheel && hit.click.focus && listPaneOf(uiRef.current) !== hit.click.focus) click({ focus: hit.click.focus });
    if (hit?.wheel === "detail" || hit?.wheel === "live") click({ focus: hit.wheel });
    const step = hit?.wheel === "list" || !hit?.wheel ? 1 : 3;
    const input = e.dir > 0 ? "j" : "k";
    for (let i = 0; i < step; i++) handle(input, NO_KEY);
  };
  const mouseRef = useRef(onMouse);
  mouseRef.current = onMouse;
  useEffect(() => mouse?.subscribe((e) => mouseRef.current(e)), [mouse]);

  useInput(handle);
  // Bracketed paste keeps pasted text out of the command keys; outside a box there is nowhere for it to go.
  usePaste((text) => {
    if (inBox(uiRef.current)) handle(text, NO_KEY);
  });

  if (cols < MIN_COLS || height < MIN_ROWS) {
    return (
      <Text>
        Atrium needs at least 80×24. This window is {cols}×{height}.
      </Text>
    );
  }
  if (!state) {
    if (online) return <Text>Connecting to Atrium…</Text>;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Can't reach the Atrium engine at {client.base}.</Text>
        <Text>Start it with atrium start, or run atrium install to have it start at login.</Text>
        <Text>This screen reconnects on its own. Press q to quit.</Text>
      </Box>
    );
  }
  if (!screen) return null;
  return <Screen lines={screen.lines} />;
}

