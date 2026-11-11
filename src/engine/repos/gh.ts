import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { type ProjectDraft, validateGithubSlug } from "./names";

// The only place Atrium runs the GitHub CLI: always an argv array (never a shell), never interactive.
export type GhResult = { code: number; out: string; err: string; timedOut: boolean };

const GH_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_SPINNER_DISABLED: "1",
  NO_COLOR: "1",
  GIT_TERMINAL_PROMPT: "0",
};

export async function runGh(args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<GhResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([config().ghBin, ...args], { cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...GH_ENV } });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { code: 127, out: "", err: "", timedOut: false };
    throw e;
  }
  let timedOut = false;
  // gh waits on the login keychain, which can stay locked overnight; a hung call must fail, not hang the engine.
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, opts.timeoutMs ?? 30_000);
  const out = new Response(proc.stdout as ReadableStream).text();
  const err = new Response(proc.stderr as ReadableStream).text();
  const code = await proc.exited;
  clearTimeout(timer);
  if (timedOut) return { code, out: "", err: "", timedOut: true };
  return { code, out: await out, err: await err, timedOut: false };
}

export type GhProblemKind = "not_installed" | "logged_out" | "name_taken" | "offline" | "timeout" | "not_found" | "other";

export class GhProblem extends Error {
  constructor(
    readonly kind: GhProblemKind,
    message: string,
    // gh's or git's own words, for the activity log; Nakul-facing text stays plain.
    readonly raw?: string,
  ) {
    super(message);
    this.name = "GhProblem";
  }
}

const COPY = {
  not_installed: "GitHub CLI (gh) isn't installed. Install it with `brew install gh`, run `gh auth login`, then approve again.",
  logged_out: "gh is signed out of GitHub. Run `gh auth login` in a terminal, then approve again.",
  offline: "Couldn't reach GitHub. Check your internet connection, then approve again.",
  timeout: "GitHub didn't answer within 30 seconds. If your Mac's keychain is locked, unlock it, then approve again.",
  other: "GitHub didn't accept that, and Atrium couldn't tell why. Run `gh auth status` in a terminal to check gh still works, then try again.",
};

