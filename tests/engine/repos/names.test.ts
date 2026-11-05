import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadDraft, projectPath, slugifyName, validateDescription, validateDraft, validateRepoName } from "../../../src/engine/repos/names";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atrium-projects-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ok = { name: "demo", description: "A demo", visibility: "private", template: "bun-ts" };

test("valid repo names pass", () => {
  expect(validateRepoName("atrium-flow-check-20261105")).toBe("atrium-flow-check-20261105");
  expect(validateRepoName("My.Repo_2")).toBe("My.Repo_2");
});

test("invalid repo names throw BadDraft", () => {
  for (const n of ["x.", "trailing..", "--foo", "-x", ".hidden", "../evil", "a/b", "a..b", "x.git", "X.GIT", "has space", "naïve", "名前", "", "a".repeat(101), "a\u0000b", "a\nb"]) {
    expect(() => validateRepoName(n)).toThrow(BadDraft);
  }
  expect(() => validateRepoName("--foo")).toThrow(
    'Repo names use letters, numbers, ".", "-" and "_", start with a letter or number, and are at most 100 characters.',
  );
});

test("slugifyName makes a repo name from free text", () => {
  expect(slugifyName("My New Project!")).toBe("my-new-project");
  expect(slugifyName("Café ✨ App")).toBe("cafe-app");
  expect(slugifyName("../../etc")).toBe("etc");
  expect(slugifyName("x".repeat(150))).toHaveLength(100);
});

test("descriptions are one line under 350 characters", () => {
  expect(validateDescription("  hi  ")).toBe("hi");
  expect(() => validateDescription("a\nb")).toThrow("Keep the description to one line under 350 characters.");
  expect(() => validateDescription("a\u0007b")).toThrow(BadDraft);
  expect(validateDescription("d".repeat(350))).toHaveLength(350);
  expect(() => validateDescription("d".repeat(351))).toThrow(BadDraft);
});

test("projectPath refuses a name taken in any case", () => {
  expect(projectPath("demo", root)).toBe(join(root, "demo"));
  mkdirSync(join(root, "atrium"));
  expect(() => projectPath("Atrium", root)).toThrow(BadDraft);
  expect(() => projectPath("Atrium", root)).toThrow('A folder named "atrium" already exists in');
});

test("validateDraft is strict about values and drops unknown keys", () => {
  expect(() => validateDraft({ ...ok, template: "../../x" })).toThrow("Template must be bun + TypeScript or Empty.");
  expect(() => validateDraft({ ...ok, visibility: "PUBLIC" })).toThrow("Visibility must be private or public.");
  expect(() => validateDraft({ ...ok, name: 5 })).toThrow(BadDraft);
  expect(() => validateDraft(null)).toThrow(BadDraft);
  const d = validateDraft({ ...ok, path: "/etc", approved: true });
  expect(d).toEqual({ name: "demo", description: "A demo", visibility: "private", template: "bun-ts" });
});

test("descriptions can't hide text with direction marks or line separators", () => {
  for (const c of ["\u200E", "\u200F", "\u202A", "\u202E", "\u2066", "\u2069", "\u2028", "\u2029"]) {
    expect(() => validateDescription(`safe${c}text`)).toThrow(BadDraft);
  }
});
