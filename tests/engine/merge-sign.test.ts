import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeBranches } from "../../src/engine/git";

// A repo that signs every commit with an SSH key of its own, and a global config of its own too, so neither the
// key nor the signing programs of whoever runs the tests are read.
let dir: string;
let repo: string;
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

function run(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(args, { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
const git = (...args: string[]) => run(repo, "git", ...args);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atrium-sign-"));
  repo = join(dir, "repo");
  process.env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Atrium Test\n\temail = test@example.com\n");
  run(dir, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test@example.com", "-f", join(dir, "key"));
  writeFileSync(join(dir, "allowed"), `test@example.com ${run(dir, "cat", join(dir, "key.pub"))}\n`);
  run(dir, "git", "init", "-q", "-b", "main", repo);
  git("config", "gpg.format", "ssh");
  git("config", "user.signingkey", join(dir, "key"));
  git("config", "gpg.ssh.allowedSignersFile", join(dir, "allowed"));
  git("config", "commit.gpgsign", "true");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  for (const [branch, file] of [["atrium/p1", "one.txt"], ["atrium/p2", "two.txt"]] as const) {
    git("checkout", "-q", "-b", branch, "main");
    writeFileSync(join(repo, file), `${file}\n`);
    git("add", "-A");
    git("commit", "-qm", file);
  }
  git("checkout", "-q", "main");
});
afterEach(() => {
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("a repo that signs its commits gets signed merge commits", async () => {
  const base = git("rev-parse", "main");
  const merged = await mergeBranches(repo, base, [
    { branch: "atrium/p1", message: "Merge part: one" },
    { branch: "atrium/p2", message: "Merge part: two" },
  ]);
  if (!("sha" in merged)) throw new Error("conflict");
  expect(git("log", "--format=%G?", "-n", "2", merged.sha).split("\n")).toEqual(["G", "G"]);
  expect(git("show", `${merged.sha}:two.txt`)).toBe("two.txt");
});

test("a merge that can't be signed stops instead of leaving unsigned commits", async () => {
  git("config", "user.signingkey", join(dir, "missing-key"));
  const base = git("rev-parse", "main");
  await expect(mergeBranches(repo, base, [{ branch: "atrium/p1", message: "Merge part: one" }])).rejects.toThrow("Couldn't sign the merge of atrium/p1");
});

test("a repo that doesn't sign gets plain merge commits", async () => {
  git("config", "commit.gpgsign", "false");
  const merged = await mergeBranches(repo, git("rev-parse", "main"), [{ branch: "atrium/p1", message: "Merge part: one" }]);
  if (!("sha" in merged)) throw new Error("conflict");
  expect(git("log", "--format=%G?", "-n", "1", merged.sha)).toBe("N");
});