export function ghProblem(res: GhResult, ctx: { name?: string; slug?: string }): GhProblem {
  const text = `${res.err}\n${res.out}`;
  if (res.timedOut) return new GhProblem("timeout", COPY.timeout);
  if (res.code === 127) return new GhProblem("not_installed", COPY.not_installed);
  if (res.code === 4 || /gh auth login|not logged in|authentication required|authentication failed|HTTP 401/i.test(text)) {
    return new GhProblem("logged_out", COPY.logged_out);
  }
  if (/name already exists/i.test(text)) {
    return new GhProblem("name_taken", `You already have a GitHub repo called "${ctx.name ?? ""}". Change the name and approve again.`);
  }
  if (/error connecting|could not resolve host|no such host|dial tcp|network is unreachable|connection refused/i.test(text)) {
    return new GhProblem("offline", COPY.offline);
  }
  if (/could not resolve to a repository|HTTP 404|repository not found|does not appear to be a git repository/i.test(text)) {
    return new GhProblem("not_found", `Couldn't find ${ctx.slug ?? "that repo"} on GitHub, or your account can't see it. Check the name.`);
  }
  const first = (res.err.trim() || res.out.trim()).split("\n")[0]!.slice(0, 200);
  return new GhProblem("other", COPY.other, first);
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

export async function ghLogin(opts: { timeoutMs?: number } = {}): Promise<string> {
  const res = await runGh(["api", "user", "--jq", ".login"], opts);
  if (res.code !== 0 || res.timedOut) throw ghProblem(res, {});
  const login = res.out.trim();
  if (!OWNER.test(login)) {
    throw new GhProblem("other", "gh answered with an account name Atrium doesn't recognise. Run `gh auth status` to see who's signed in, then approve again.", login.slice(0, 60));
  }
  return login;
}

export async function ghCreateRepo(d: ProjectDraft, opts: { timeoutMs?: number } = {}): Promise<string> {
  const args = ["repo", "create", d.visibility === "public" ? "--public" : "--private", `--description=${d.description}`, "--", d.name];
  const res = await runGh(args, opts);
  if (res.code !== 0 || res.timedOut) throw ghProblem(res, { name: d.name });
  const url = res.out.trim().split("\n").pop() ?? "";
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(url);
  // The URL decides where the first push goes, so it must be exactly the repo we asked for.
  if (!m || !OWNER.test(m[1]!) || m[2] !== d.name) {
    throw new GhProblem("other", "gh reported a repo with a different name than the one asked for, so nothing was pushed. Check your repos on GitHub, then try again.", url.slice(0, 120));
  }
  return url;
}

// A reused repo was created with an earlier draft's description; it gets the one Nakul approved this time.
export async function ghEditDescription(slug: string, description: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  validateGithubSlug(slug);
  const res = await runGh(["repo", "edit", slug, `--description=${description}`], opts);
  if (res.code !== 0 || res.timedOut) throw ghProblem(res, { slug });
}

// gh's repo view takes the slug positionally and rejects it after "--"; the slug is validated first, so it can
// never start with "-".
export async function ghViewRepo(slug: string, opts: { timeoutMs?: number } = {}): Promise<{ nameWithOwner: string; isPrivate: boolean; url: string }> {
  validateGithubSlug(slug);
  const res = await runGh(["repo", "view", slug, "--json", "nameWithOwner,isPrivate,url"], opts);
  if (res.code !== 0 || res.timedOut) throw ghProblem(res, { slug });
  try {
    const v = JSON.parse(res.out) as { nameWithOwner: unknown; isPrivate: unknown; url: unknown };
    if (typeof v.nameWithOwner === "string" && typeof v.isPrivate === "boolean" && typeof v.url === "string") {
      return { nameWithOwner: v.nameWithOwner, isPrivate: v.isPrivate, url: v.url };
    }
  } catch {
    // Falls through to the plain error below.
  }
  throw new GhProblem("other", "gh's answer about that repo couldn't be read. Update gh with `brew upgrade gh`, then try again.", res.out.slice(0, 120));
}

// Opens a pull request from an already-pushed branch. The repo is named outright (the remote read before the agent
// ran), and gh runs in an empty folder, so nothing in the user's repo folder (its remotes, its config) is read. A PR
// that already exists for the branch counts as the answer: gh names it in its error.
export async function ghPrCreate(
  pr: { repo: string; head: string; base: string; title: string; body: string },
  opts: { timeoutMs?: number } = {},
): Promise<{ url: string; existed: boolean }> {
  validateGithubSlug(pr.repo);
  // `--flag=value` so a title starting with "-" is never read as an option.
  const args = ["pr", "create", `--repo=${pr.repo}`, `--head=${pr.head}`, `--base=${pr.base}`, `--title=${pr.title}`, `--body=${pr.body}`];
  const cwd = mkdtempSync(join(tmpdir(), "atrium-gh-"));
  let res: GhResult;
  try {
    res = await runGh(args, { ...opts, cwd });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const pull = new RegExp(`https://github\\.com/${pr.repo.replace(/[.]/g, "\\.")}/pull/\\d+`, "i");
  if (res.code !== 0 || res.timedOut) {
    const existing = /already exists/i.test(res.err) ? pull.exec(res.err) : null;
    if (existing) return { url: existing[0], existed: true };
    throw ghProblem(res, { slug: pr.repo });
  }
  const url = pull.exec(res.out);
  if (!url) throw new GhProblem("other", "gh didn't say where the pull request is. Check the repo's pull requests on GitHub.", res.out.slice(0, 120));
  return { url: url[0], existed: false };
}

// git runs a "!helper" through a shell, so the gh path is only used when it has nothing a shell would interpret.
export function ghCredentialFlags(): string[] {
  const path = Bun.which(config().ghBin);
  if (!path || /[^A-Za-z0-9/._-]/.test(path)) throw new GhProblem("not_installed", COPY.not_installed);
  return ["-c", "credential.helper=", "-c", `credential.helper=!${path} auth git-credential`];
}
