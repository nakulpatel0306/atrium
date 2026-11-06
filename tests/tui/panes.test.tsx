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

test("a markets space and its price alert show up and can be answered", async () => {
  const state = makeState();
  state.spaces.unshift({ ...state.spaces[0]!, id: "spc_markets", name: "Stocks", kind: "markets", private: true, repoPath: null, goal: "Watch", reviewBy: null });
  state.approvals.unshift({ ...state.approvals[0]!, id: "apr_alert", spaceId: "spc_markets", kind: "alert", taskId: null, title: "AAPL price above $200.00", createdAt: Date.now() });
  const client = fakeClient(state);
  const glance = { portfolio: null, lists: [{ name: "Holdings", rows: [{ key: "AAPL", price: 201, ccy: "USD", dayPct: 1.2, tag: null }] }], earnings: [], advanced: false, paper: null };
  client.respond("/api/investing/spc_markets/glance", { ok: true, data: glance });
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces") && f.includes("Stocks"));
  await app.frame((f) => f.includes("US$201.00") && f.includes("Open the app for the chart."));
  expect(client.calls).toContainEqual({ method: "GET", path: "/api/investing/spc_markets/glance" });
  await app.type("3");
  await app.frame((f) => f.includes("AAPL price above $200.00") && f.includes("a dismiss"));
  await app.type("r");
  await app.frame((f) => f.includes("Price alerts are dismissed with a"));
  await app.type("a");
  await app.frame(() => client.calls.some((c) => c.method === "POST" && c.path === "/api/approvals/apr_alert"));
  expect(client.calls).toContainEqual({ method: "POST", path: "/api/approvals/apr_alert", body: { decision: "approve" } });
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
  await app.type("3");
  await app.frame((f) => /Atrium\s+Create GitHub repo "demo"\?/.test(f) && f.includes("Edit the fields in the dashboard. a approves them as shown."));
  await app.type("a");
  await app.frame(() => client.calls.some((c) => c.method === "POST" && c.path === "/api/approvals/apr_repo"));
  expect(client.calls).toContainEqual({ method: "POST", path: "/api/approvals/apr_repo", body: { decision: "approve" } });
});

test("the detail pane scrolls to keep a picked file in view", async () => {
  const { render } = await import("ink-testing-library");
  const { DetailPane } = await import("../../src/tui/components/DetailPane");
  const lines = Array.from({ length: 60 }, (_, i) => [{ text: i === 50 ? "▸ week.ics  new" : `line ${i}` }]);
  const { lastFrame } = render(<DetailPane title="Detail" lines={lines} scroll={0} focusLine={50} focused width={60} height={12} />);
  expect(lastFrame()).toContain("▸ week.ics");
  const plain = render(<DetailPane title="Detail" lines={lines} scroll={0} focused width={60} height={12} />);
  expect(plain.lastFrame()).not.toContain("▸ week.ics");
});
