import { afterEach, expect, test } from "bun:test";
import { cleanup } from "ink-testing-library";
import type { State } from "../../src/engine/state";
import { fakeClient } from "./fake-client";
import { ids, makeState } from "./fixtures";
import { openApp } from "./harness";

afterEach(() => cleanup());

// The review task gets a second, older run so [ and ] have somewhere to go.
function twoRuns(): State {
  const state = makeState();
  const older = { ...state.runs[1]!, id: "run_old", startedAt: state.runs[1]!.startedAt - 3600_000, endedAt: state.runs[1]!.endedAt! - 3600_000, exitCode: 1 };
  return { ...state, runs: [...state.runs, older] };
}
const onReview = ["2", "j"];

test("t opens the latest transcript and [ ] switch runs", async () => {
  const client = fakeClient(twoRuns());
  client.respond(`/api/runs/${ids.reviewRun}/transcript`, { ok: true, data: "run B text" });
  client.respond("/api/runs/run_old/transcript", { ok: true, data: "run A text" });
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type(...onReview, "t");
  let f = await app.frame((f) => f.includes("run B text"));
  expect(f).toContain("Transcript · Fix login redirect · run 1/2");
  await app.type("[");
  f = await app.frame((f) => f.includes("run A text"));
  expect(f).toContain("run 2/2");
  await app.type("]");
  await app.frame((f) => f.includes("run B text"));
  const fetched = (id: string) => client.calls.filter((c) => c.path === `/api/runs/${id}/transcript`).length;
  expect(fetched(ids.reviewRun)).toBe(1);
  expect(fetched("run_old")).toBe(1);
  await app.type("q");
  await app.frame((f) => f.includes("[1] Spaces"));
});

test("a missing transcript reads plainly", async () => {
  const client = fakeClient(makeState());
  client.respond(`/api/runs/${ids.reviewRun}/transcript`, {
    ok: false,
    error: "This transcript isn't stored anymore. Atrium keeps the newest 200 MB of transcripts.",
  });
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type(...onReview, "t");
  await app.frame((f) => f.includes("This transcript isn't stored anymore."));
});

test("transcript text is cleaned", async () => {
  const client = fakeClient(makeState());
  client.respond(`/api/runs/${ids.reviewRun}/transcript`, { ok: true, data: "start\x1b[2J\x1b]0;title\x07 end" });
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type(...onReview, "t");
  await app.frame((f) => f.includes("start end"));
  const out = app.frames.join("");
  expect(out).not.toContain("\x1b[2J");
  expect(out).not.toContain("\x1b]0;");
});

test("the transcript scrolls", async () => {
  const client = fakeClient(makeState());
  client.respond(`/api/runs/${ids.reviewRun}/transcript`, { ok: true, data: Array.from({ length: 100 }, (_, i) => `tline ${i}`).join("\n") });
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type(...onReview, "t");
  await app.frame((f) => f.includes("tline 0"));
  await app.type("G");
  await app.frame((f) => f.includes("tline 99"));
  await app.type("k");
  await app.frame((f) => !f.includes("tline 99"));
  await app.type("g");
  await app.frame((f) => f.includes("tline 0"));
});

test("help lists every key", async () => {
  const app = openApp(fakeClient(makeState()));
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("?");
  const f = await app.frame((f) => f.includes("send back"));
  for (const s of ["approve", "send back", "run now", "transcript", "agents and usage", "new task", "new space"]) expect(f).toContain(s);
  await app.type("?");
  await app.frame((f) => !f.includes("agents and usage"));
});

test("agents view shows status and the window", async () => {
  const state = makeState();
  state.agents.codex = { ...state.agents.codex!, installed: false, detail: "Install it with npm i -g @openai/codex." };
  const app = openApp(fakeClient(state));
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("u");
  const f = await app.frame((f) => f.includes("Pause Claude tasks at"));
  for (const s of ["Claude", "Ready", "41%", "tokens today", "Atrium disk usage", "Not installed.", "[50%]"]) expect(f).toContain(s);
  await app.type("q");
  await app.frame((f) => f.includes("[1] Spaces"));
});

test("reserve steps from the agents view", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("u", "]");
  await app.frame((f) => f.includes("Claude tasks now pause at 75% of the window."));
  expect(client.calls.filter((c) => c.path === "/api/settings")).toEqual([{ method: "POST", path: "/api/settings", body: { claudeReserve: 0.75 } }]);

  const high = fakeClient(makeState({ usage: { claudeTokens24h: 0, claudeReserve: 0.75 } }));
  const app2 = openApp(high);
  await app2.frame((f) => f.includes("[1] Spaces"));
  await app2.type("u", "]");
  await app2.frame((f) => f.includes("75% is the highest pause point."));
  expect(high.calls.filter((c) => c.path === "/api/settings")).toEqual([]);
});

test("o toggles overnight from anywhere", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("o");
  await app.frame((f) => f.includes("Overnight mode on."));
  await app.type("u", "o");
  await new Promise((r) => setTimeout(r, 30));
  expect(client.calls.filter((c) => c.path === "/api/settings").map((c) => c.body)).toEqual([{ overnight: true }, { overnight: true }]);
});
