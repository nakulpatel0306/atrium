import { expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { requestStop, STOP_START, StopButtons, type StopState, StopTask, stopReducer } from "../../src/dashboard/components/StopTask";
import { ids, makeState } from "../tui/fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const running = () => makeState().tasks.find((t) => t.id === ids.running)!;

// The dashboard tests have no DOM, so a press is the button's own onClick, found in the element tree StopButtons
// returns.
function press(tree: ReactNode, label: string) {
  const buttons: ReactElement<{ onClick?: () => void; children?: ReactNode }>[] = [];
  const walk = (n: ReactNode) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const el = n as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
    if (el.type === "button") buttons.push(el);
    walk(el.props?.children);
  };
  walk(tree);
  const button = buttons.find((b) => text(renderToStaticMarkup(b)) === label);
  if (!button) throw new Error(`no ${label} button`);
  button.props.onClick?.();
}

test("a running task offers Stop; nothing else does", () => {
  const s = makeState();
  expect(text(renderToStaticMarkup(<StopTask task={running()} />))).toBe("Stop…");
  for (const t of s.tasks.filter((x) => x.status !== "running")) expect(renderToStaticMarkup(<StopTask task={t} />)).toBe("");
});

test("Stop… then Stop sends the stop for that task; Keep running backs out", async () => {
  let state: StopState = STOP_START;
  const sent: string[] = [];
  const view = () =>
    StopButtons({
      state,
      onAsk: () => (state = stopReducer(state, { type: "ask" })),
      onCancel: () => (state = stopReducer(state, { type: "cancel" })),
      onStop: () => void requestStop(running(), async (path) => (sent.push(path), { ok: true, data: { ...running(), status: "blocked" } })),
    });
  press(view(), "Stop…");
  expect(state.asking).toBe(true);
  expect(text(renderToStaticMarkup(view()))).toContain("Stop the agent now? Its edits so far are kept.");
  press(view(), "Keep running");
  expect(state.asking).toBe(false);
  expect(sent).toEqual([]);
  press(view(), "Stop…");
  press(view(), "Stop");
  await Promise.resolve();
  expect(sent).toEqual([`/api/tasks/${ids.running}/stop`]);
});

test("the toast says what the stop actually did", async () => {
  const t = running();
  const reply = (status: string) => async () => ({ ok: true as const, data: { ...t, status: status as typeof t.status } });
  expect(await requestStop(t, reply("blocked"))).toEqual({ toast: 'Stopped "Add the status bar". Retry it when you\'re ready.' });
  expect(await requestStop(t, reply("running"))).toEqual({ toast: `Stopping "Add the status bar": the agent hasn't exited yet. Atrium marks it stopped when it does.` });
  expect(await requestStop(t, async () => ({ ok: false as const, error: "It finished before it could be stopped, so its result stands." }))).toEqual({
    error: "It finished before it could be stopped, so its result stands.",
  });
});

test("the confirm closes once the task stops running, so a retried task never comes back with it open", () => {
  const open = stopReducer(STOP_START, { type: "ask" });
  expect(stopReducer(open, { type: "notRunning" })).toEqual({ asking: false, busy: false, error: null });
  expect(stopReducer(STOP_START, { type: "notRunning" })).toBe(STOP_START);
});
