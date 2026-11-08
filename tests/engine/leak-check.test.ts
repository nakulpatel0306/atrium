import { expect, test } from "bun:test";
import { loadDenylist, scanFiles, scanText } from "../../scripts/leak-check";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const kinds = (text: string, deny: string[] = []) => scanText("f.ts", text, deny).map((h) => h.kind);

test("home folder paths are flagged unless they are obvious placeholders", () => {
  expect(kinds("const p = '/Users/jdoe/code/app'")).toEqual(["home folder path"]);
  expect(kinds("const p = '/Users/me/Projects/app'")).toEqual([]);
});

test("phone numbers are flagged unless they are in the 555 fiction range", () => {
  expect(kinds("call +1 416 867 5309")).toEqual(["phone number"]);
  expect(kinds("call (212) 867-5309")).toEqual(["phone number"]);
  expect(kinds("call +1 555 010 0134")).toEqual([]);
  expect(kinds("call 416-555-0134")).toEqual([]);
});

test("emails must be example.com or a GitHub noreply address", () => {
  expect(kinds("mail jane.doe@gmail.com")).toEqual(["email"]);
  expect(kinds("mail jane@example.com")).toEqual([]);
  expect(kinds("mail 12345+jane@users.noreply.github.com")).toEqual([]);
});

test("secret-looking tokens are flagged", () => {
  expect(kinds(`const k = "sk-${"a1B2".repeat(8)}"`)).toEqual(["secret-looking token"]);
  expect(kinds(`token: "${"Zz9".repeat(10)}"`)).toEqual(["secret-looking token"]);
  expect(kinds("const note = 'a short token name'")).toEqual([]);
});

test("a private denylist matches case-insensitively and reports file and line", () => {
  const hits = scanText("a.md", "fine\nMeet Jordan Q. Example here", ["jordan q. example"]);
  expect(hits).toEqual([{ file: "a.md", line: 2, kind: "denylisted term", text: "Meet Jordan Q. Example here" }]);
});

test("the denylist file is read from a path, skipping blanks and comments; docs/plans is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-leak-"));
  try {
    writeFileSync(join(dir, "deny.txt"), "# private\nSecretTerm\n\n");
    expect(loadDenylist(join(dir, "deny.txt"))).toEqual(["SecretTerm"]);
    expect(() => loadDenylist(join(dir, "missing.txt"))).toThrow("Denylist not found");
    mkdirSync(join(dir, "docs", "plans"), { recursive: true });
    writeFileSync(join(dir, "docs", "plans", "p.md"), "secretterm /Users/jdoe/x/");
    writeFileSync(join(dir, "n.md"), "secretterm");
    expect(scanFiles(["docs/plans/p.md", "n.md"], dir, ["secretterm"]).map((h) => h.file)).toEqual(["n.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("denylist terms match whole words only, and terms with spaces or punctuation still work", () => {
  const hit = (text: string, term: string) => scanText("f.md", text, [term]).length;
  expect(hit("Jordan came by", "jordan")).toBe(1);
  expect(hit("hi jordan, hello", "jordan")).toBe(1);
  expect(hit("The MARSH road", "jordan")).toBe(0);
  expect(hit("Lives at 12 Elm St., Toronto", "12 Elm St.")).toBe(1);
  expect(hit("Doe, Jane signed", "doe, jane")).toBe(1);
  expect(hit("a.b matches", "a.b")).toBe(1);
  expect(hit("axb is not it", "a.b")).toBe(0);
});
