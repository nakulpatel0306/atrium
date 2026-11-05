import { expect, test } from "bun:test";
import { ENV_FILE_PATTERN } from "../../src/engine/agents/seatbelt";
import { ENV_GLOBS, isEnvPath } from "../../src/engine/envpath";

const HITS = [".env", ".env.local", ".ENV.local", ".envrc", "prod.env", "PROD.ENV", "config/.env.production", ".env.d/keys", "x.env/inner"];
const MISSES = ["my.env.txt", "environment", "env", "a.envrc", "x.envy", "env.d/file", "src/envelope.ts"];

test("isEnvPath matches any segment starting or ending with .env, in any case", () => {
  for (const p of HITS) expect(isEnvPath(p)).toBe(true);
  for (const p of MISSES) expect(isEnvPath(p)).toBe(false);
});

test("the seatbelt pattern agrees with isEnvPath", () => {
  const re = new RegExp(ENV_FILE_PATTERN);
  for (const p of [...HITS, ...MISSES]) expect(re.test(`/repo/${p}`)).toBe(isEnvPath(p));
});

// Claude's permission rules and sandbox paths take globs; these must cover the same names in any case.
test("ENV_GLOBS cover the same names as isEnvPath, in any case", () => {
  const glob = (g: string) => new RegExp(`^${g.replace(/\./g, "\\.").replace(/\*/g, "[^/]*")}$`);
  const matches = (name: string) => ENV_GLOBS.some((g) => glob(g).test(name));
  for (const name of [".env", ".ENV.local", ".Env", "prod.env", "PROD.ENV", ".envrc"]) expect(matches(name)).toBe(true);
  for (const name of ["my.env.txt", "environment", "env", "x.envy"]) expect(matches(name)).toBe(false);
});
