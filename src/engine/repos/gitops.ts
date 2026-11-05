import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { git, signingPins, STAGE_FLAGS } from "../git";
import { ghCredentialFlags, ghProblem } from "./gh";

const IDENTITY = "Set your git name and email first (git config --global user.name / user.email), then approve again.";
const UNSIGNED = "Git couldn't sign the first commit, so nothing was pushed. Check your signing key setup, then approve again.";

// The first commit of a new project, as Nakul: his global identity and signing setup, a bare message, no trailers.
export async function initialCommit(path: string): Promise<string> {
  const init = await git(path, ["init", "-q", "-b", "main"]);
  if (init.code !== 0) throw new Error(`Could not set up git in the new folder: ${init.err.trim()}`);
  if ((await git(path, ["config", "--get", "user.email"])).code !== 0) throw new Error(IDENTITY);
  const empty = await git(path, ["hash-object", "-t", "tree", "/dev/null"]);
  const flags = [...STAGE_FLAGS, `--attr-source=${empty.out.trim()}`];
  const add = await git(path, [...flags, "add", "-A"]);
  if (add.code !== 0) throw new Error(`Could not stage the template: ${add.err.trim()}`);
  const signs = (await git(path, ["config", "--bool", "--get", "commit.gpgsign"])).out.trim() === "true";
  const commit = await git(path, [...flags, ...(await signingPins(path)), "commit", "-q", "-m", "Initial commit"]);
  if (commit.code !== 0) throw new Error(signs ? UNSIGNED : `Could not make the first commit: ${(commit.err || commit.out).trim()}`);
  if (signs) {
    const obj = await git(path, ["cat-file", "commit", "HEAD"]);
    const header = obj.out.split("\n\n")[0] ?? "";
    if (!/^gpgsig(-sha256)? /m.test(header)) throw new Error(UNSIGNED);
  }
  return (await git(path, ["rev-parse", "HEAD"])).out.trim();
}

export async function cloneRepo(url: string, dest: string, timeoutMs = 300_000): Promise<void> {
  const args = [...ghCredentialFlags(), "clone", "-q", "--no-recurse-submodules", "--template=", "--", url, dest];
  const res = await git(dirname(dest), args, timeoutMs);
  if (res.code !== 0 || res.timedOut) throw ghProblem(res, { slug: url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") });
}

export async function fetchOrigin(path: string, timeoutMs = 60_000): Promise<{ ok: true } | { ok: false; reason: string }> {
  const res = await git(path, [...ghCredentialFlags(), "fetch", "-q", "--prune", "--no-recurse-submodules", "origin"], timeoutMs);
  if (res.code === 0 && !res.timedOut) return { ok: true };
  return { ok: false, reason: ghProblem(res, {}).message };
}

// What a reused GitHub repo holds: nothing, the commit an earlier run pushed, or someone else's work.
export async function remoteState(url: string, pushedSha: string | null, timeoutMs = 60_000): Promise<"empty" | "ours" | "theirs"> {
  const res = await git(tmpdir(), [...ghCredentialFlags(), "ls-remote", "--", url], timeoutMs);
  if (res.code !== 0 || res.timedOut) throw ghProblem(res, {});
  const refs = res.out.trim().split("\n").filter(Boolean).map((l) => l.split("\t") as [string, string]);
  if (refs.length === 0) return "empty";
  const heads = refs.filter(([, ref]) => ref.startsWith("refs/heads/"));
  return pushedSha && heads.length === 1 && heads[0]![1] === "refs/heads/main" && heads[0]![0] === pushedSha ? "ours" : "theirs";
}
