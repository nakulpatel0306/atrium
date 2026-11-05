import { describe, expect, test } from "bun:test";
import { type ActionFacts, type DocsContent, enablesDoctest, fingerprintOf, forbiddenFor, hasImport, isAgentInstructionFile, isDoctestConfig, isSiteConfig, labelOf, parseFingerprint } from "../../src/engine/autonomy/kinds";
import { PLAIN_DOCS } from "../helpers";
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
const code = (files: ChangedFile[], agent = "claude", branch = "atrium/tsk_1", content: DocsContent = PLAIN_DOCS): ActionFacts => ({
  domain: "code",
  agent,
  branch,
  sha: "0123abc",
  files,
  content,
});
const withContent = (over: Partial<DocsContent>) => code([f("docs/a.md")], "claude", "atrium/tsk_1", { ...PLAIN_DOCS, ...over });

describe("fingerprintOf", () => {
  test("docs-only small diff", () => {
    const fp = fingerprintOf(code([f("README.md", 10, 2, "M"), f("docs/a.md", 30, 0)]));
    expect(fp).toBe("v1:code:docs:small:claude");
    expect(labelOf(fp!)).toBe("docs changes (Markdown in docs/ or a README/CHANGELOG) up to 50 lines from Claude");
  });

  test("medium docs diff", () => {
    const fp = fingerprintOf(code([f("docs/guide.md", 120, 40, "M")], "codex"));
    expect(fp).toBe("v1:code:docs:medium:codex");
    expect(labelOf(fp!)).toBe("docs changes (Markdown in docs/ or a README/CHANGELOG) of 51–200 lines from Codex");
  });

  test("tests are code: never eligible", () => {
    expect(fingerprintOf(code([f("tests/foo.test.ts", 5, 0, "M")]))).toBeNull();
    expect(fingerprintOf(code([f("src/a.spec.tsx")]))).toBeNull();
    expect(fingerprintOf(code([f("tests/README.md"), f("tests/x.test.ts")]))).toBeNull();
  });

  test("only known docs files count as docs", () => {
    for (const ok of ["docs/guide.md", "docs/deep/a.rst", "README.md", "readme.markdown", "CHANGELOG.md", "CONTRIBUTING.md", "HISTORY.rst", "pkg/README.md"]) {
      expect(fingerprintOf(code([f(ok)]))).toBe("v1:code:docs:small:claude");
    }
    for (const no of ["notes.md", "foo.mdx", "docs/guide.mdx", ".changeset/x.md", "docs/x.txt", "notes.txt", "sub/docs/a.md", "docs/.hidden/a.md", "pkg/.vitepress/README.md", "docs/README"]) {
      expect(fingerprintOf(code([f(no)]))).toBeNull();
    }
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
      ".windsurf/rules.md",
      ".clinerules",
      "docs/.clinerules/a.md",
      ".roo/a.md",
      ".continue/a.md",
      ".kiro/a.md",
      ".junie/guidelines.md",
      ".aider.conf.yml",
      "docs/.aider.md",
      "CONVENTIONS.md",
      "docs/CONVENTIONS.md",
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

describe("docs that execute", () => {
  test("a repo with a docs site generator or Rust build never gets a docs kind", () => {
    expect(fingerprintOf(withContent({ siteConfig: true }))).toBeNull();
    for (const p of [
      "docusaurus.config.js", "web/docusaurus.config.ts", "docs/.vitepress/config.mts", "astro.config.mjs", "mkdocs.yml", "Cargo.toml",
      "nuxt.config.ts", "gatsby-config.js", "docs/conf.py", "book.toml", "_config.yml", "site/_config.yml", "hugo.toml", "hugo.yaml",
      "hugo.json", "config.toml",
    ]) {
      expect(isSiteConfig(p)).toBe(true);
    }
    for (const p of ["docs/a.md", "README.md", "package.json", "docs/mkdocs.md", "vitepress.md", "app/config.toml", "conf.pyc"]) {
      expect(isSiteConfig(p)).toBe(false);
    }
  });

  test("added lines that a docs tool would run never get a docs kind", () => {
    for (const line of [
      "import Chart from './chart'", "  export const x = 1", "<script>alert(1)</script>", "<SCRIPT src=x>", "Hello {{ secret }}",
      "{% include 'x.html' %}", ">>> import os", "   >>> 1 + 1", ".. raw:: html", ".. include:: ../secrets.txt", "  .. doctest::",
      ".. literalinclude:: x.py", ".. code-block:: python",
    ]) {
      expect(fingerprintOf(withContent({ added: ["fine", line] }))).toBeNull();
    }
    expect(fingerprintOf(withContent({ added: ["Important: exports are listed below.", "Use `{ a }` braces.", "> quoted", ".. note::"] }))).toBe(
      "v1:code:docs:small:claude",
    );
  });

  test("a repo whose agent instructions import anything never gets a docs kind", () => {
    expect(fingerprintOf(withContent({ instructionsUnsafe: true }))).toBeNull();
    for (const text of ["See @docs/rules.md", "(@./x.md)", "@~/notes.md", "line\n@/etc/hosts"]) expect(hasImport(text)).toBe(true);
    for (const text of ["Email me@example.com", "uses: actions/checkout@v4", '"@scope/pkg"', "no imports here"]) expect(hasImport(text)).toBe(false);
  });

  test("agent instruction files are found by name and folder", () => {
    for (const p of ["CLAUDE.md", "CLAUDE.local.md", "pkg/AGENTS.md", "GEMINI.md", ".cursorrules", ".clinerules", ".github/copilot-instructions.md", ".github/instructions/a.md", ".claude/commands/x.md", "CONVENTIONS.md"]) {
      expect(isAgentInstructionFile(p)).toBe(true);
    }
    for (const p of ["README.md", ".github/CODEOWNERS", ".github/workflows/ci.yml", "docs/a.md"]) expect(isAgentInstructionFile(p)).toBe(false);
  });

  test("doctest settings make Markdown executable", () => {
    for (const p of ["pyproject.toml", "setup.cfg", "pytest.ini", "tox.ini", "sub/pytest.ini"]) expect(isDoctestConfig(p)).toBe(true);
    expect(isDoctestConfig("package.json")).toBe(false);
    expect(enablesDoctest('[tool.pytest.ini_options]\naddopts = "--doctest-glob=*.md"')).toBe(true);
    expect(enablesDoctest("[pytest]\ndoctest_optionflags = ELLIPSIS")).toBe(true);
    expect(enablesDoctest("[tool.ruff]\nline-length = 100")).toBe(false);
  });

  test("more than 20 KB of changed text never gets a docs kind", () => {
    expect(fingerprintOf(withContent({ bytes: 20 * 1024 }))).toBe("v1:code:docs:small:claude");
    expect(fingerprintOf(withContent({ bytes: 20 * 1024 + 1 }))).toBeNull();
    expect(fingerprintOf(withContent({ bytes: 3_000_000 }))).toBeNull();
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

  test("labels say exactly what a rule covers", () => {
    expect(labelOf("v1:code:docs:small:claude")).toBe("docs changes (Markdown in docs/ or a README/CHANGELOG) up to 50 lines from Claude");
    expect(labelOf("v1:code:docs:medium:gemini")).toBe("docs changes (Markdown in docs/ or a README/CHANGELOG) of 51–200 lines from Gemini");
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
