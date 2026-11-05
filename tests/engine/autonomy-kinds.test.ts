import { describe, expect, test } from "bun:test";
import { type ActionFacts, fingerprintOf, forbiddenFor, labelOf, parseFingerprint } from "../../src/engine/autonomy/kinds";
import type { ChangedFile } from "../../src/engine/git";

const MODES: Record<ChangedFile["status"], [string, string]> = { A: ["000000", "100644"], M: ["100644", "100644"], D: ["100644", "000000"], T: ["100644", "120000"] };
const f = (path: string, added: number | null = 1, deleted: number | null = 0, status: ChangedFile["status"] = "A"): ChangedFile => ({
  path,
  status,
  added,
  deleted,
  oldMode: MODES[status][0],
  newMode: MODES[status][1],
});
const code = (files: ChangedFile[], agent = "claude", branch = "atrium/tsk_1"): ActionFacts => ({ domain: "code", agent, branch, files });

describe("fingerprintOf", () => {
  test("docs-only small diff", () => {
    const fp = fingerprintOf(code([f("README.md", 10, 2, "M"), f("docs/a.md", 30, 0)]));
    expect(fp).toBe("v1:code:docs:small:claude");
    expect(labelOf(fp!)).toBe("docs-only changes under 50 lines from Claude");
  });

  test("medium docs diff", () => {
    const fp = fingerprintOf(code([f("docs/guide.mdx", 120, 40, "M")], "codex"));
    expect(fp).toBe("v1:code:docs:medium:codex");
    expect(labelOf(fp!)).toBe("docs-only changes under 200 lines from Codex");
  });

  test("tests are code: never eligible", () => {
    expect(fingerprintOf(code([f("tests/foo.test.ts", 5, 0, "M")]))).toBeNull();
    expect(fingerprintOf(code([f("src/a.spec.tsx")]))).toBeNull();
    expect(fingerprintOf(code([f("tests/README.md"), f("tests/x.test.ts")]))).toBeNull();
  });

  test("plain text counts as docs only under docs/", () => {
    expect(fingerprintOf(code([f("docs/notes.txt")]))).toBe("v1:code:docs:small:claude");
    expect(fingerprintOf(code([f("sub/docs/notes.txt")]))).toBe("v1:code:docs:small:claude");
    expect(fingerprintOf(code([f("notes.txt")]))).toBeNull();
    expect(fingerprintOf(code([f("README.rst"), f("a/b.markdown")]))).toBe("v1:code:docs:small:claude");
  });

  test("text files that configure builds or ownership are not docs", () => {
    for (const p of ["requirements.txt", "docs/requirements-dev.txt", "constraints.txt", "docs/CMakeLists.txt", "LICENSE", "LICENSE.md", "CODEOWNERS", "docs/CODEOWNERS", ".github/README.md", ".github/ISSUE_TEMPLATE/bug.md"]) {
      expect(fingerprintOf(code([f(p)]))).toBeNull();
    }
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
    for (const p of [
      "CLAUDE.md",
      "CLAUDE.local.md",
      "sub/AGENTS.md",
      "agent.md",
      "GEMINI.md",
      "copilot-notes.md",
      "docs/cursor.md",
      "windsurf.md",
      ".cursorrules",
      ".windsurfrules",
      ".mcp.json",
      ".github/copilot-instructions.md",
      ".github/instructions/x.md",
      ".claude/settings.json",
      ".codex/x.md",
      ".gemini/notes.md",
      ".cursor/rules.md",
      ".agents/notes.md",
      "docs/.claude/notes.md",
    ]) {
      expect(fingerprintOf(code([f(p)]))).toBeNull();
    }
  });

  test("anything but a plain file is never eligible", () => {
    const link = { ...f("docs/link.md"), newMode: "120000" };
    const exec = { ...f("docs/run.md", 1, 0, "M"), newMode: "100755" };
    const wasExec = { ...f("docs/run.md", 1, 0, "M"), oldMode: "100755" };
    const gitlink = { ...f("docs/sub.md"), newMode: "160000" };
    const typeChange = f("docs/a.md", 1, 0, "T");
    for (const file of [link, exec, wasExec, gitlink, typeChange]) expect(fingerprintOf(code([file]))).toBeNull();
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
      "v1:code:tests:small:claude",
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
    expect(parseFingerprint("v1:code:docs:medium:codex")).toEqual({ domain: "code", shape: "docs", size: "medium", agent: "codex" });
    expect(parseFingerprint("v1:general:text:gemini")).toEqual({ domain: "general", agent: "gemini" });
  });
});
