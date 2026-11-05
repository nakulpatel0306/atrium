import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type TemplateId = "bun-ts" | "empty";

export const TEMPLATE_LABELS: Record<TemplateId, string> = { "bun-ts": "bun + TypeScript", empty: "Empty" };

const GITIGNORE = ["node_modules/", "dist/", ".cache/", "coverage/", ".env*", "*.log", ".DS_Store", ""].join("\n");

// bun's recommended strict config, as `bun init` writes it.
const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      lib: ["ESNext"],
      target: "ESNext",
      module: "Preserve",
      moduleDetection: "force",
      jsx: "react-jsx",
      allowJs: true,
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      noFallthroughCasesInSwitch: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
      noPropertyAccessFromIndexSignature: false,
    },
  },
  null,
  2,
)}\n`;

const claudeMd = (d: { name: string; description: string }, bun: boolean) =>
  [
    `# ${d.name}`,
    "",
    d.description,
    "",
    "## Constraints",
    "",
    ...(bun ? ["- bun is the only runtime and package manager."] : []),
    "- Commits use Nakul's configured git identity (SSH-signed). Commit messages carry no AI attribution: no co-author trailers and no generated-by footers.",
    "",
  ].join("\n");

const readme = (d: { name: string; description: string }, bun: boolean) =>
  `# ${d.name}\n\n${d.description}\n${bun ? "\n## Run\n\nbun install\nbun test\n" : ""}`;

// Written straight to disk with no install step, so creating a project runs nothing fetched from the network.
export function templateFiles(id: TemplateId, d: { name: string; description: string }): Record<string, string> {
  const base = { ".gitignore": GITIGNORE, "README.md": readme(d, id === "bun-ts"), "CLAUDE.md": claudeMd(d, id === "bun-ts") };
  if (id === "empty") return base;
  const pkg = {
    name: d.name.toLowerCase(),
    type: "module",
    private: true,
    scripts: { test: "bun test" },
    devDependencies: { "@types/bun": "^1.4.4", typescript: "^5" },
  };
  return {
    ...base,
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "tsconfig.json": TSCONFIG,
    "src/index.ts": `console.log("Hello from ${d.name}");\n`,
    "src/index.test.ts": `import { expect, test } from "bun:test";\n\ntest("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n`,
  };
}

// Every path is checked before anything is written, folders are never followed through symlinks, and no file is
// overwritten, so a bad map can't reach outside `dir` or clobber what's there.
export function writeTemplate(dir: string, files: Record<string, string>): void {
  const root = realpathSync(dir);
  const parts = Object.keys(files).map((rel) => {
    const segs = rel.split("/");
    if (isAbsolute(rel) || segs.some((s) => s === "" || s === "." || s === "..")) throw new Error(`Bad template path: ${rel}`);
    return { rel, segs };
  });
  for (const { rel, segs } of parts) {
    let at = root;
    for (const seg of segs.slice(0, -1)) {
      at = join(at, seg);
      let st: ReturnType<typeof lstatSync> | null = null;
      try {
        st = lstatSync(at);
      } catch {
        mkdirSync(at);
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Template folder isn't a plain folder: ${rel}`);
    }
    writeFileSync(join(root, rel), files[rel]!, { flag: "wx" });
  }
}
