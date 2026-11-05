import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_FILE_PATTERN, SANDBOX_EXEC, seatbeltProfile, wrapInSeatbelt } from "../../src/engine/agents/seatbelt";
import { tempHome } from "../helpers";

// /tmp is outside the per-user temp dir ($TMPDIR, under /var/folders), so it stands in for "elsewhere on disk".
let outside: string;
let cwd: string;
let state: string;

function sandboxed(profile: string, script: string, dir = cwd) {
  const r = Bun.spawnSync([SANDBOX_EXEC, "-p", profile, "/bin/sh", "-c", script], { cwd: dir, stderr: "pipe", stdout: "pipe" });
  return { exitCode: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// A denied path that is itself a symlink appears in the profile resolved.
function canonicalUnder(home: string, p: string): string {
  try {
    return realpathSync(join(home, p));
  } catch {
    return join(home, p);
  }
}

// A home of the tests' own, so the default Atrium dir below counts as another engine's and is denied whole.
let atriumHome: ReturnType<typeof tempHome>;

beforeAll(() => {
  atriumHome = tempHome();
  outside = realpathSync(mkdtempSync("/tmp/atrium-seatbelt-"));
  cwd = join(outside, "repo");
  state = join(outside, "state");
  for (const d of [cwd, state, join(cwd, ".git"), join(cwd, "config")]) mkdirSync(d, { recursive: true });
  for (const f of [".env", ".env.local", ".envrc", ".ENVRC", "prod.env", "my.env.txt", "environment", "config/.env.production"]) writeFileSync(join(cwd, f), "canary\n");
});

afterAll(() => {
  rmSync(outside, { recursive: true, force: true });
  atriumHome.cleanup();
});

describe("ENV_FILE_PATTERN", () => {
  test("matches a path component starting or ending with .env, in any case, and nothing else", () => {
    const re = new RegExp(ENV_FILE_PATTERN);
    const hits = ["/foo/.env", "/foo/.env.local", "/foo/.envrc", "/foo/.ENVRC", "/foo/.Env", "/foo/.env/inner", "/.env", "/foo/prod.env", "/foo/PROD.ENV", "/foo/x.env/inner"];
    for (const p of hits) expect(re.test(p)).toBe(true);
    for (const p of ["/foo/my.env.txt", "/foo/environment", "/foo/env", "/foo/a.envrc", "/foo/x.envy", "/foo/env.d"]) expect(re.test(p)).toBe(false);
  });
});

describe("seatbeltProfile", () => {
  test("security CLI can't run under the profile", () => {
    if (process.platform !== "darwin") return;
    const profile = seatbeltProfile({ cwd, writable: [cwd] });
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/security"))');
    const r = sandboxed(profile, "/usr/bin/security help");
    expect(r.exitCode).not.toBe(0);
  });

  test("profile denies credential paths and .env names", () => {
    const home = realpathSync(homedir());
    const profile = seatbeltProfile({ cwd, writable: [] });
    expect(profile.startsWith("(version 1)\n(allow default)\n")).toBe(true);
    const secrets = [
      ".ssh", ".aws", ".gnupg", ".config/gh", "Library/Keychains", ".netrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".docker",
      ".kube", ".config/gcloud", ".azure", ".git-credentials", ".config/git/credentials", ".pypirc", ".claude", ".claude.json",
      ".config/op", ".password-store", ".zsh_history", ".bash_history", ".local/share/fish/fish_history",
      "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox", "Library/Safari", "Library/Cookies",
      "Library/Messages", "Library/Mail", "Library/Application Support/Atrium",
    ];
    for (const p of secrets) expect(profile).toContain(`"${canonicalUnder(home, p)}")`);
    expect(profile).toContain(`(regex #"${ENV_FILE_PATTERN}")`);

    const reads = sandboxed(profile, "for f in .env .env.local .envrc .ENVRC prod.env config/.env.production my.env.txt environment; do cat $f >/dev/null 2>&1 && echo \"read $f\" || echo \"denied $f\"; done");
    expect(reads.out.trim().split("\n")).toEqual([
      "denied .env", "denied .env.local", "denied .envrc", "denied .ENVRC", "denied prod.env", "denied config/.env.production", "read my.env.txt", "read environment",
    ]);
    for (const d of [".ssh", ".claude", "Library/Keychains"]) expect(sandboxed(profile, `ls "${home}/${d}"`).err).toContain("Operation not permitted");
  });

  test("allowRead reopens single files inside a denied path, after the deny", () => {
    const secret = join(outside, "vault");
    mkdirSync(secret, { recursive: true });
    writeFileSync(join(secret, "open.txt"), "open\n");
    writeFileSync(join(secret, "closed.txt"), "closed\n");
    const profile = seatbeltProfile({ cwd, writable: [], extraDenyRead: [secret], allowRead: [join(secret, "open.txt")] });
    const r = sandboxed(profile, `cat "${secret}/open.txt"; cat "${secret}/closed.txt"`);
    expect(r.out).toBe("open\n");
    expect(r.err).toContain("Operation not permitted");
  });

  test("an .env file can't be renamed to a readable name", () => {
    const r = sandboxed(seatbeltProfile({ cwd, writable: [cwd] }), "mv .env plain; cat plain");
    expect(r.err).toContain("Operation not permitted");
    expect(r.out).not.toContain("canary");
  });

  test("extraDenyRead adds paths to the read deny list", () => {
    const secret = join(outside, "secret");
    mkdirSync(secret, { recursive: true });
    writeFileSync(join(secret, "note.txt"), "canary\n");
    const r = sandboxed(seatbeltProfile({ cwd, writable: [cwd], extraDenyRead: [secret] }), `cat "${secret}/note.txt"; cp "${secret}/note.txt" copy.txt`);
    expect(r.out).not.toContain("canary");
    expect(r.err).toContain("Operation not permitted");
  });

  test("a denied file can't be reached through a hard link, a clone or a symlink in cwd", () => {
    const secret = join(outside, "linked");
    mkdirSync(secret, { recursive: true });
    writeFileSync(join(secret, "note.txt"), "canary\n");
    const profile = seatbeltProfile({ cwd, writable: [cwd], extraDenyRead: [secret] });
    for (const make of ["ln", "cp -c", "ln -s"]) {
      const r = sandboxed(profile, `rm -f via; ${make} "${secret}/note.txt" via; cat via`);
      expect(r.out).not.toContain("canary");
      expect(r.err).toContain("Operation not permitted");
    }
  });

  test("open and osascript can't launch apps outside the sandbox", () => {
    const profile = seatbeltProfile({ cwd, writable: [cwd] });
    expect(sandboxed(profile, "/usr/bin/open -a TextEdit").exitCode).not.toBe(0);
    expect(sandboxed(profile, `/usr/bin/osascript -e 'tell application "Finder" to activate'`).exitCode).not.toBe(0);
  });

  test("loopback is unreachable, so an agent can't call Atrium's local API", () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("engine") });
    try {
      const profile = seatbeltProfile({ cwd, writable: [cwd] });
      expect(profile).toContain('(deny network-outbound (remote ip "localhost:*"))');
      for (const host of ["127.0.0.1", "localhost", "0.0.0.0", "[::ffff:127.0.0.1]"]) {
        const r = sandboxed(profile, `/usr/bin/curl -s --max-time 5 http://${host}:${server.port}/`);
        expect(r.out).not.toContain("engine");
        expect(r.exitCode).toBe(7);
      }
    } finally {
      server.stop(true);
    }
  });

  test("review profile has no writable cwd", () => {
    const profile = seatbeltProfile({ cwd, writable: [state] });
    const r = sandboxed(profile, `echo x > review.txt || echo no-cwd; echo x > "${state}/s.txt" && echo state-ok`);
    expect(r.out.trim().split("\n")).toEqual(["no-cwd", "state-ok"]);
  });

  test("work profile allows writes only in cwd, the run's temp dir and state dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "atrium-agent-"));
    const profile = seatbeltProfile({ cwd, writable: [cwd, state, tmp] });
    try {
      const script = [
        "echo x > work.txt && echo cwd-ok",
        `echo x > "${tmp}/t.txt" && echo temp-ok`,
        `echo x > "${tmpdir()}/atrium-canary-x" || echo shared-temp-denied`,
        `echo x > "${state}/s.txt" && echo state-ok`,
        "echo x > /dev/null && echo devnull-ok",
        `echo x > "${outside}/escape.txt" || echo outside-denied`,
        "echo x > .git/config || echo git-denied",
        "mkdir .claude || echo claude-denied",
        "mkdir .agents || echo agents-denied",
        "mv .git moved || echo git-rename-denied",
      ].join("\n");
      expect(sandboxed(profile, script).out.trim().split("\n")).toEqual([
        "cwd-ok", "temp-ok", "shared-temp-denied", "state-ok", "devnull-ok", "outside-denied", "git-denied", "claude-denied", "agents-denied", "git-rename-denied",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("paths are canonicalised, so a /tmp cwd still matches /private/tmp", () => {
    const viaSymlink = cwd.replace(/^\/private\/tmp\//, "/tmp/");
    expect(viaSymlink).not.toBe(cwd);
    const r = sandboxed(seatbeltProfile({ cwd: viaSymlink, writable: [viaSymlink] }), "echo x > link.txt && echo ok; echo x > .git/config || echo git-denied");
    expect(r.out.trim().split("\n")).toEqual(["ok", "git-denied"]);
  });

  test("a cwd with quotes, backslashes or a newline can't break out of its string", () => {
    const odd = join(outside, 'odd"dir\\ (deny file-read*)\nx');
    mkdirSync(join(odd, ".git"), { recursive: true });
    const profile = seatbeltProfile({ cwd: odd, writable: [odd] });
    const r = sandboxed(profile, `echo x > ok.txt && echo ok; echo x > .git/config || echo git-denied; echo x > "${outside}/escape.txt" || echo outside-denied`, odd);
    expect(r.err).not.toContain("sandbox-exec");
    expect(r.out.trim().split("\n")).toEqual(["ok", "git-denied", "outside-denied"]);
  });
});

describe("wrapInSeatbelt", () => {
  test("prefixes sandbox-exec with the profile", () => {
    const opts = { cwd, writable: [cwd] };
    expect(wrapInSeatbelt(["codex", "exec"], opts)).toEqual([SANDBOX_EXEC, "-p", seatbeltProfile(opts), "codex", "exec"]);
    expect(SANDBOX_EXEC).toBe("/usr/bin/sandbox-exec");
  });
});
