import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GhProblem, ghCreateRepo, ghCredentialFlags, ghLogin, ghProblem, ghViewRepo, runGh } from "../../../src/engine/repos/gh";
import type { ProjectDraft } from "../../../src/engine/repos/names";
import { type FakeGitHub, fakeGitHub, seedRemote } from "../../repos-helpers";

let gh: FakeGitHub;
beforeEach(() => {
  gh = fakeGitHub();
});
afterEach(() => gh.cleanup());

const draft = (over: Partial<ProjectDraft> = {}): ProjectDraft => ({ name: "demo", description: "x", visibility: "private", template: "bun-ts", ...over });

const problem = async (p: Promise<unknown>): Promise<GhProblem> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof GhProblem) return e;
    throw e;
  }
  throw new Error("expected a GhProblem");
};

test("ghCreateRepo runs gh with an exact argv and returns the URL", async () => {
  expect(await ghCreateRepo(draft())).toBe("https://github.com/fakeuser/demo");
  expect(gh.argv()).toEqual([["repo", "create", "--private", "--description=x", "--", "demo"]]);
});

test("a hostile description stays one argument", async () => {
  await ghCreateRepo(draft({ description: "--public" }));
  await ghCreateRepo(draft({ name: "demo2", description: "$(rm -rf ~)", visibility: "public" }));
  expect(gh.argv()).toEqual([
    ["repo", "create", "--private", "--description=--public", "--", "demo"],
    ["repo", "create", "--public", "--description=$(rm -rf ~)", "--", "demo2"],
  ]);
});

test("ghLogin reads the account name", async () => {
  expect(await ghLogin()).toBe("fakeuser");
});

test("each failure maps to its plain message", async () => {
  gh.env("logged_out");
  const out = await problem(ghLogin());
  expect(out.kind).toBe("logged_out");
  expect(out.message).toBe("gh is signed out of GitHub. Run `gh auth login` in a terminal, then approve again.");
  gh.env("name_taken");
  const taken = await problem(ghCreateRepo(draft()));
  expect(taken.kind).toBe("name_taken");
  expect(taken.message).toBe('You already have a GitHub repo called "demo". Change the name and approve again.');
  gh.env("offline");
  const off = await problem(ghLogin());
  expect(off.kind).toBe("offline");
  expect(off.message).toBe("Couldn't reach GitHub. Check your internet connection, then approve again.");
  gh.env("ok");
  const missing = await problem(ghViewRepo("fakeuser/nope"));
  expect(missing.kind).toBe("not_found");
  expect(missing.message).toBe("Couldn't find fakeuser/nope on GitHub, or your account can't see it. Check the name.");
});

test("a hung gh times out", async () => {
  gh.env("hang");
  const started = Date.now();
  const t = await problem(ghLogin({ timeoutMs: 300 }));
  expect(Date.now() - started).toBeLessThan(5000);
  expect(t.kind).toBe("timeout");
  expect(t.message).toBe("GitHub didn't answer within 30 seconds. If your Mac's keychain is locked, unlock it, then approve again.");
});

test("a missing gh says how to install it", async () => {
  process.env.ATRIUM_GH_BIN = join(gh.base, "no-such-gh");
  expect((await runGh(["api", "user"])).code).toBe(127);
  const p = await problem(ghLogin());
  expect(p.kind).toBe("not_installed");
  expect(p.message).toBe("GitHub CLI (gh) isn't installed. Install it with `brew install gh`, run `gh auth login`, then approve again.");
  expect(() => ghCredentialFlags()).toThrow(GhProblem);
});

test("ghProblem falls back to gh's own first line", () => {
  const p = ghProblem({ code: 1, out: "", err: "something odd\nmore", timedOut: false }, {});
  expect(p.kind).toBe("other");
  expect(p.message).toBe("GitHub said: something odd");
});

test("ghCredentialFlags names the gh helper after clearing others", () => {
  expect(ghCredentialFlags()).toEqual(["-c", "credential.helper=", "-c", `credential.helper=!${process.env.ATRIUM_GH_BIN} auth git-credential`]);
});

test("ghCredentialFlags refuses a gh path git's shell would split", () => {
  const dir = join(gh.base, "a b");
  mkdirSync(dir);
  copyFileSync(process.env.ATRIUM_GH_BIN!, join(dir, "gh"));
  Bun.spawnSync(["chmod", "+x", join(dir, "gh")]);
  process.env.ATRIUM_GH_BIN = join(dir, "gh");
  expect(() => ghCredentialFlags()).toThrow(GhProblem);
});

test("a URL for a different repo is refused", async () => {
  const fake = join(gh.base, "liar-gh");
  await Bun.write(fake, '#!/bin/sh\necho "https://github.com/fakeuser/other"\n');
  Bun.spawnSync(["chmod", "+x", fake]);
  process.env.ATRIUM_GH_BIN = fake;
  const p = await problem(ghCreateRepo(draft()));
  expect(p.kind).toBe("other");
});

test("ghViewRepo reads an existing repo", async () => {
  seedRemote(gh, "demo");
  expect(await ghViewRepo("fakeuser/demo")).toEqual({ nameWithOwner: "fakeuser/demo", isPrivate: true, url: "https://github.com/fakeuser/demo" });
});
