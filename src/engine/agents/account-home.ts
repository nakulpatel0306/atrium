import { homedir } from "node:os";

let cached: string | null | undefined;

// The account's home folder as the directory service records it. Bun's homedir() is $HOME, but ssh, git and most
// tools look the home up by user id, so an engine started with another HOME would otherwise deny the wrong folder
// and leave the real ~/.ssh readable to a run.
export function accountHome(): string | null {
  if (cached !== undefined) return cached;
  const user = Bun.spawnSync(["/usr/bin/id", "-un"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  const out = user ? Bun.spawnSync(["/usr/bin/dscl", ".", "-read", `/Users/${user}`, "NFSHomeDirectory"], { stdout: "pipe", stderr: "ignore" }).stdout.toString() : "";
  cached = /NFSHomeDirectory:\s*(\S.*)/.exec(out)?.[1]?.trim() ?? null;
  return cached;
}

// Every home a secret path has to be denied under: $HOME, and the account's own when it differs.
export const homes = (): string[] => [...new Set([homedir(), accountHome()].filter((h): h is string => !!h))];

// The account's home when $HOME isn't it, else null.
export function otherAccountHome(): string | null {
  const account = accountHome();
  return account && account !== homedir() ? account : null;
}
