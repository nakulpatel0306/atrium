import { afterEach, expect, test } from "bun:test";
import { cleanup } from "ink-testing-library";
import { fakeClient } from "./fake-client";
import { ids, makeState, task } from "./fixtures";
import { KEY, openApp } from "./harness";

// Opens the app on the Spaces tab.
async function onSpaces(client: ReturnType<typeof fakeClient>) {
  const app = openApp(client);
  await app.frame((f) => f.includes("1 Home"));
  await app.type("2");
  await app.frame((f) => f.includes("SPACES"));
  return app;
}

afterEach(() => cleanup());

test("live pane shows cleaned output", async () => {
  const client = fakeClient(makeState());
  const app = await onSpaces(client);
  client.emitOutput(ids.liveRun, "building\x1b]52;c;Zm9v\x07 ok\nstep 2");
  const f = await app.frame((f) => f.includes("step 2"));
  expect(f).toContain("building ok");
  expect(app.frames.join("")).not.toContain("\x1b]52");
});

test("live pane follows the end and pauses when scrolled", async () => {
  const client = fakeClient(makeState());
  const app = await onSpaces(client);
  client.emitOutput(ids.liveRun, Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));
  await app.frame((f) => f.includes("line 199"));
  await app.type(KEY.tab, KEY.tab, KEY.tab, "k", "k", "k", "k", "k");
  const paused = await app.frame((f) => f.includes("paused, G to follow"));
  expect(paused).not.toContain("line 199");
  await app.type("G");
  const back = await app.frame((f) => f.includes("line 199"));
  expect(back).not.toContain("paused");
});

test("idle live pane lists distinct waits", async () => {
  const state = makeState();
  const reason = "Codex is limited until 9:00 PM.";
  state.tasks.push(task({ id: "t_a", spaceId: ids.jobHunt, title: "A" }), task({ id: "t_b", spaceId: ids.jobHunt, title: "B" }));
  state.waits.t_a = { taskId: "t_a", agent: "codex", kind: "limited", reason };
  state.waits.t_b = { taskId: "t_b", agent: "codex", kind: "limited", reason };
  const app = await onSpaces(fakeClient(state));
  await app.type("j");
  const f = await app.frame((f) => f.includes("No agent working here right now"));
  // The space row and Detail repeat the reason too; count only the Live part, below its rule on the right.
  const lines = f.split("\n");
  const top = lines.findIndex((l) => l.includes("─ LIVE "));
  const col = lines[top]!.indexOf("─ LIVE");
  const live = lines.slice(top).map((l) => l.slice(col)).join("\n");
  expect(live.split(reason).length - 1).toBe(1);
});

test("detail follows the focused pane", async () => {
  const app = await onSpaces(fakeClient(makeState()));
  await app.frame((f) => f.includes("SPACE  atrium"));
  await app.type(KEY.tab);
  await app.frame((f) => f.includes("TASK  Add the status bar"));
  await app.type("j");
  await app.frame((f) => f.includes("TASK  Fix login redirect"));
});

test("the thread is fetched on open and again on change", async () => {
  const client = fakeClient(makeState());
  const app = await onSpaces(client);
  const fetches = () => client.calls.filter((c) => c.path === `/api/tasks/${ids.running}/messages`).length;
  expect(fetches()).toBe(0);
  await app.type(KEY.tab);
  await app.frame((f) => f.includes("TASK  Add the status bar"));
  await new Promise((r) => setTimeout(r, 20));
  expect(fetches()).toBe(1);
  client.push(makeState());
  await new Promise((r) => setTimeout(r, 20));
  expect(fetches()).toBe(2);
});

test("detail scrolls with j and k", async () => {
  const state = makeState();
  state.tasks[1] = { ...state.tasks[1]!, detail: Array.from({ length: 60 }, (_, i) => `detail line ${i}`).join("\n") };
  const app = await onSpaces(fakeClient(state));
  await app.type(KEY.tab, "l");
  await app.frame((f) => f.includes("detail line 0"));
  await app.type("G");
  const f = await app.frame((f) => !f.includes("detail line 0"));
  expect(f).toContain("running");
  await app.type("g");
  await app.frame((f) => f.includes("detail line 0"));
});

test("an Atrium-wide repo question shows as Atrium's and approves with a", async () => {
  const state = makeState();
  state.approvals.unshift({
    ...state.approvals[0]!, id: "apr_repo", spaceId: null, taskId: null, kind: "question", alwaysAsk: "create_repo",
    title: 'Create GitHub repo "demo"?', detail: "Name: demo\nVisibility: Private", createdAt: Date.now(),
  });
  state.repoActions = [{ id: "rpa_1", approvalId: "apr_repo", kind: "create", draft: { name: "demo", description: "d", visibility: "private", template: "bun-ts" }, path: "/p/demo", folderTaken: false, github: null, pickedUp: false, bytes: null }];
  const client = fakeClient(state);
  const app = openApp(client);
  await app.frame((f) => f.includes('? Create GitHub repo "demo"?') && /Atrium\s+·\s+asks you/.test(f));
  await app.type(KEY.enter);
  await app.frame((f) => f.includes("Edit the fields in the dashboard. a approves them as shown."));
  await app.type("a");
  await app.frame(() => client.calls.some((c) => c.method === "POST" && c.path === "/api/approvals/apr_repo"));
  expect(client.calls).toContainEqual({ method: "POST", path: "/api/approvals/apr_repo", body: { decision: "approve" } });
});

test("the detail scrolls to keep a picked file in view", async () => {
  const { spacesScreen } = await import("../../src/tui/screens/spaces");
  const { deriveView } = await import("../../src/tui/select");
  const { initialUi } = await import("../../src/tui/ui");
  const state = makeState();
  const detail = Array.from({ length: 60 }, (_, i) => [{ text: i === 50 ? "▸ week.ics  new" : `line ${i}` }]);
  const text = (ui: typeof initialUi) => spacesScreen(deriveView(state, ui), ui, { detail, live: [], frame: 0, now: Date.now() }, 120, 30, 2).lines.map((l) => l.map((s) => s.text).join("")).join("\n");
  const base = { ...initialUi, tab: "spaces" as const, focus: "detail" as const, lastLeft: "tasks" as const };
  expect(text({ ...base, detailFile: 1 })).toContain("▸ week.ics");
  expect(text(base)).not.toContain("▸ week.ics");
});
