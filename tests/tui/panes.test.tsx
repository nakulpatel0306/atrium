import { afterEach, expect, test } from "bun:test";
import { cleanup } from "ink-testing-library";
import { fakeClient } from "./fake-client";
import { ids, makeState, task } from "./fixtures";
import { openApp } from "./harness";

afterEach(() => cleanup());

test("live pane shows cleaned output", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("[5] Live"));
  client.emitOutput(ids.liveRun, "building\x1b]52;c;Zm9v\x07 ok\nstep 2");
  const f = await app.frame((f) => f.includes("step 2"));
  expect(f).toContain("building ok");
  expect(app.frames.join("")).not.toContain("\x1b]52");
});

test("live pane follows the end and pauses when scrolled", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("[5] Live"));
  client.emitOutput(ids.liveRun, Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));
  await app.frame((f) => f.includes("line 199"));
  await app.type("5", "k", "k", "k", "k", "k");
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
  const app = openApp(fakeClient(state));
  await app.frame((f) => f.includes("[5] Live"));
  await app.type("j");
  const f = await app.frame((f) => f.includes("No agent working right now"));
  // The space row and Detail repeat the reason too; count only the Live pane, the lower right box.
  const lines = f.split("\n");
  const top = lines.findIndex((l) => l.includes("[5] Live"));
  const col = lines[top]!.indexOf("╭─[5] Live");
  const live = lines.slice(top).map((l) => l.slice(col)).join("\n");
  expect(live.split(reason).length - 1).toBe(1);
});

test("detail follows the focused pane", async () => {
  const app = openApp(fakeClient(makeState()));
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("3");
  await app.frame((f) => f.includes("[0] Detail · Review: Fix login redirect"));
  await app.type("2");
  await app.frame((f) => f.includes("[0] Detail · Add the status bar"));
});

test("the thread is fetched on open and again on change", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  const fetches = () => client.calls.filter((c) => c.path === `/api/tasks/${ids.running}/messages`).length;
  expect(fetches()).toBe(0);
  await app.type("2");
  await app.frame((f) => f.includes("[0] Detail · Add the status bar"));
  await new Promise((r) => setTimeout(r, 20));
  expect(fetches()).toBe(1);
  client.push(makeState());
  await new Promise((r) => setTimeout(r, 20));
  expect(fetches()).toBe(2);
});

test("detail scrolls with j and k", async () => {
  const state = makeState();
  state.tasks[1] = { ...state.tasks[1]!, detail: Array.from({ length: 60 }, (_, i) => `detail line ${i}`).join("\n") };
  const app = openApp(fakeClient(state));
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("2", "0");
  await app.frame((f) => f.includes("detail line 0"));
  await app.type("G");
  const f = await app.frame((f) => !f.includes("detail line 0"));
  expect(f).toContain("running");
  await app.type("g");
  await app.frame((f) => f.includes("detail line 0"));
});
