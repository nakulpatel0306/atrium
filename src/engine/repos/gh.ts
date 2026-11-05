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

export async function runGh(args: string[], opts: { timeoutMs?: number } = {}): Promise<GhResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([config().ghBin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...GH_ENV } });
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
};

export function ghProblem(res: GhResult, ctx: { name?: string; slug?: string }): GhProblem {
  const text = `${res.err}\n${res.out}`;
  if (res.timedOut) return new GhProblem("timeout", COPY.timeout);
  if (res.code === 127) return new GhProblem("not_installed", COPY.not_installed);
  if (res.code === 4 || /gh auth login|not logged in|authentication required|HTTP 401/i.test(text)) {
    return new GhProblem("logged_out", COPY.logged_out);
  }
  if (/name already exists/i.test(text)) {
    return new GhProblem("name_taken", `You already have a GitHub repo called "${ctx.name ?? ""}". Change the name and approve again.`);
  }
  if (/error connecting|could not resolve host|no such host|dial tcp|network is unreachable|connection refused/i.test(text)) {
    return new GhProblem("offline", COPY.offline);
  }
  if (/could not resolve to a repository|HTTP 404/i.test(text)) {
    return new GhProblem("not_found", `Couldn't find ${ctx.slug ?? "that repo"} on GitHub, or your account can't see it. Check the name.`);
  }
  const first = (res.err.trim() || res.out.trim()).split("\n")[0]!.slice(0, 200);
  return new GhProblem("other", `GitHub said: ${first}`);
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

export async function ghLogin(opts: { timeoutMs?: number } = {}): Promise<string> {
  const res = await runGh(["api", "user", "--jq", ".login"], opts);
  if (res.code !== 0 || res.timedOut) throw ghProblem(res, {});
  const login = res.out.trim();
  if (!OWNER.test(login)) throw new GhProblem("other", `GitHub said: unexpected account name "${login.slice(0, 60)}"`);
  return login;
}

export async function ghCreateRepo(d: ProjectDraft, opts: { timeoutMs?: number } = {}): Promise<string> {
  const args = ["repo", "create", d.visibility === "public" ? "--public" : "--private", `--description=${d.description}`, "--", d.name];
  const res = await runGh(args, opts);
  if (res.code !== 0 || res.timedOut) throw ghProblem(res, { name: d.name });
  const url = res.out.trim().split("\n").pop() ?? "";
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(url);
  // The URL decides where the first push goes, so it must be exactly the repo we asked for.
  if (!m || !OWNER.test(m[1]!) || m[2] !== d.name) throw new GhProblem("other", `GitHub said: created an unexpected repo "${url.slice(0, 120)}"`);
  return url;
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
  throw new GhProblem("other", "GitHub said: an unreadable reply about that repo");
}

// git runs a "!helper" through a shell, so the gh path is only used when it has nothing a shell would interpret.
export function ghCredentialFlags(): string[] {
  const path = Bun.which(config().ghBin);
  if (!path || /[^A-Za-z0-9/._-]/.test(path)) throw new GhProblem("not_installed", COPY.not_installed);
  return ["-c", "credential.helper=", "-c", `credential.helper=!${path} auth git-credential`];
}
