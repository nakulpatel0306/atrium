#!/usr/bin/env bun
// Stands in for /usr/bin/security: a JSON file of "service/account" → secret plays the Keychain.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const store = process.env.FAKE_SECURITY_STORE;
const argvLog = process.env.FAKE_SECURITY_ARGV;
const args = process.argv.slice(2);
if (argvLog) appendFileSync(argvLog, JSON.stringify(args) + "\n");

const load = (): Record<string, string> => (store && existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {});
const flag = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

// Stands in for a Keychain waiting on an unlock dialog.
if (process.env.FAKE_SECURITY_HANG) await Bun.sleep(30_000);
if (process.env.FAKE_SECURITY_FAIL) process.exit(1);

const [cmd] = args;
const id = `${flag("-s")}/${flag("-a")}`;
const items = load();
if (cmd === "find-generic-password") {
  if (!(id in items)) process.exit(44);
  if (args.includes("-w")) process.stdout.write(`${items[id]}\n`);
  process.exit(0);
}
if (cmd === "delete-generic-password") {
  if (!(id in items)) process.exit(44);
  delete items[id];
  writeFileSync(store!, JSON.stringify(items));
  process.exit(0);
}
process.exit(1);
