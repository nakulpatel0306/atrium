#!/usr/bin/env bun
// Stands in for the GitHub CLI. Repos are bare git repos under $FAKE_GH_REMOTES/<owner>/<name>.git.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(argv)}\n`);
const mode = process.env.FAKE_GH_MODE ?? "ok";
const remotes = process.env.FAKE_GH_REMOTES ?? "";
const fail = (msg: string, code = 1): never => {
  console.error(msg);
  process.exit(code);
};

if (argv[0] === "auth" && argv[1] === "git-credential") {
  process.stdout.write("username=fakeuser\npassword=fake\n");
  process.exit(0);
}
if (mode === "hang") await Bun.sleep(120_000);
if (mode === "logged_out") fail("To get started with GitHub CLI, please run:  gh auth login", 4);
if (mode === "offline") fail("error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com");

if (argv[0] === "api" && argv[1] === "user") {
  console.log("fakeuser");
  process.exit(0);
}
if (argv[0] === "repo" && argv[1] === "create") {
  const name = argv[argv.indexOf("--") + 1]!;
  const bare = join(remotes, "fakeuser", `${name}.git`);
  if (mode === "name_taken" || existsSync(bare)) fail("GraphQL: Name already exists on this account (createRepository)");
  mkdirSync(join(remotes, "fakeuser"), { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", bare]);
  if (init.exitCode !== 0) fail(init.stderr.toString());
  // A repo that exists but refuses the first push.
  if (mode === "readonly_remote") Bun.spawnSync(["chmod", "-R", "a-w", bare]);
  console.log(`https://github.com/fakeuser/${name}`);
  process.exit(0);
}
if (argv[0] === "repo" && argv[1] === "view") {
  const rest = argv.slice(2).filter((a) => a !== "--");
  const slug = rest[0]!;
  if (!existsSync(join(remotes, `${slug}.git`))) fail("GraphQL: Could not resolve to a Repository with the name '" + slug + "'. (repository)");
  console.log(JSON.stringify({ nameWithOwner: slug, isPrivate: true, url: `https://github.com/${slug}` }));
  process.exit(0);
}
fail(`fake gh: unknown command ${argv.join(" ")}`);
