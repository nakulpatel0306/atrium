#!/usr/bin/env bun
// Stands in for /usr/bin/security: a JSON file plays the Keychain.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const store = process.env.FAKE_SECURITY_STORE!;
const argvLog = process.env.FAKE_SECURITY_ARGV;
const args = process.argv.slice(2);
if (argvLog) appendFileSync(argvLog, JSON.stringify(args) + "\n");

const load = (): Record<string, string> => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {});
const save = (s: Record<string, string>) => writeFileSync(store, JSON.stringify(s));
const flag = (list: string[], f: string) => {
  const i = list.indexOf(f);
  return i >= 0 ? list[i + 1] : undefined;
};

if (process.env.FAKE_SECURITY_FAIL) {
  const input = args[0] === "-i" ? await Bun.stdin.text() : args.join(" ");
  process.stderr.write(`security: failed: ${input}`);
  process.exit(1);
}

function run(list: string[]): number {
  const [cmd, ...rest] = list;
  const id = `${flag(rest, "-s")}/${flag(rest, "-a")}`;
  const s = load();
  if (cmd === "add-generic-password") {
    s[id] = flag(rest, "-w") ?? "";
    save(s);
    return 0;
  }
  if (cmd === "find-generic-password") {
    if (!(id in s)) {
      process.stderr.write("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n");
      return 44;
    }
    process.stdout.write(`${s[id]}\n`);
    return 0;
  }
  if (cmd === "delete-generic-password") {
    if (!(id in s)) return 44;
    delete s[id];
    save(s);
    return 0;
  }
  return 1;
}

// `-i` reads one command line from stdin; split on spaces, honouring double quotes.
function split(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const m of line.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!);
  return out;
}

if (args[0] === "-i") {
  const line = (await Bun.stdin.text()).split("\n")[0] ?? "";
  process.exit(run(split(line)));
}
process.exit(run(args));
