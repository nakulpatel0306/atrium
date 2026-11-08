#!/usr/bin/env bun
// Scans every tracked file for things that shouldn't be in a public repo: home-folder paths, real-looking phone
// numbers and emails, and secret-looking tokens. An optional private denylist (one term per line, case-insensitive;
// --denylist <path> or ATRIUM_LEAK_DENYLIST) adds terms that only its owner knows. That file must live outside the repo.
// Usage: bun run leak-check [--denylist <path>]
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Hit = { file: string; line: number; kind: string; text: string };

// Plans and records stay private and are left out of the public copy, so they aren't scanned.
// This script's own test is skipped too: it holds deliberate bad examples.
const SKIPPED = [/^docs\/plans\//, /^tests\/engine\/leak-check\.test\.ts$/];
const BINARY = /\.(png|jpe?g|gif|ico|icns|xlsx|woff2?|pdf|lock)$/i;

// /Users/me/ and the like are obvious placeholders; any other name is somebody's home folder.
const HOME_PATH = /\/Users\/(?!(?:Shared|me|you|user|username|name|example|someone)\/)[A-Za-z0-9._-]+\//;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
const PHONE = /(?<![\d.])(?:\+?1[ .-]?)?\(?(\d{3})\)?[ .-](\d{3})[ .-](\d{4})(?![\d.])/g;
const TOKEN = /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[bpa]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const BEARER = /\b(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][A-Za-z0-9+/_-]{24,}["']/i;

// git@github.com is the ssh login every GitHub remote uses, not a person.
const okEmail = (e: string) => /^git@(?:ssh\.)?github\.com$/i.test(e) || /@(?:[A-Za-z0-9-]+\.)*example\.(?:com|org|net)$/i.test(e) || /@users\.noreply\.github\.com$/i.test(e);

// Lines of a file against the generic patterns plus any denylisted terms.
export function scanText(file: string, text: string, denylist: string[] = []): Hit[] {
  const hits: Hit[] = [];
  const terms = denylist.map((t) => t.toLowerCase());
  text.split("\n").forEach((raw, i) => {
    const add = (kind: string) => hits.push({ file, line: i + 1, kind, text: raw.trim().slice(0, 120) });
    if (HOME_PATH.test(raw)) add("home folder path");
    for (const m of raw.matchAll(EMAIL)) if (!okEmail(m[0])) add("email");
    // 555 is the reserved fiction range, as an area code (+1 555 010 0134) or an exchange (416 555 0134).
    for (const m of raw.matchAll(PHONE)) if (m[1] !== "555" && m[2] !== "555") add("phone number");
    if (TOKEN.test(raw) || BEARER.test(raw)) add("secret-looking token");
    const lower = raw.toLowerCase();
    if (terms.some((t) => lower.includes(t))) add("denylisted term");
  });
  return hits;
}

export function loadDenylist(path: string | undefined): string[] {
  if (!path) return [];
  if (!existsSync(path)) throw new Error(`Denylist not found: ${path}`);
  return readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

export function scanFiles(files: string[], root: string, denylist: string[] = []): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    if (SKIPPED.some((s) => s.test(file)) || BINARY.test(file)) continue;
    const abs = resolve(root, file);
    if (!existsSync(abs)) continue;
    hits.push(...scanText(file, readFileSync(abs, "utf8"), denylist));
  }
  return hits;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--denylist");
  const root = resolve(import.meta.dir, "..");
  const ls = Bun.spawnSync(["git", "ls-files"], { cwd: root });
  if (ls.exitCode !== 0) throw new Error("Run this inside the git repo.");
  const files = ls.stdout.toString().split("\n").filter(Boolean);
  const hits = scanFiles(files, root, loadDenylist((at >= 0 ? args[at + 1] : undefined) ?? process.env.ATRIUM_LEAK_DENYLIST));
  for (const h of hits) console.log(`${h.file}:${h.line}  ${h.kind}  ${h.text}`);
  console.log(hits.length ? `${hits.length} possible leak${hits.length === 1 ? "" : "s"}.` : "No leaks found.");
  process.exit(hits.length ? 1 : 0);
}
