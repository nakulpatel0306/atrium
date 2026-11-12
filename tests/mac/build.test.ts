import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, toolchainError } from "../../src/mac/build";
import { infoPlist } from "../../src/mac/plists";

const canBuild = process.platform === "darwin" && !!Bun.which("swiftc");
const outDir = mkdtempSync(join(tmpdir(), "atrium-app-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

let built: Promise<string> | undefined;
const app = () => (built ??= buildApp({ outDir, bundleId: "com.atrium.app.test" }));

const sh = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

test("infoPlist has the bundle keys and escapes values", () => {
  const plist = infoPlist({ version: "0.1.0", repoPath: "/a&b", bunPath: "/bin/bun" });
  expect(plist).toContain("<key>CFBundleIdentifier</key>\n  <string>com.atrium.app</string>");
  expect(plist).toContain("<string>14.0</string>");
  expect(plist).toContain("/a&amp;b");
  expect(plist).not.toContain("{{");
});

test("infoPlist takes another bundle id for a test copy", () => {
  const plist = infoPlist({ version: "0.1.0", repoPath: "/a", bunPath: "/bin/bun", bundleId: "com.atrium.app.test" });
  expect(plist).toContain("<string>com.atrium.app.test</string>");
});

test("a missing Command Line Tools install gives a plain message, without asking xcrun", () => {
  const asked: string[][] = [];
  const missing = toolchainError((cmd) => (asked.push(cmd), cmd[0] === "xcode-select" ? 2 : 0));
  expect(missing).toBe("The Xcode Command Line Tools aren't installed. Run xcode-select --install, then try again.");
  expect(asked).toEqual([["xcode-select", "-p"]]);
  expect(toolchainError((cmd) => (cmd[0] === "xcrun" ? 1 : 0))).toBe(
    "The Xcode Command Line Tools don't include swiftc. Run xcode-select --install, then try again.",
  );
  expect(toolchainError(() => 0)).toBeNull();
});

test.skipIf(!canBuild)(
  "build produces a signed bundle",
  async () => {
    const path = await app();
    expect(path).toEndWith("/Atrium.app");
    for (const f of ["Contents/MacOS/Atrium", "Contents/Resources/Atrium.icns", "Contents/Resources/logo-mark.svg"]) {
      expect(existsSync(join(path, f))).toBe(true);
    }
    expect(sh(["codesign", "--verify", "--strict", path]).code).toBe(0);
    const info = sh(["codesign", "-dv", path]).err;
    expect(info).toContain("Signature=adhoc");
    expect(info).toContain("Identifier=com.atrium.app.test\n");
    expect(sh(["plutil", "-extract", "CFBundleIdentifier", "raw", join(path, "Contents/Info.plist")]).out.trim()).toBe("com.atrium.app.test");
  },
  180_000,
);

test.skipIf(!canBuild)(
  "build sets minos 14.0",
  async () => {
    const path = await app();
    expect(sh(["otool", "-l", join(path, "Contents/MacOS/Atrium")]).out).toContain("minos 14.0");
  },
  180_000,
);

test.skipIf(!canBuild)(
  "the bundle carries the signed Mail and Calendar helper with its own permission reasons",
  async () => {
    const path = await app();
    const pim = join(path, "Contents/MacOS/atrium-pim");
    expect(existsSync(pim)).toBe(true);
    expect(sh(["codesign", "-dv", pim]).err).toContain("Identifier=com.atrium.pim\n");
    const section = sh(["otool", "-X", "-s", "__TEXT", "__info_plist", pim]).out;
    const bytes = Buffer.from(section.split("\n").flatMap((l) => l.split(/\s+/).slice(1)).filter((x) => /^[0-9a-f]{2}$/.test(x)).map((x) => parseInt(x, 16)));
    expect(bytes.toString("utf8")).toContain("NSCalendarsFullAccessUsageDescription");
    // An unknown command answers in the documented error shape, without touching Mail or Calendar.
    const r = sh([pim, "nonsense"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ error: { kind: "bad_args", message: "Unknown command nonsense." } });
  },
  180_000,
);
