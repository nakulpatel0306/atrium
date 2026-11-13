export const APP_ID = "com.atrium.app";

export const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type InfoOpts = { version: string; repoPath: string; bunPath: string; bundleId?: string };

function plist(entries: [string, string | boolean][]): string {
  const body = entries
    .map(([k, v]) => `  <key>${k}</key>\n  ${typeof v === "boolean" ? (v ? "<true/>" : "<false/>") : `<string>${xml(v)}</string>`}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

export function infoPlist(o: InfoOpts): string {
  const entries: [string, string | boolean][] = [
    ["CFBundleIdentifier", o.bundleId ?? APP_ID],
    ["CFBundleName", "Atrium"],
    ["CFBundleDisplayName", "Atrium"],
    ["CFBundleExecutable", "Atrium"],
    ["CFBundleIconFile", "Atrium"],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleShortVersionString", o.version],
    ["CFBundleVersion", o.version],
    ["LSMinimumSystemVersion", "14.0"],
    ["NSPrincipalClass", "NSApplication"],
    ["NSHighResolutionCapable", true],
    ["LSApplicationCategoryType", "public.app-category.productivity"],
    // The offline view's Start button runs `atrium install` with these when the engine was never installed.
    ["AtriumRepoPath", o.repoPath],
    ["AtriumBunPath", o.bunPath],
  ];
  return plist(entries);
}
