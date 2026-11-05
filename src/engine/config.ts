import { homedir } from "node:os";
import { join } from "node:path";

export function config() {
  const home = process.env.ATRIUM_HOME ?? join(homedir(), "Library", "Application Support", "Atrium");
  return {
    home,
    dbPath: join(home, "atrium.db"),
    transcriptsDir: join(home, "transcripts"),
    // Overridable so tests and a dev engine can run beside the installed one.
    port: Number(process.env.ATRIUM_PORT ?? 7420),
    host: "127.0.0.1" as const,
    claudeBin: process.env.ATRIUM_CLAUDE_BIN ?? "claude",
    codexBin: process.env.ATRIUM_CODEX_BIN ?? "codex",
    geminiBin: process.env.ATRIUM_GEMINI_BIN ?? "agy",
    // The macOS Keychain CLI; tests point this at a fake.
    securityBin: process.env.ATRIUM_SECURITY_BIN ?? "/usr/bin/security",
    // GitHub CLI; only src/engine/repos/gh.ts runs it. Tests point this at a fake.
    ghBin: process.env.ATRIUM_GH_BIN ?? "gh",
    // Where new projects and on-demand clones go.
    projectsRoot: process.env.ATRIUM_PROJECTS_ROOT ?? join(homedir(), "dev-workspace", "projects"),
    marketNow: process.env.ATRIUM_MARKET_NOW ?? null,
    transcriptCapBytes: 209715200 as const,
    transcriptFileCapBytes: 5242880 as const,
  };
}
