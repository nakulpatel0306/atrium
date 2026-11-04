import { homedir } from "node:os";
import { join } from "node:path";

export function config() {
  const home = process.env.ATRIUM_HOME ?? join(homedir(), "Library", "Application Support", "Atrium");
  return {
    home,
    dbPath: join(home, "atrium.db"),
    transcriptsDir: join(home, "transcripts"),
    port: 7420 as const,
    host: "127.0.0.1" as const,
    claudeBin: process.env.ATRIUM_CLAUDE_BIN ?? "claude",
    transcriptCapBytes: 209715200 as const,
    transcriptFileCapBytes: 5242880 as const,
  };
}
