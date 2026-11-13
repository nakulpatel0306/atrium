import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { StartView } from "../../src/dashboard/components/GetStarted";
import { openDb } from "../../src/engine/db";
import { doctor, formatDoctor, type Report } from "../../src/engine/doctor";
import { setSetting } from "../../src/engine/settings";
import { createSpace } from "../../src/engine/spaces";
import { getProgress, saveProgress, shouldAutoOpen } from "../../src/engine/start";
import { claudeBlocks, nextStep, prevStep, STEPS } from "../../src/engine/start-steps";
import { tempHome } from "../helpers";

const FIX = join(import.meta.dir, "..", "fixtures");
let home: ReturnType<typeof tempHome>;
let db: Database;
const ENV = ["ATRIUM_CLAUDE_BIN", "ATRIUM_CODEX_BIN", "ATRIUM_GEMINI_BIN", "ATRIUM_GH_BIN", "FAKE_CLAUDE_AUTH", "FAKE_CODEX_SCENARIO", "FAKE_AGY_SCENARIO", "FAKE_GH_MODE"];
beforeEach(() => {
  home = tempHome();
  db = openDb();
  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "fake-claude.ts");
  process.env.ATRIUM_CODEX_BIN = join(FIX, "fake-codex.ts");
  process.env.ATRIUM_GEMINI_BIN = join(FIX, "fake-agy.ts");
  process.env.ATRIUM_GH_BIN = join(FIX, "fake-gh.ts");
});
afterEach(() => {
  db.close();
  for (const k of ENV) delete process.env[k];
  home.cleanup();
});

test("detection: installed and signed in, signed out, too old and missing", async () => {
  let r = await doctor(db);
  expect(r.agents.map((a) => [a.id, a.state])).toEqual([["claude", "ready"], ["codex", "ready"], ["gemini", "ready"]]);
  expect(r.agents[0]).toMatchObject({ version: "2.1.318", minimum: "2.1.257", required: true });
  expect(r.agents[1]!.required).toBe(false);
  expect(r.github.state).toBe("ready");

  process.env.FAKE_CLAUDE_AUTH = "signed-out";
  process.env.FAKE_CODEX_SCENARIO = "logged-out";
  process.env.FAKE_AGY_SCENARIO = "auth";
  process.env.FAKE_GH_MODE = "logged_out";
  r = await doctor(db);
  expect(r.agents.map((a) => a.state)).toEqual(["signed_out", "signed_out", "signed_out"]);
  expect(r.github.state).toBe("signed_out");

  process.env.FAKE_CLAUDE_VERSION = "2.0.1";
  expect((await doctor(db)).agents[0]!.state).toBe("too_old");
  delete process.env.FAKE_CLAUDE_VERSION;

  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "does-not-exist");
  process.env.ATRIUM_CODEX_BIN = join(FIX, "does-not-exist");
  process.env.ATRIUM_GH_BIN = join(FIX, "does-not-exist");
  r = await doctor(db);
  expect(r.agents[0]).toMatchObject({ state: "not_installed", install: expect.stringContaining("claude") });
  expect(r.agents[1]!.state).toBe("not_installed");
  expect(r.github.state).toBe("not_installed");
});

test("doctor output names the install and sign-in commands, and never prints sign-in details", async () => {
  process.env.ATRIUM_CODEX_BIN = join(FIX, "does-not-exist");
  process.env.FAKE_CLAUDE_AUTH = "signed-out";
  const text = formatDoctor(await doctor(null));
  expect(text).toContain("sign in  Claude");
  expect(text).toContain("install:  npm install -g @openai/codex");
  expect(text).toContain("sign in:  claude auth login");
  expect(text).not.toContain("someone@example.com");
});

test("nothing in the checks opens a credential file or Keychain item", () => {
  for (const f of ["doctor.ts", "start.ts", "start-steps.ts", "data-report.ts"]) {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "engine", f), "utf8");
    expect(src).not.toMatch(/readFile|Bun\.file|\.credentials|auth\.json|\.claude\/|\.codex\/|find-generic-password|createKeychain/);
  }
});

test("steps run in order, back goes back, and the ends hold", () => {
  expect(STEPS).toEqual(["welcome", "agents", "tools", "profile", "done"]);
  expect(nextStep("welcome")).toBe("agents");
  expect(nextStep("done")).toBe("done");
  expect(prevStep("tools")).toBe("agents");
  expect(prevStep("welcome")).toBe("welcome");
});

