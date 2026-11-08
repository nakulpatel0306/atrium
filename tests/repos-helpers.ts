import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_GH = join(import.meta.dir, "fixtures", "fake-gh.ts");
const VARS = ["ATRIUM_GH_BIN", "FAKE_GH_REMOTES", "FAKE_GH_LOG", "FAKE_GH_MODE", "ATRIUM_PROJECTS_ROOT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];

export type FakeGitHub = {
  base: string;
  remotes: string;
  log: string;
  projects: string;
  gitconfig: string;
  env(mode?: string): void;
  argv(): string[][];
  withSigning(): void;
  cleanup(): void;
};

// A fake gh, a temp projects root and a global git config of its own, so no test reaches GitHub or reads
// Nakul's git identity, signing key or keychain. "https://github.com/" is rewritten to the local bare repos.
export function fakeGitHub(mode = "ok"): FakeGitHub {
  const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  const base = mkdtempSync(join(tmpdir(), "atrium-gh-"));
  const remotes = join(base, "remotes");
  const projects = join(base, "projects");
  const log = join(base, "gh.log");
  const gitconfig = join(base, "gitconfig");
  mkdirSync(remotes);
  mkdirSync(projects);
  writeFileSync(
    gitconfig,
    `[user]\n\tname = Atrium Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[url "file://${remotes}/"]\n\tinsteadOf = https://github.com/\n`,
  );
  const env = (m = mode) => {
    process.env.ATRIUM_GH_BIN = FAKE_GH;
    process.env.FAKE_GH_REMOTES = remotes;
    process.env.FAKE_GH_LOG = log;
    process.env.FAKE_GH_MODE = m;
    process.env.ATRIUM_PROJECTS_ROOT = projects;
    process.env.GIT_CONFIG_GLOBAL = gitconfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  };
  env();
  return {
    base,
    remotes,
    log,
    projects,
    gitconfig,
    env,
    argv: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    withSigning: () => {
      const key = join(base, "k");
      const r = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]);
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      appendFileSync(gitconfig, `[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = ${key}.pub\n[commit]\n\tgpgsign = true\n`);
    },
    cleanup: () => {
      for (const v of VARS) {
        if (saved[v] === undefined) delete process.env[v];
        else process.env[v] = saved[v];
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

// A bare repo at fakeuser/<name> with one commit on main, as an existing GitHub repo.
export function seedRemote(gh: FakeGitHub, name: string, files: Record<string, string> = {}, owner = "fakeuser"): string {
  const bare = join(gh.remotes, owner, `${name}.git`);
  const work = mkdtempSync(join(tmpdir(), "atrium-seed-"));
  const run = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  mkdirSync(join(gh.remotes, owner), { recursive: true });
  run(gh.remotes, "init", "-q", "--bare", "-b", "main", bare);
  writeFileSync(join(work, "README.md"), `# ${name}\n`);
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(work, rel), body);
  run(work, "init", "-q", "-b", "main");
  run(work, "add", "-A");
  run(work, "commit", "-q", "-m", "init");
  run(work, "push", "-q", bare, "main");
  rmSync(work, { recursive: true, force: true });
  return bare;
}
