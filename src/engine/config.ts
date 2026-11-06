import { homedir } from "node:os";
import { join } from "node:path";

export function config() {
  const home = process.env.ATRIUM_HOME ?? join(homedir(), "Library", "Application Support", "Atrium");
  return {
    home,
    // Where general and markets spaces keep their files, visible in Finder. Outside ~/Documents and ~/Desktop so
    // iCloud never copies Investing notes off the Mac. An engine with its own ATRIUM_HOME (tests, a dev engine)
    // keeps them inside it unless told otherwise, so it never writes into the real ~/Atrium.
    filesHome: process.env.ATRIUM_FILES_HOME ?? (process.env.ATRIUM_HOME ? join(home, "files") : join(homedir(), "Atrium")),
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
    // macOS's open, the only way Atrium launches a file. Tests and dev engines point it at a logging fake.
    openBin: process.env.ATRIUM_OPEN_BIN ?? "/usr/bin/open",
    // Where new projects and on-demand clones go.
    projectsRoot: process.env.ATRIUM_PROJECTS_ROOT ?? join(homedir(), "dev-workspace", "projects"),
    marketNow: process.env.ATRIUM_MARKET_NOW ?? null,
    transcriptCapBytes: 209715200 as const,
    transcriptFileCapBytes: 5242880 as const,
  };
}
