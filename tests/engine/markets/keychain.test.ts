import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKeychain, isKeyShaped, KeychainError } from "../../../src/engine/markets/keychain";
import { redact } from "../../../src/engine/markets/redact";

const FAKE = resolve(import.meta.dir, "../../fixtures/fake-security.ts");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atrium-keychain-"));
  process.env.FAKE_SECURITY_STORE = join(dir, "store.json");
  process.env.FAKE_SECURITY_ARGV = join(dir, "argv.log");
});
afterEach(() => {
  delete process.env.FAKE_SECURITY_STORE;
  delete process.env.FAKE_SECURITY_ARGV;
  delete process.env.FAKE_SECURITY_FAIL;
  rmSync(dir, { recursive: true, force: true });
});

test("set then get round-trips; missing is null; remove works", async () => {
  const k = createKeychain(FAKE);
  expect(await k.get("alpaca.keyId")).toBeNull();
  await k.set("alpaca.keyId", "PKTEST12345");
  expect(await k.get("alpaca.keyId")).toBe("PKTEST12345");
  await k.remove("alpaca.keyId");
  expect(await k.get("alpaca.keyId")).toBeNull();
  await k.remove("alpaca.keyId");
});

test("secret never in argv", async () => {
  await createKeychain(FAKE).set("alpaca.secret", "CANARYsecret123");
  const argv = readFileSync(process.env.FAKE_SECURITY_ARGV!, "utf8");
  expect(argv).toContain("-i");
  expect(argv).not.toContain("CANARYsecret123");
  expect(readFileSync(process.env.FAKE_SECURITY_STORE!, "utf8")).toContain("CANARYsecret123");
});

test("set refuses non-key text", async () => {
  const k = createKeychain(FAKE);
  const p = k.set("alpaca.secret", 'a b"c');
  await expect(p).rejects.toBeInstanceOf(KeychainError);
  await expect(k.set("alpaca.secret", 'a b"c')).rejects.toThrow("That doesn't look like a key: keys are letters and numbers only.");
  expect(await k.get("alpaca.secret")).toBeNull();
});

test("errors are plain and secret-free", async () => {
  process.env.FAKE_SECURITY_FAIL = "1";
  const err = await createKeychain(FAKE).set("alpaca.secret", "CANARYsecret123").catch((e) => e);
  expect(err).toBeInstanceOf(KeychainError);
  expect(err.message).toBe("Couldn't save to your Mac's Keychain. Open Keychain Access to check it isn't locked, then try again.");
  expect(err.message).not.toContain("CANARY");
  const getErr = await createKeychain(FAKE).get("alpaca.secret").catch((e) => e);
  expect(getErr).toBeInstanceOf(KeychainError);
});

test("isKeyShaped", () => {
  expect(isKeyShaped("PKABCDEF12")).toBe(true);
  expect(isKeyShaped("short")).toBe(false);
  expect(isKeyShaped("has space 1234")).toBe(false);
});

test("redact", () => {
  expect(redact("GET https://finnhub.io/api/v1/quote?symbol=X&token=abc123XYZ failed", [])).not.toContain("abc123XYZ");
  expect(redact("bad key PKCANARY99", ["PKCANARY99"])).toBe("bad key [redacted]");
  expect(redact("https://x/q?apikey=ZZZ999&a=1", [])).toBe("https://x/q?apikey=[redacted]&a=1");
  expect(redact("abc", [null, undefined, "ab"])).toBe("abc");
});

test("a read that hangs (an unlock dialog) times out with a plain message", async () => {
  process.env.FAKE_SECURITY_HANG = "1";
  try {
    const started = Date.now();
    const err = await createKeychain(FAKE, { timeoutMs: 200 }).get("alpaca.keyId").catch((e) => e);
    expect(err).toBeInstanceOf(KeychainError);
    expect(err.message).toBe("Keychain is locked. Unlock it, then press Test in Settings → Market data.");
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    delete process.env.FAKE_SECURITY_HANG;
  }
});
