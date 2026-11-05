import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { config } from "../config";

// Atrium's own folder holds every space's work, the database and the transcripts. A run may use only its own
// space folder (the cwd of a Claude general-space run); everything else there is denied. Listed fresh for each
// run so new spaces and files are covered; the known files are named even before they exist.
export function atriumDenyPaths(cwd: string): string[] {
  const { home, dbPath, transcriptsDir } = config();
  const spaces = join(home, "spaces");
  const own = ownSpace(cwd, spaces);
  const paths = new Set([dbPath, `${dbPath}-wal`, `${dbPath}-shm`, transcriptsDir, join(home, "engine.log")]);
  for (const name of list(home)) if (name !== "spaces") paths.add(join(home, name));
  if (own) for (const name of list(spaces)) if (name !== own) paths.add(join(spaces, name));
  // A repo or scratch run has no space folder of its own here.
  if (!own) paths.add(spaces);
  return [...paths];
}

const list = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

function ownSpace(cwd: string, spaces: string): string | null {
  const rel = relative(spaces, cwd);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep)[0]!;
}
