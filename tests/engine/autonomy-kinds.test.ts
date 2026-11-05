import { describe, expect, test } from "bun:test";
import { type ActionFacts, fingerprintOf, forbiddenFor, labelOf, parseFingerprint } from "../../src/engine/autonomy/kinds";
import type { ChangedFile } from "../../src/engine/git";

const f = (path: string, added: number | null = 1, deleted: number | null = 0, status: ChangedFile["status"] = "A"): ChangedFile => ({
  path,
  status,
  added,
  deleted,
});
const code = (files: ChangedFile[], agent = "claude", branch = "atrium/tsk_1"): ActionFacts => ({ domain: "code", agent, branch, files });

describe("fingerprintOf", () => {
  test("docs-only small diff", () => {
    const fp = fingerprintOf(code([f("README.md", 10, 2, "M"), f("docs/a.md", 30, 0)]));
    expect(fp).toBe("v1:code:docs:small:claude");
    expect(labelOf(fp!)).toBe("docs-only changes under 50 lines from Claude");
  });

  test("tests-only medium diff", () => {
    const fp = fingerprintOf(code([f("tests/x.test.ts", 120, 40, "M")], "codex"));
    expect(fp).toBe("v1:code:tests:medium:codex");
    expect(labelOf(fp!)).toBe("test-only changes under 200 lines from Codex");
  });

  test("a .md under tests counts as tests", () => {
    expect(fingerprintOf(code([f("tests/README.md"), f("src/a.spec.tsx")]))).toBe("v1:code:tests:small:claude");
  });

  test("mixed or source changes have no kind", () => {
    expect(fingerprintOf(code([f("src/a.ts"), f("README.md")]))).toBeNull();
    expect(fingerprintOf(code([f("src/a.ts")]))).toBeNull();
  });

  test("size limits", () => {
    expect(fingerprintOf(code([f("docs/a.md", 50, 0)]))).toBe("v1:code:docs:small:claude");
    expect(fingerprintOf(code([f("docs/a.md", 51, 0)]))).toBe("v1:code:docs:medium:claude");
    expect(fingerprintOf(code([f("docs/a.md", 150, 50)]))).toBe("v1:code:docs:medium:claude");
    expect(fingerprintOf(code([f("docs/a.md", 201, 0)]))).toBeNull();
    expect(fingerprintOf(code([f("docs/a.md", null, null)]))).toBeNull();
    expect(fingerprintOf(code([]))).toBeNull();
  });

  test("agent instruction files are never eligible", () => {
    for (const p of ["CLAUDE.md", "sub/AGENTS.md", "GEMINI.md", ".claude/settings.json", ".codex/x.md", ".gemini/notes.md", ".cursor/rules.md"]) {
      expect(fingerprintOf(code([f(p)]))).toBeNull();
    }
  });

  test("only a resolved agent gets a kind", () => {
    expect(fingerprintOf(code([f("docs/a.md")], "auto"))).toBeNull();
    expect(fingerprintOf({ domain: "general", agent: "auto", filesKept: 0 })).toBeNull();
  });

  test("general text", () => {
    const fp = fingerprintOf({ domain: "general", agent: "gemini", filesKept: 0 });
    expect(fp).toBe("v1:general:text:gemini");
    expect(labelOf(fp!)).toBe("text answers with no files from Gemini");
    expect(fingerprintOf({ domain: "general", agent: "gemini", filesKept: 2 })).toBeNull();
  });
});

describe("forbiddenFor", () => {
  test("forbidden: delete", () => {
    const facts = code([f("docs/old.md", 0, 3, "D")]);
    expect(forbiddenFor(facts)).toEqual(["delete"]);
    expect(fingerprintOf(facts)).toBeNull();
  });

  test("forbidden: secrets", () => {
    for (const p of [".env", "config/.env.local", "prod.env", "deploy/id_ed25519", "certs/site.pem", ".npmrc", "credentials.json"]) {
      const facts = code([f(p)]);
      expect(forbiddenFor(facts)).toContain("secrets");
      expect(fingerprintOf(facts)).toBeNull();
    }
  });

  test("forbidden: deploy", () => {
    for (const p of [".github/workflows/ci.yml", "vercel.json", "fly.toml", "Dockerfile", "netlify.toml"]) {
      const facts = code([f(p, 1, 0, "M")]);
      expect(forbiddenFor(facts)).toContain("deploy");
      expect(fingerprintOf(facts)).toBeNull();
    }
  });

  test("forbidden: merge_main", () => {
    const facts = code([f("docs/a.md")], "claude", "main");
    expect(forbiddenFor(facts)).toEqual(["merge_main"]);
    expect(fingerprintOf(facts)).toBeNull();
  });

  test("reasons are sorted and unique", () => {
    expect(forbiddenFor(code([f(".env", 0, 1, "D"), f("b.pem", 0, 1, "D")], "claude", "main"))).toEqual(["delete", "merge_main", "secrets"]);
  });

  test("general work is never forbidden by files", () => {
    expect(forbiddenFor({ domain: "general", agent: "claude", filesKept: 0 })).toEqual([]);
  });
});

describe("parseFingerprint", () => {
  test("parseFingerprint is strict", () => {
    for (const bad of [
      "v1:code:code:small:claude",
      "v1:code:docs:large:claude",
      "v1:code:docs:small:auto",
      "v2:code:docs:small:claude",
      "v1:code:docs:small:claude:extra",
      "v1:delete:x",
      "v1:general:text:auto",
      "v1:general:files:claude",
      "",
    ]) {
      expect(parseFingerprint(bad)).toBeNull();
    }
  });

  test("round-trips every fingerprint the engine produces", () => {
    expect(parseFingerprint("v1:code:docs:small:claude")).toEqual({ domain: "code", shape: "docs", size: "small", agent: "claude" });
    expect(parseFingerprint("v1:code:tests:medium:codex")).toEqual({ domain: "code", shape: "tests", size: "medium", agent: "codex" });
    expect(parseFingerprint("v1:general:text:gemini")).toEqual({ domain: "general", agent: "gemini" });
  });
});
