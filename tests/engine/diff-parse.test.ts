import { expect, test } from "bun:test";
import { parseDiff, totalsOf } from "../../src/engine/diff-parse";

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@ export function main() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a;
\\ No newline at end of file
`;

test("a modified file becomes one hunk with numbered lines", () => {
  const [f] = parseDiff(MODIFIED);
  expect(f).toMatchObject({ path: "src/app.ts", status: "modified", additions: 2, deletions: 1, binary: false, truncated: false });
  expect(f!.hunks).toHaveLength(1);
  expect(f!.hunks[0]!.header).toBe("@@ -1,3 +1,4 @@ export function main() {");
  expect(f!.hunks[0]!.lines).toEqual([
    { kind: "ctx", text: "const a = 1;", oldNo: 1, newNo: 1 },
    { kind: "del", text: "const b = 2;", oldNo: 2 },
    { kind: "add", text: "const b = 3;", newNo: 2 },
    { kind: "add", text: "const c = 4;", newNo: 3 },
    { kind: "ctx", text: "return a;", oldNo: 3, newNo: 4 },
  ]);
});

test("added, deleted, renamed and binary files get their status", () => {
  const text = `diff --git a/new file.md b/new file.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new file.md
@@ -0,0 +1 @@
+hello
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/a.ts b/b.ts
similarity index 90%
rename from a.ts
rename to b.ts
index 5555555..6666666 100644
--- a/a.ts
+++ b/b.ts
@@ -1 +1 @@
-x
+y
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/logo.png differ
`;
  const files = parseDiff(text);
  expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
    ["new file.md", "added", false],
    ["old.txt", "deleted", false],
    ["b.ts", "renamed", false],
    ["logo.png", "added", true],
  ]);
  expect(files[3]!.hunks).toEqual([]);
  expect(totalsOf(files)).toEqual({ files: 4, additions: 2, deletions: 2 });
});

test("a quoted path is unquoted, UTF-8 escapes included", () => {
  const text = `diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"
index 1..2 100644
--- "a/caf\\303\\251.md"
+++ "b/caf\\303\\251.md"
@@ -1 +1 @@
-a
+b
`;
  expect(parseDiff(text)[0]!.path).toBe("café.md");
});

test("a file over the line cap keeps its first lines, true counts and a truncated flag", () => {
  const body = Array.from({ length: 30 }, (_, i) => `+line ${i}`).join("\n");
  const text = `diff --git a/big.txt b/big.txt
new file mode 100644
--- /dev/null
+++ b/big.txt
@@ -0,0 +1,30 @@
${body}
`;
  const [f] = parseDiff(text, 10);
  expect(f!.truncated).toBe(true);
  expect(f!.additions).toBe(30);
  expect(f!.hunks[0]!.lines).toHaveLength(10);
});

test("empty input has no files", () => {
  expect(parseDiff("")).toEqual([]);
});
