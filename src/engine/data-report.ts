import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { tildePath } from "./folders";

export type DataLocation = { label: string; where: string; bytes: number | null; note: string };

// Total bytes under a path; a missing path is null, so "not there yet" reads differently from "empty".
export function sizeOf(path: string): number | null {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, name) => sum + (sizeOf(join(path, name)) ?? 0), 0);
}

// Where everything personal lives. Sizes come from the file system.
export function dataLocations(): DataLocation[] {
  const c = config();
  const db = sizeOf(c.dbPath) ?? null;
  const wal = [`${c.dbPath}-wal`, `${c.dbPath}-shm`].reduce((n, p) => n + (sizeOf(p) ?? 0), 0);
  return [
    { label: "Database", where: tildePath(c.dbPath), bytes: db === null ? null : db + wal, note: "Spaces, tasks, approvals, rules and settings." },
    { label: "Transcripts", where: tildePath(c.transcriptsDir), bytes: sizeOf(c.transcriptsDir), note: "What agents said and did, capped at 200 MB." },
    { label: "Space files", where: tildePath(c.filesHome), bytes: sizeOf(c.filesHome), note: "Notes and files from general spaces." },
  ];
}

export function formatBytes(n: number | null): string {
  if (n === null) return "not created yet";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// `oldData`: removed features left data in the database (and maybe the Keychain); see old-data.ts.
export function formatData(locs: DataLocation[], oldData: boolean): string {
  const rows = locs.map((l) => `  ${l.label.padEnd(12)} ${l.where}\n  ${"".padEnd(12)} ${formatBytes(l.bytes)} · ${l.note}`);
  return [
    "Everything Atrium keeps about you:",
    ...rows,
    "",
    "Your projects folder is yours and isn't listed: Atrium only clones into it.",
    ...(oldData
      ? [
          "An older Atrium left mail, texting, money and investing data in the database, and may have left sign-in tokens and keys in your Keychain.",
          "Run `atrium data remove-old` to see exactly what's there and remove it.",
        ]
      : []),
    "To remove all personal data, run `atrium uninstall`, quit Atrium, then delete the folders above.",
  ].join("\n");
}
