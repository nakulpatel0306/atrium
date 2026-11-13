import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { config } from "../config";

// Atrium's data folder holds the database, the transcripts and old spaces' folders; the visible files folder
// (~/Atrium) holds every general space's work. A run may use only its own space folder (the cwd of a
// Claude general-space run); everything else in both is denied. Listed fresh for each run so new spaces and files
// are covered; the known files are named even before they exist.
export function atriumDenyPaths(cwd: string): string[] {
  const { home, dbPath, transcriptsDir, filesHome } = config();
  const spaces = join(home, "spaces");
  const paths = new Set([dbPath, `${dbPath}-wal`, `${dbPath}-shm`, transcriptsDir, join(home, "engine.log")]);
  // A dev or test engine with folders of its own must still keep its agents out of the real ones.
  const realHome = join(homedir(), "Library", "Application Support", "Atrium");
  const realFiles = join(homedir(), "Atrium");
  if (realHome !== home) paths.add(realHome);
  if (realFiles !== filesHome) paths.add(realFiles);
  // An engine with its own ATRIUM_HOME keeps the files folder inside it; that one is handled below.
  for (const name of list(home)) if (name !== "spaces" && join(home, name) !== filesHome) paths.add(join(home, name));
  for (const root of [spaces, filesHome]) {
    const own = ownSpace(cwd, root);
    // A repo or scratch run has no space folder of its own here.
    if (!own) paths.add(root);
    else for (const name of list(root)) if (name !== own) paths.add(join(root, name));
  }
  return [...paths];
}

const list = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

function ownSpace(cwd: string, root: string): string | null {
  const rel = relative(root, cwd);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep)[0]!;
}
