import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempHome(): { home: string; cleanup(): void } {
  const home = mkdtempSync(join(tmpdir(), "atrium-home-"));
  process.env.ATRIUM_HOME = home;
  // Space folders stay inside the temp home, never the real ~/Atrium.
  process.env.ATRIUM_FILES_HOME = join(home, "files");
  // Tests never launch real apps.
  process.env.ATRIUM_OPEN_BIN ??= join(import.meta.dir, "fixtures", "fake-open.ts");
  // The greeting and own-transfer name never come from the Mac account that happens to run the tests.
  process.env.ATRIUM_MAC_NAME = "";
  return {
    home,
    cleanup: () => {
      delete process.env.ATRIUM_HOME;
      delete process.env.ATRIUM_FILES_HOME;
      delete process.env.ATRIUM_MAC_NAME;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function tempRepo(): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), "atrium-repo-"));
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "# fixture\n");
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: path });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  git("init", "-b", "main");
  // Local config so engine commits in fixtures neither sign with the developer's key nor depend on their identity.
  git("config", "user.name", "Atrium Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-m", "init");
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

// Content facts for a plain docs change: nothing that executes, nothing an agent's instructions import.
export const PLAIN_DOCS = { added: ["A plain note."], bytes: 14, siteConfig: false, instructionsUnsafe: false, notPlain: false, bodyUnsafe: false };

// A branch at the repo's current commit, as an agent's finished task leaves it; returns that commit.
export function branchAt(path: string, branch: string): string {
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: path });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  run("branch", "-f", branch);
  return run("rev-parse", branch);
}
