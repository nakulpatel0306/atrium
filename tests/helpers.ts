import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempHome(): { home: string; cleanup(): void } {
  const home = mkdtempSync(join(tmpdir(), "atrium-home-"));
  process.env.ATRIUM_HOME = home;
  return {
    home,
    cleanup: () => {
      delete process.env.ATRIUM_HOME;
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
  git("add", "-A");
  git("-c", "user.name=Atrium Test", "-c", "user.email=test@atrium.local", "-c", "commit.gpgsign=false", "commit", "-m", "init");
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
