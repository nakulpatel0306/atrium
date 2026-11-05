import { afterEach, expect, test } from "bun:test";
import { cleanup } from "ink-testing-library";
import { type FakeClient, fakeClient } from "./fake-client";
import { ids, makeState } from "./fixtures";
import { KEY, openApp } from "./harness";

afterEach(() => cleanup());

const settle = () => new Promise((r) => setTimeout(r, 30));
const mutations = (calls: FakeClient["calls"]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/seen");

test("approving from Needs you", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("3", "a");
  await app.frame((f) => f.includes('Approved "'));
  expect(mutations(client.calls)).toEqual([{ method: "POST", path: `/api/approvals/${ids.approval}`, body: { decision: "approve" } }]);
});

test("approving something already decided says so plainly", async () => {
  const client = fakeClient(makeState());
  client.respond(`/api/approvals/${ids.approval}`, { ok: false, error: "Already handled" });
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("3", "a");
  await app.frame((f) => f.includes("Already handled. It was decided somewhere else."));
});

test("send back with a note", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("3", "r");
  await app.frame((f) => f.includes("Send back · what should change?"));
  await app.type("tighten the tests", KEY.enter);
  await app.frame((f) => f.includes("Sent back with your note."));
  expect(app.lastFrame()).not.toContain("what should change?");
  expect(mutations(client.calls)).toEqual([
    { method: "POST", path: `/api/approvals/${ids.approval}`, body: { decision: "reject", note: "tighten the tests" } },
  ]);
});

test("new task with a picked agent", async () => {
  const client = fakeClient(makeState());
  client.respond("/api/command", { ok: true, data: { task: { title: "Add a README" } } });
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("n");
  await app.frame((f) => f.includes("New task in atrium · agent: Auto (tab)"));
  await app.type("Add a README", KEY.tab);
  await app.frame((f) => f.includes("agent: Claude (tab)"));
  await app.type(KEY.enter);
  await app.frame((f) => f.includes('Queued "Add a README" in atrium for Claude.'));
  expect(mutations(client.calls)).toEqual([
    { method: "POST", path: "/api/command", body: { text: "Add a README", spaceId: ids.atrium, agent: "claude" } },
  ]);
});

test("change a queued task's agent", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("2", "j", "j", "A");
  await app.frame((f) => f.includes("Agent for Add tests"));
  await app.type("j", KEY.enter);
  await app.frame((f) => f.includes('Claude will take "Add tests".'));
  expect(mutations(client.calls)).toEqual([{ method: "PATCH", path: `/api/tasks/${ids.queued}`, body: { agent: "claude" } }]);
});

test("archive asks first", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("1", "X");
  await app.frame((f) => f.includes("Archive atrium?"));
  await app.type("n");
  await app.frame((f) => !f.includes("Archive atrium?"));
  await settle();
  expect(mutations(client.calls)).toEqual([]);
  await app.type("X", "y");
  await app.frame((f) => f.includes("Archived atrium."));
  expect(mutations(client.calls)).toEqual([{ method: "PATCH", path: `/api/spaces/${ids.atrium}`, body: { status: "archived" } }]);
});

test("keys typed into a prompt aren't commands", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("n", "q");
  const f = await app.frame((f) => f.includes("New task in atrium"));
  expect(f).toMatch(/> q/);
  await settle();
  expect(mutations(client.calls)).toEqual([]);
});

test("a new space is set up once and then selected", async () => {
  const client = fakeClient(makeState());
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const post = client.post;
  client.post = async (path, body) => {
    if (path === "/api/command") await gate;
    return post(path, body);
  };
  client.respond("/api/command", { ok: true, data: { space: { id: ids.jobHunt, name: "job hunt" }, tasks: [] } });
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("N", "job hunt", KEY.enter);
  await app.frame((f) => f.includes("Setting up your space. This usually takes under a minute."));
  await app.type("N", "again", KEY.enter);
  release();
  await app.frame((f) => f.includes("Set up job hunt."));
  expect(app.lastFrame()).toContain("[2] Tasks · job hunt");
  expect(client.calls.filter((c) => c.path === "/api/command")).toHaveLength(1);
});

test("a new approval arriving never changes what a approves", async () => {
  const state = makeState();
  const client = fakeClient(state);
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("3");
  await app.frame((f) => f.includes("[0] Detail · Review: Fix login redirect"));
  const fresh = { ...state.approvals[0]!, id: "apr_new", title: "Review: Something newer", createdAt: Date.now() };
  client.push({ ...state, approvals: [fresh, ...state.approvals] });
  await app.frame((f) => f.includes("Something newer"));
  await app.type("a");
  await app.frame((f) => f.includes("Approved"));
  expect(mutations(client.calls)).toEqual([{ method: "POST", path: `/api/approvals/${ids.approval}`, body: { decision: "approve" } }]);
});

test("after a decision nothing is selected until you pick a row", async () => {
  const state = makeState();
  const second = { ...state.approvals[0]!, id: "apr_two", title: "Review: Second thing", createdAt: Date.now() - 600_000 };
  const client = fakeClient({ ...state, approvals: [state.approvals[0]!, second] });
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("3", "a");
  await app.frame((f) => f.includes("Approved"));
  // The engine drops the decided approval; the one that slides into its place is not selected.
  client.push({ ...state, approvals: [second] });
  await app.frame((f) => f.includes("Select an item with j or k."));
  await app.type("a");
  await app.frame((f) => f.includes("Select an item first"));
  expect(mutations(client.calls)).toHaveLength(1);
  await app.type("j");
  await app.frame((f) => f.includes("[0] Detail · Review: Second thing"));
  await app.type("a");
  await app.frame((f) => f.includes('Approved "Review: Second thing".'));
  expect(mutations(client.calls)).toHaveLength(2);
});

test("an approval decided elsewhere leaves nothing selected", async () => {
  const state = makeState();
  const second = { ...state.approvals[0]!, id: "apr_two", title: "Review: Second thing" };
  const client = fakeClient({ ...state, approvals: [state.approvals[0]!, second] });
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("3");
  await app.frame((f) => f.includes("[0] Detail · Review: Fix login redirect"));
  client.push({ ...state, approvals: [second] });
  await app.frame((f) => f.includes("Select an item with j or k."));
  await app.type("a");
  await app.frame((f) => f.includes("Select an item first"));
  expect(mutations(client.calls)).toEqual([]);
});

test("the prompt cursor never splits a wide character", async () => {
  const app = openApp(fakeClient(makeState()));
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("n", "a🙂b", KEY.left, KEY.left);
  const f = await app.frame((f) => f.includes("New task in atrium"));
  expect(f).toContain("> a🙂b");
});
