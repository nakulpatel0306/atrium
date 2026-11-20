import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
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
const ENV = ["GIT_CONFIG_GLOBAL", "ATRIUM_CLAUDE_BIN", "ATRIUM_CODEX_BIN", "ATRIUM_GEMINI_BIN", "ATRIUM_GH_BIN", "FAKE_CLAUDE_AUTH", "FAKE_CODEX_SCENARIO", "FAKE_AGY_SCENARIO", "FAKE_GH_MODE"];
beforeEach(() => {
  home = tempHome();
  db = openDb();
  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "fake-claude.ts");
  process.env.ATRIUM_CODEX_BIN = join(FIX, "fake-codex.ts");
  process.env.ATRIUM_GEMINI_BIN = join(FIX, "fake-agy.ts");
  process.env.ATRIUM_GH_BIN = join(FIX, "fake-gh.ts");
  // Git's global settings come from a file of the test's own, never the developer's.
  process.env.GIT_CONFIG_GLOBAL = join(home.home, "gitconfig");
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Sam Example\n\temail = sam@example.com\n");
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
  // The same order as Get started: Claude, the folder, then the extras.
  expect(text.indexOf("Required")).toBeLessThan(text.indexOf("Projects folder"));
  expect(text.indexOf("Projects folder")).toBeLessThan(text.indexOf("Optional"));
  expect(text).toContain("install:  npm install -g @openai/codex");
  expect(text).toContain("sign in:  claude auth login");
  expect(text).not.toContain("someone@example.com");
});

test("each Claude problem says what to do next, and doctor ends on the next step", async () => {
  let r = await doctor(null);
  expect(formatDoctor(r).trimEnd().split("\n").at(-1)).toBe("Ready. Run atrium start to use Atrium in this terminal, or atrium install to start it at every login, then atrium open.");
  process.env.FAKE_CLAUDE_AUTH = "signed-out";
  r = await doctor(null);
  expect(r.agents[0]!.message).toBe("Claude is installed but not signed in. Sign in, then check again.");
  expect(formatDoctor(r).trimEnd().split("\n").at(-1)).toBe("Atrium can't run tasks until Claude is ready. Run the commands above, then atrium doctor again.");
  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "does-not-exist");
  r = await doctor(null);
  // Installed after the engine started, it isn't on the engine's PATH until the engine starts again.
  expect(r.agents[0]!.message).toBe("Claude isn't installed, or Atrium can't find it. Install it, then check again. Installed it after Atrium started? Start Atrium again from a new terminal (atrium install or atrium start) so it finds it.");
});

test("git without a name and email says commits won't be yours, and how to set them; it never blocks", async () => {
  expect((await doctor(db)).git).toMatchObject({ state: "ready", required: true });
  writeFileSync(process.env.GIT_CONFIG_GLOBAL!, "");
  const r = await doctor(db);
  expect(r.git.state).toBe("signed_out");
  expect(r.git.message).toContain("name and email");
  expect(r.git.signIn).toBe('git config --global user.name "Your Name" && git config --global user.email you@example.com');
  expect(claudeBlocks(r)).toBeNull();
  const text = formatDoctor(r);
  expect(text).toContain("set up   Git");
  expect(text).toContain('set:      git config --global user.name "Your Name"');
  expect(text.indexOf("Git")).toBeLessThan(text.indexOf("Projects folder"));
  const shown = await view({ git: r.git });
  expect(shown).toContain("Git no name set");
  expect(shown).toContain("Set it: git config --global user.name");
  expect(await html({ git: r.git })).toContain('<button class="btn p primary">Next</button>');
});

test("nothing in the checks opens a credential file or Keychain item", () => {
  for (const f of ["doctor.ts", "start.ts", "start-steps.ts", "data-report.ts"]) {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "engine", f), "utf8");
    expect(src).not.toMatch(/readFile|Bun\.file|\.credentials|auth\.json|\.claude\/|\.codex\/|find-generic-password|createKeychain/);
  }
});

