import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { infoPlist } from "./plists";

export type BuildOpts = { outDir: string; repoPath?: string; bunPath?: string; bundleId?: string };

const root = resolve(import.meta.dir, "..", "..");
// Without an explicit target swiftc stamps the SDK's version as the minimum, and LaunchServices then refuses to open
// the app on an older running macOS.
const TARGET = ["-target", "arm64-apple-macos14.0"];
const ICON_SIZES = [16, 32, 128, 256, 512];

const swiftFiles = (dir: string) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".swift"))
    .map((f) => join(root, dir, f));

async function step(what: string, cmd: string[]): Promise<void> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`Couldn't ${what}: ${(err || out).trim().split("\n").slice(0, 12).join("\n")}`);
}

function version(): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  return pkg.version ?? "0.1.0";
}

export async function buildApp(o: BuildOpts): Promise<string> {
  if (!Bun.which("swiftc")) {
    throw new Error("The Xcode Command Line Tools aren't installed. Run xcode-select --install, then try again.");
  }
  const app = join(resolve(o.outDir), "Atrium.app");
  const contents = join(app, "Contents");
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "atrium-build-"));
  try {
    const svg = join(root, "src", "dashboard", "assets", "logo-mark.svg");
    await step("compile the Mac app", [
      "swiftc",
      "-O",
      ...TARGET,
      ...swiftFiles("mac/Sources/Core"),
      ...swiftFiles("mac/Sources/App"),
      "-o",
      join(contents, "MacOS", "Atrium"),
    ]);

    const iconTool = join(tmp, "icon");
    const png = join(tmp, "icon-1024.png");
    await step("compile the icon renderer", ["swiftc", ...TARGET, join(root, "mac", "Tools", "icon.swift"), "-o", iconTool]);
    await step("render the app icon", [iconTool, svg, png]);
    const iconset = join(tmp, "Atrium.iconset");
    mkdirSync(iconset);
    for (const size of ICON_SIZES) {
      await step("resize the app icon", ["sips", "-z", String(size), String(size), png, "--out", join(iconset, `icon_${size}x${size}.png`)]);
      const x2 = String(size * 2);
      await step("resize the app icon", ["sips", "-z", x2, x2, png, "--out", join(iconset, `icon_${size}x${size}@2x.png`)]);
    }
    await step("build the icon file", ["iconutil", "-c", "icns", iconset, "-o", join(contents, "Resources", "Atrium.icns")]);

    copyFileSync(svg, join(contents, "Resources", "logo-mark.svg"));
    writeFileSync(
      join(contents, "Info.plist"),
      infoPlist({ version: version(), repoPath: o.repoPath ?? root, bunPath: o.bunPath ?? process.execPath, bundleId: o.bundleId }),
    );
    await step("sign the app", ["codesign", "--force", "-s", "-", app]);
    await step("verify the app's signature", ["codesign", "--verify", "--strict", app]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return app;
}

if (import.meta.main) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("Usage: bun src/mac/build.ts <outDir>");
    process.exit(1);
  }
  console.log(await buildApp({ outDir }));
}
