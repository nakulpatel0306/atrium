import { expect, test } from "bun:test";
import { ENV_FILE_PATTERN } from "../../src/engine/agents/seatbelt";
import { isEnvPath } from "../../src/engine/envpath";

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
