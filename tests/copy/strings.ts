// Every string a person might read, pulled from the source with the TypeScript parser (and a regex for Swift), so
// the copy lint can check them without running the app.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export type Found = { file: string; line: number; text: string; context: "jsx" | "string" | "swift"; call?: string; inButton?: boolean };

export const ROOT = join(import.meta.dir, "..", "..");

const callName = (e: ts.Expression): string => {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return `${callName(e.expression)}.${e.name.text}`;
  return "";
};

// Strings that are code rather than copy: module names, object keys, class names, comparisons, SQL and logs.
function skipped(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isImportTypeNode(p.parent ?? p) || ts.isLiteralTypeNode(p)) return true;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) && p.name === node) return true;
  for (let up: ts.Node | undefined = p; up && !ts.isStatement(up); up = up.parent) if (ts.isTypeNode(up)) return true;
  if (ts.isJsxAttribute(p) && p.name.getText() === "className") return true;
  if (ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent) && p.parent.name.getText() === "className") return true;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.InKeyword].includes(p.operatorToken.kind)) return true;
  if (ts.isCaseClause(p)) return true;
  if (ts.isElementAccessExpression(p)) return true;
  // Inside a call whose arguments are SQL, logs or lookups.
  for (let up: ts.Node | undefined = p; up; up = up.parent) {
    if (ts.isCallExpression(up)) {
      const name = callName(up.expression);
      if (/(^|\.)(query|exec|prepare)$/.test(name) || name.startsWith("console.") || /(^|\.)(includes|startsWith|endsWith|has|get|set|delete|getElementById|querySelector|addEventListener|split|join|replace|match|test|padStart|padEnd|indexOf)$/.test(name)) {
        return true;
      }
      break;
    }
    if (ts.isBlock(up) || ts.isSourceFile(up)) break;
  }
  return false;
}

// The call a string is the first message argument of, for the "errors end in a full stop" rule.
function messageCall(node: ts.Node): string | undefined {
  let at: ts.Node = node;
  // A template's head sits inside a TemplateExpression; climb to the whole literal first.
  if (ts.isTemplateHead(at) || ts.isTemplateMiddle(at) || ts.isTemplateTail(at)) at = at.parent.parent ?? at;
  if (ts.isTemplateSpan(at)) at = at.parent;
  const p = at.parent;
  if (!p || !(ts.isCallExpression(p) || ts.isNewExpression(p))) return undefined;
  const name = callName(p.expression);
  const args = p.arguments ?? ts.factory.createNodeArray();
  const index = args.indexOf(at as ts.Expression);
  const which: Record<string, number> = { HttpError: 1, FileRefused: 1, block: 1, BadDraft: 0, GhProblem: 1, setError: 0 };
  const short = name.split(".").at(-1)!;
  return short in which && which[short] === index ? short : undefined;
}

// True when the string is the last piece of its literal (a plain string, or a template's tail), so end-of-text rules apply.
function isEnd(node: ts.Node): boolean {
  return !(ts.isTemplateHead(node) || ts.isTemplateMiddle(node));
}

function inButton(node: ts.Node): boolean {
  for (let up = node.parent; up; up = up.parent) {
    if (ts.isJsxElement(up)) return up.openingElement.tagName.getText() === "button";
  }
  return false;
}

export function userStrings(files: string[]): (Found & { end: boolean })[] {
  const out: (Found & { end: boolean })[] = [];
  for (const abs of files) {
    const source = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, abs.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const file = relative(ROOT, abs);
    const add = (node: ts.Node, text: string, context: Found["context"]) => {
      if (!text.trim()) return;
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      out.push({ file, line, text, context, call: messageCall(node), inButton: context === "jsx" ? inButton(node) : undefined, end: isEnd(node) });
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) add(node, node.text.replace(/\s+/g, " ").trim(), "jsx");
      else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !skipped(node)) add(node, node.text, "string");
      else if ((ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && !skipped(node.parent.parent ?? node)) add(node, node.text, "string");
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

export function swiftStrings(files: string[]): (Found & { end: boolean })[] {
  const out: (Found & { end: boolean })[] = [];
  for (const abs of files) {
    const file = relative(ROOT, abs);
    readFileSync(abs, "utf8")
      .split("\n")
      .forEach((raw, i) => {
        const code = raw.replace(/\/\/.*$/, "");
        for (const m of code.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
          // Interpolations are code; their text is checked around them.
          const text = m[1]!.replace(/\\\([^)]*\)/g, "x");
          if (text.trim()) out.push({ file, line: i + 1, text, context: "swift", end: true });
        }
      });
  }
  return out;
}

export function sourceFiles(dirs: string[], ext: RegExp): string[] {
  const glob = new Bun.Glob("**/*");
  return dirs.flatMap((d) => [...glob.scanSync({ cwd: join(ROOT, d) })].filter((f) => ext.test(f)).map((f) => join(ROOT, d, f))).sort();
}
