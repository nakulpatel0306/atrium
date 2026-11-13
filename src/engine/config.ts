import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The projects folder chosen in Settings, copied here from the database when it opens or changes so config() can
// stay synchronous. The ATRIUM_PROJECTS_ROOT environment variable still wins.
let chosenProjectsRoot: string | null = null;
export function setChosenProjectsRoot(path: string | null): void {
  chosenProjectsRoot = path;
}

// ~/Developer if the user already has one, else ~/Projects. Nothing is created until the folder is first used.
export function defaultProjectsRoot(): string {
  const developer = join(homedir(), "Developer");
  return existsSync(developer) ? developer : join(homedir(), "Projects");
}

export function config() {
  const home = process.env.ATRIUM_HOME ?? join(homedir(), "Library", "Application Support", "Atrium");
  return {
    home,
    // Where general spaces keep their files, visible in Finder. Outside ~/Documents and ~/Desktop so
    // iCloud never copies them off the Mac. An engine with its own ATRIUM_HOME (tests, a dev engine)
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
    // GitHub CLI; only src/engine/repos/gh.ts runs it. Tests point this at a fake.
    ghBin: process.env.ATRIUM_GH_BIN ?? "gh",
    // macOS's open, the only way Atrium launches a file. Tests and dev engines point it at a logging fake.
    openBin: process.env.ATRIUM_OPEN_BIN ?? "/usr/bin/open",
    // Where new projects and on-demand clones go.
    projectsRoot: process.env.ATRIUM_PROJECTS_ROOT ?? chosenProjectsRoot ?? defaultProjectsRoot(),
    transcriptCapBytes: 209715200 as const,
    transcriptFileCapBytes: 5242880 as const,
  };
}