test("three steps run in order, back goes back, and the ends hold", () => {
  expect(STEPS).toEqual(["claude", "folder", "sample"]);
  expect(nextStep("claude")).toBe("folder");
  expect(nextStep("sample")).toBe("sample");
  expect(prevStep("sample")).toBe("folder");
  expect(prevStep("claude")).toBe("claude");
});

test("skipping is remembered, except for Claude's step, and progress resumes", () => {
  expect(getProgress(db)).toEqual({ step: "claude", skipped: [], done: false, dismissed: false });
  saveProgress(db, { skip: "folder", step: "sample" }, null);
  saveProgress(db, { skip: "claude" }, null);
  db.close();
  // A new connection to the same database, as after closing the app and coming back.
  db = openDb();
  expect(getProgress(db)).toEqual({ step: "sample", skipped: ["folder"], done: false, dismissed: false });
  expect(saveProgress(db, { unskip: "folder" }, null).skipped).toEqual([]);
  expect(() => saveProgress(db, { step: "nowhere" }, null)).toThrow("isn't a step");
});

test("a step stored by an older install, or a skip of one, is ignored, not an error", () => {
  setSetting(db, "start.step", "profile");
  setSetting(db, "start.skipped", JSON.stringify(["mail", "tools", "folder"]));
  expect(getProgress(db)).toMatchObject({ step: "claude", skipped: ["folder"] });
});

test("Claude missing blocks Done, and a signed-in Claude lets it finish", async () => {
  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "does-not-exist");
  const missing = claudeBlocks(await doctor(db));
  expect(missing).toContain("isn't installed");
  expect(() => saveProgress(db, { step: "folder" }, missing)).toThrow("Claude comes first");
  expect(() => saveProgress(db, { done: true }, missing)).toThrow("Claude comes first");
  expect(getProgress(db).done).toBe(false);
  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "fake-claude.ts");
  expect(claudeBlocks(await doctor(db))).toBeNull();
  expect(saveProgress(db, { done: true }, null)).toMatchObject({ done: true });
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
async function html(over: Partial<Report> = {}, step = "claude" as (typeof STEPS)[number]) {
  const report = { ...(await doctor(null)), ...over };
  return renderToStaticMarkup(
    <StartView report={report} progress={{ step, skipped: [], done: false, dismissed: false }} folder="~/Developer" sample={{ ask: "Fix the failing cart test", cents: 2, seconds: 60 }} message={null} onFolder={noop} onGo={noop} onRecheck={noop} onSaveFolder={noop} onRunSample={noop} onFinish={noop} />,
  );
}
test("a folder that isn't there yet is offered to be made before moving on", async () => {
  const report = await doctor(null);
  const el = renderToStaticMarkup(
    <StartView report={report} progress={{ step: "folder", skipped: [], done: false, dismissed: false }} folder="~/Code" missing="~/Code" sample={{ ask: "x", cents: 2, seconds: 60 }} message={null} onFolder={noop} onGo={noop} onRecheck={noop} onSaveFolder={noop} onRunSample={noop} onFinish={noop} />,
  );
  expect(el).toContain("~/Code doesn&#x27;t exist yet.");
  expect(el).toContain(">Create it</button>");
});

const view = async (over: Partial<Report> = {}, step = "claude" as (typeof STEPS)[number]) => (await html(over, step)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("Claude first, with the install command when it's missing; the extras never hold anything up", async () => {
  const ready = await view();
  expect(ready).toContain("Claude ready");
  expect(ready).toContain("Optional, any time");
  expect(ready).toContain("Codex");
  expect(ready).toContain("GitHub CLI");
  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "does-not-exist");
  const missing = await view();
  expect(missing).toContain("Install: curl -fsSL https://claude.ai/install.sh | bash");
  expect(await html()).toContain('<button class="btn p primary" disabled="">Next</button>');
});

test("the folder comes prefilled, and the sample says what it costs before it runs", async () => {
  expect(await view({}, "folder")).toContain("Projects folder");
  expect(await view({}, "folder")).not.toContain("Create it");
  const sample = await view({}, "sample");
  expect(sample).toContain("Run it");
  expect(sample).toContain("around 2¢");
  expect(sample).toContain("About a minute");
  expect(sample).toContain("Skip, go to Home");
});
