import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, ENV_FILE_PATTERN, SANDBOX_EXEC, seatbeltProfile, wrapInSeatbelt } from "../../src/engine/agents/seatbelt";
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
  // Any binary that asks for a Keychain item (a copied or renamed `security` included) reads the keychain file itself,
  // so the denied ~/Library/Keychains is what stops it; securityd's own services are cut off for Codex as well. The
  // check uses a throwaway keychain in a denied folder so the login keychain is untouched.
  test("a keychain in a denied folder can't be read, whatever binary asks", () => {
    if (process.platform !== "darwin") return;
    const dir = join(outside, "keychains");
    mkdirSync(dir, { recursive: true });
    const kc = join(dir, "probe.keychain");
    const sec = (...a: string[]) => Bun.spawnSync(["/usr/bin/security", ...a], { stdout: "pipe", stderr: "pipe" }).exitCode;
    expect(sec("create-keychain", "-p", "probe", kc)).toBe(0);
    try {
      expect(sec("add-generic-password", "-s", "AtriumProbe", "-a", "probe", "-w", "probevalue123", kc)).toBe(0);
      // The exec rule would stop /usr/bin/security before the read rule is reached, so it's taken out here.
      const strip = (p: string) => p.replace('(deny process-exec (literal "/usr/bin/security"))', "");
      const find = `/usr/bin/security find-generic-password -s AtriumProbe -a probe '${kc}'`;
      const denied = seatbeltProfile({ cwd, writable: [cwd], extraDenyRead: [dir], denyKeychain: true });
      expect(denied).toContain('(global-name-prefix "com.apple.securityd")');
      expect(sandboxed(strip(denied), find).exitCode).not.toBe(0);
      expect(sandboxed(strip(seatbeltProfile({ cwd, writable: [cwd], denyKeychain: true })), find).exitCode).toBe(0);
    } finally {
      sec("delete-keychain", kc);
    }
  });

  test("security CLI can't run under the profile", () => {
    if (process.platform !== "darwin") return;
    const profile = seatbeltProfile({ cwd, writable: [cwd] });
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/security"))');
    const r = sandboxed(profile, "/usr/bin/security help");
    expect(r.exitCode).not.toBe(0);
  });

  // No application is named, so even outside the sandbox this would ask macOS for nothing.
  test("osascript can't run under the profile", () => {
    if (process.platform !== "darwin") return;
    const profile = seatbeltProfile({ cwd, writable: [cwd] });
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/osascript"))');
    expect(profile).toContain("(deny appleevent-send)");
    const r = sandboxed(profile, "/usr/bin/osascript -e 'return 1'");
    expect(r.exitCode).not.toBe(0);
    expect(r.out + r.err).toContain("Operation not permitted");
  });

  // --help only prints usage; no shortcut is listed or run, and under the profile it can't start at all.
  test("I3: the shortcuts CLI can't run under the profile", () => {
    if (process.platform !== "darwin") return;
    const profile = seatbeltProfile({ cwd, writable: [cwd] });
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/shortcuts"))');
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/automator"))');
    expect(profile).toContain('(global-name-prefix "com.apple.shortcuts")');
    expect(profile).toContain('(global-name-prefix "com.apple.WorkflowKit")');
    const r = sandboxed(profile, "/usr/bin/shortcuts --help");
    expect(r.exitCode).not.toBe(0);
    expect(r.out + r.err).toContain("Operation not permitted");
  });

  test("M7: the Messages and Contacts stores are denied", () => {
    const profile = seatbeltProfile({ cwd, writable: [cwd] });
    for (const p of ["Library/Messages", "Library/Application Support/AddressBook", "Library/Contacts"]) expect(profile).toContain(p);
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

  test("an agent can't delete a space through the engine, even with a forged Origin", async () => {
    // The engine runs in its own process, so if the sandbox let the request through it would be answered.
    const engine = Bun.spawn(["bun", join(import.meta.dir, "../fixtures/delete-server.ts")], { stdout: "pipe", stderr: "inherit", env: process.env });
    try {
      const reader = engine.stdout.getReader();
      let line = "";
      while (!line.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        line += new TextDecoder().decode(value);
      }
      const { port, ids } = JSON.parse(line) as { port: number; ids: [string, string] };
      const curl = (id: string) =>
        `/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X DELETE -H "Origin: http://127.0.0.1:${port}" -H "Content-Type: application/json" -d '{"name":"Text Dana"}' http://127.0.0.1:${port}/api/spaces/${id}`;
      const run = async (argv: string[]) => {
        const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
        const out = await new Response(p.stdout).text();
        return { code: await p.exited, out };
      };
      const spaces = async () => ((await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as { spaces: { id: string }[] }).spaces.map((s) => s.id);

      const profile = seatbeltProfile({ cwd, writable: [cwd] });
      const inside = await run([SANDBOX_EXEC, "-p", profile, "/bin/sh", "-c", curl(ids[0])]);
      expect(inside.code).toBe(7);
      expect(await spaces()).toContain(ids[0]);
      // Control: the same request from outside the sandbox does reach the engine and delete.
      const outside = await run(["/bin/sh", "-c", curl(ids[1])]);
      expect(outside.out).toBe("200");
      expect(await spaces()).not.toContain(ids[1]);
    } finally {
      engine.kill("SIGTERM");
      await engine.exited;
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

describe("agents can't reach GitHub credentials", () => {
  const FAKE_GH = join(import.meta.dir, "..", "fixtures", "fake-gh.ts");

  test("agentEnv drops GitHub tokens, askpass helpers and the SSH agent", () => {
    const names = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS"];
    const env = agentEnv({ PATH: "/usr/bin", HOME: "/h", ...Object.fromEntries(names.map((n) => [n, "x"])) });
    for (const n of names) expect(n in env).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/h");
  });

  test("the profile blocks gh, port 22 and the SSH agent socket", () => {
    const saved = { gh: process.env.ATRIUM_GH_BIN, sock: process.env.SSH_AUTH_SOCK };
    process.env.ATRIUM_GH_BIN = FAKE_GH;
    process.env.SSH_AUTH_SOCK = join(outside, "agent.sock");
    try {
      const profile = seatbeltProfile({ cwd, writable: [cwd] });
      expect(profile).toContain(`(deny process-exec (literal "${realpathSync(FAKE_GH)}")`);
      expect(profile).toContain('(deny network-outbound (remote tcp "*:22"))');
      // Every local socket, named by SSH_AUTH_SOCK or not, except DNS.
      expect(profile).toContain("(deny network-outbound (remote unix-socket))");
      expect(profile).toContain('(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))');
      expect(profile).not.toContain(join(outside, "agent.sock"));
    } finally {
      for (const [k, v] of [["ATRIUM_GH_BIN", saved.gh], ["SSH_AUTH_SOCK", saved.sock]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("under the profile gh can't run, the SSH agent can't be reached, and HTTPS still works", () => {
    if (process.platform !== "darwin") return;
    const saved = { gh: process.env.ATRIUM_GH_BIN, sock: process.env.SSH_AUTH_SOCK };
    const sock = join(outside, "test-agent.sock");
    const agent = Bun.spawnSync(["ssh-agent", "-a", sock, "-s"], { stdout: "pipe" }).stdout.toString();
    const pid = /SSH_AGENT_PID=(\d+)/.exec(agent)?.[1];
    process.env.ATRIUM_GH_BIN = FAKE_GH;
    process.env.SSH_AUTH_SOCK = sock;
    try {
      // Reachable without the profile: exit 1 means "connected, no identities".
      expect(Bun.spawnSync(["ssh-add", "-l"], { env: { ...process.env, SSH_AUTH_SOCK: sock } }).exitCode).toBe(1);
      const profile = seatbeltProfile({ cwd, writable: [cwd] });
      const gh = sandboxed(profile, `'${FAKE_GH}' api user`);
      expect(gh.exitCode).not.toBe(0);
      expect(gh.err).toContain("Operation not permitted");
      // Exit 2: ssh-add couldn't talk to the agent at all.
      expect(sandboxed(profile, `SSH_AUTH_SOCK='${sock}' ssh-add -l`).exitCode).toBe(2);
      // The launchd engine may not have SSH_AUTH_SOCK while the socket still exists: blocked all the same.
      delete process.env.SSH_AUTH_SOCK;
      expect(sandboxed(seatbeltProfile({ cwd, writable: [cwd] }), `SSH_AUTH_SOCK='${sock}' ssh-add -l`).exitCode).toBe(2);
      expect(sandboxed(profile, "curl -sI -m 10 -o /dev/null -w '%{http_code}' https://github.com").out).toBe("200");
    } finally {
      if (pid) process.kill(Number(pid));
      for (const [k, v] of [["ATRIUM_GH_BIN", saved.gh], ["SSH_AUTH_SOCK", saved.sock]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// GitHub also takes SSH on port 443. With ~/.ssh unreadable and no agent, there's no key to offer.
test("SSH to GitHub over port 443 finds no key under the profile", () => {
  if (process.platform !== "darwin") return;
  const profile = seatbeltProfile({ cwd, writable: [cwd] });
  const r = sandboxed(
    profile,
    "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -T -p 443 git@ssh.github.com",
  );
  expect(r.exitCode).not.toBe(0);
  expect(r.err).not.toContain("successfully authenticated");
}, 30_000);