test("skipping is remembered, except for agents, and progress resumes", () => {
  expect(getProgress(db)).toEqual({ step: "welcome", skipped: [], done: false, dismissed: false });
  saveProgress(db, { step: "tools" }, null);
  saveProgress(db, { skip: "tools", step: "profile" }, null);
  saveProgress(db, { skip: "agents" }, null);
  saveProgress(db, { skip: "tools" }, null);
  db.close();
  // A new connection to the same database, as after closing the app and coming back.
  db = openDb();
  expect(getProgress(db)).toEqual({ step: "profile", skipped: ["tools"], done: false, dismissed: false });
  expect(saveProgress(db, { unskip: "tools" }, null).skipped).toEqual([]);
  expect(() => saveProgress(db, { step: "nowhere" }, null)).toThrow("isn't a step");
});

test("a stored step or skip from a removed step is ignored, not an error", () => {
  setSetting(db, "start.step", "investing");
  setSetting(db, "start.skipped", JSON.stringify(["mail", "tools", "investing"]));
  expect(getProgress(db)).toMatchObject({ step: "welcome", skipped: ["tools"] });
});

test("Claude missing blocks Done, and a signed-in Claude lets it finish", async () => {
  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "does-not-exist");
  const missing = claudeBlocks(await doctor(db));
  expect(missing).toContain("isn't installed");
  expect(() => saveProgress(db, { step: "done" }, missing)).toThrow("Claude comes first");
  expect(() => saveProgress(db, { done: true }, missing)).toThrow("Claude comes first");
  expect(getProgress(db).done).toBe(false);
  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "fake-claude.ts");
  expect(claudeBlocks(await doctor(db))).toBeNull();
  expect(saveProgress(db, { done: true }, null)).toMatchObject({ step: "done", done: true });
});

test("a failed sign-in check is 'couldn't check', not signed out, and keeps Done blocked until one succeeds", async () => {
  process.env.FAKE_CLAUDE_AUTH = "error";
  const r = await doctor(db);
  expect(r.agents[0]).toMatchObject({ state: "unknown", message: "Couldn't check whether Claude is signed in. Try again." });
  const problem = claudeBlocks(r);
  expect(problem).toContain("Couldn't check");
  expect(() => saveProgress(db, { done: true }, problem)).toThrow("Claude comes first");
  delete process.env.FAKE_CLAUDE_AUTH;
  expect(claudeBlocks(await doctor(db))).toBeNull();
});

test("Skip for now stops auto-open, lapses once a space exists, and reopening clears it", () => {
  expect(shouldAutoOpen(db)).toBe(true);
  saveProgress(db, { dismiss: true }, null);
  expect(getProgress(db).dismissed).toBe(true);
  expect(shouldAutoOpen(db)).toBe(false);
  saveProgress(db, { dismiss: false }, null);
  expect(shouldAutoOpen(db)).toBe(true);
  saveProgress(db, { dismiss: true }, null);
  const s = createSpace(db, { name: "Notes", kind: "general", goal: "g" });
  expect(shouldAutoOpen(db)).toBe(false);
  expect(getProgress(db).dismissed).toBe(false);
  db.query("DELETE FROM spaces WHERE id = ?").run(s.id);
  expect(shouldAutoOpen(db)).toBe(true);
});

test("it opens by itself only with no spaces and setup not done", () => {
  expect(shouldAutoOpen(db)).toBe(true);
  createSpace(db, { name: "Notes", kind: "general", goal: "g" });
  expect(shouldAutoOpen(db)).toBe(false);
  db.query("DELETE FROM tasks").run();
  db.query("DELETE FROM spaces").run();
  expect(shouldAutoOpen(db)).toBe(true);
  saveProgress(db, { done: true }, null);
  expect(shouldAutoOpen(db)).toBe(false);
});

const noop = () => {};
async function view(over: Partial<Report> = {}, step = "agents" as (typeof STEPS)[number]) {
  const report = { ...(await doctor(null)), ...over };
  const html = renderToStaticMarkup(
    <StartView report={report} progress={{ step, skipped: [], done: false, dismissed: false }} draft={{ name: "", projectsRoot: "" }} message={null} onDraft={noop} onGo={noop} onSkip={noop} onRecheck={noop} onSaveProfile={noop} onFinish={noop} onDismiss={noop} />,
  );
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

test("the screen shows each step's states, and Next into Done is disabled while Claude is missing", async () => {
  expect(await view({}, "welcome")).toContain("Step 1 of 5");
  // Optional steps can be skipped.
  expect(await view({}, "profile")).toMatch(/Skip(?! for now)/);
  const agents = await view({}, "agents");
  expect(agents).toContain("Claude");
  expect(agents).toContain("Required");
  expect(agents).toContain("Check again");
  expect(agents).not.toMatch(/Skip(?! for now)/);
  expect(await view({}, "tools")).toMatch(/Skip(?! for now)/);
  expect(agents).toContain("Skip for now");
  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "does-not-exist");
  const blocked = await view({}, "profile");
  expect(blocked).toContain("Save");
  process.env.FAKE_CLAUDE_AUTH = "signed-out";
  const done = await view({}, "done");
  expect(done).toContain("Open home");
  expect(done).toContain("Claude is required before you can finish");
});
