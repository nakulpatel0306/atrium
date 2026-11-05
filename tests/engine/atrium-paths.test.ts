import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atriumDenyPaths } from "../../src/engine/agents/atrium-paths";
import { sandboxSettings } from "../../src/engine/agents/claude";
import { SANDBOX_EXEC, seatbeltProfile } from "../../src/engine/agents/seatbelt";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let root: string;
beforeEach(() => {
  home = tempHome();
  root = realpathSync(home.home);
  process.env.ATRIUM_HOME = root;
  for (const d of ["transcripts", "spaces/spc_mine/runs/run_1", "spaces/spc_other/runs/run_2"]) mkdirSync(join(root, d), { recursive: true });
  for (const f of ["atrium.db", "atrium.db-wal", "atrium.db-shm", "engine.log", "transcripts/run_1.log", "spaces/spc_mine/notes.md", "spaces/spc_other/secret.md"]) {
    writeFileSync(join(root, f), "x\n");
  }
});
afterEach(() => home.cleanup());

const mine = () => join(root, "spaces", "spc_mine");

test("a run in its own space folder is denied the database, transcripts, logs and every other space", () => {
  const denied = atriumDenyPaths(mine());
  for (const p of ["atrium.db", "atrium.db-wal", "atrium.db-shm", "engine.log", "transcripts", "spaces/spc_other"]) expect(denied).toContain(join(root, p));
  expect(denied).not.toContain(mine());
  expect(denied).not.toContain(join(root, "spaces"));
  expect(denied).not.toContain(root);
});

test("a run outside Atrium's folder (a repo or a scratch folder) is denied every space", () => {
  const denied = atriumDenyPaths("/tmp/some-repo");
  expect(denied).toContain(join(root, "spaces"));
  expect(denied).toContain(join(root, "atrium.db"));
});

test("Claude's sandbox lets a general-space run read its own folder but not another space or the database", () => {
  const { sandbox } = JSON.parse(sandboxSettings(mine()));
  const denyRead: string[] = sandbox.filesystem.denyRead;
  expect(denyRead).not.toContain(root);
  expect(denyRead.some((p) => mine().startsWith(p))).toBe(false);
  expect(denyRead).toContain(join(root, "spaces", "spc_other"));
  expect(denyRead).toContain(join(root, "atrium.db"));
});

test("a free agent's seatbelt profile reads and writes its own space but not another space or the database", () => {
  const profile = seatbeltProfile({ cwd: mine(), writable: [mine()] });
  const run = (script: string) => Bun.spawnSync([SANDBOX_EXEC, "-p", profile, "/bin/sh", "-c", script], { cwd: mine() });
  expect(run("cat notes.md && echo y > new.txt && cat new.txt").stdout.toString()).toBe("x\ny\n");
  expect(run(`cat ${join(root, "spaces", "spc_other", "secret.md")}`).exitCode).not.toBe(0);
  expect(run(`cat ${join(root, "atrium.db")}`).exitCode).not.toBe(0);
  expect(run(`cat ${join(root, "transcripts", "run_1.log")}`).exitCode).not.toBe(0);
});
