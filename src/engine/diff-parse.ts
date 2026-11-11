// Unified diff text (git diff --no-color) into the structure the Changes view draws.

export type DiffLine = { kind: "add" | "del" | "ctx"; text: string; oldNo?: number; newNo?: number };
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  hunks: DiffHunk[];
};
export type DiffResult = { files: DiffFile[]; totals: { files: number; additions: number; deletions: number }; truncated: boolean };

export const MAX_FILE_LINES = 2000;

// git quotes a path with unusual characters C-style ("a/t\303\251st"); the octal escapes are UTF-8 bytes.
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  const SIMPLE: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c));
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(SIMPLE[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString();
}

// "a/x" or "b/x" (or /dev/null) from a ---/+++ line, without the prefix.
function sidePath(raw: string): string | null {
  const p = unquote(raw.replace(/\t$/, ""));
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

// Only for a file with no ---/+++ lines (binary, or a mode-only change): "a/P b/P" splits in half when both sides match.
function headerPath(rest: string): string {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    return sidePath(rest.slice(end + 2)) ?? sidePath(rest.slice(0, end + 1)) ?? rest;
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(2, half);
  const b = rest.lastIndexOf(" b/");
  return b >= 0 ? rest.slice(b + 3) : rest;
}

export function parseDiff(text: string, maxLines = MAX_FILE_LINES): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let stored = 0;
  let oldNo = 0;
  let newNo = 0;
  let inHeader = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: headerPath(line.slice(11)), status: "modified", additions: 0, deletions: 0, binary: false, truncated: false, hunks: [] };
      files.push(file);
      hunk = null;
      stored = 0;
      inHeader = true;
      continue;
    }
    if (!file) continue;
    if (inHeader) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename to ")) {
        file.status = "renamed";
        file.path = unquote(line.slice(10));
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
      else if (line.startsWith("+++ ")) file.path = sidePath(line.slice(4)) ?? file.path;
      else if (line.startsWith("--- ")) {
        const old = sidePath(line.slice(4));
        if (old && file.status !== "renamed") file.path = old;
      }
      if (!line.startsWith("@@")) continue;
      inHeader = false;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { header: line, lines: [] };
      if (stored < maxLines) file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    let entry: DiffLine | null = null;
    if (line.startsWith("+")) {
      file.additions++;
      entry = { kind: "add", text: line.slice(1), newNo: newNo++ };
    } else if (line.startsWith("-")) {
      file.deletions++;
      entry = { kind: "del", text: line.slice(1), oldNo: oldNo++ };
    } else if (line.startsWith(" ")) {
      entry = { kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ };
    }
    if (!entry) continue;
    // Counting goes on past the cap, so +/− stay true for a file whose lines were cut.
    if (stored < maxLines) {
      hunk.lines.push(entry);
      stored++;
    } else file.truncated = true;
  }
  return files;
}

export function totalsOf(files: DiffFile[]): DiffResult["totals"] {
  return {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}
