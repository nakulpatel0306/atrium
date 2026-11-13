import { config } from "./config";

// Older features kept their secrets in the login keychain under this service. Atrium no longer stores any; it only
// finds and removes what they left, when the user asks.
export const KEYCHAIN_SERVICE = "Atrium";

// `security` exits 44 when the item isn't there.
const NOT_FOUND = 44;
// A locked Keychain can sit on an unlock dialog indefinitely; give up rather than hang the request.
const TIMEOUT_MS = 5_000;

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainError";
  }
}

const LOCKED = "Your Mac's Keychain didn't answer. Unlock it in Keychain Access, then try again.";

// Output is never read: it describes the item, and nothing about it belongs in an error.
async function security(args: string[]): Promise<number> {
  const proc = Bun.spawn([config().securityBin, ...args, "-s", KEYCHAIN_SERVICE], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), TIMEOUT_MS)));
  const code = await Promise.race([proc.exited, timedOut]);
  clearTimeout(timer);
  if (code === "timeout") {
    proc.kill();
    throw new KeychainError(LOCKED);
  }
  return code;
}

// Asks for the item's attributes, never its secret, so it doesn't prompt for access to it.
export async function hasKeychainItem(account: string): Promise<boolean> {
  const code = await security(["find-generic-password", "-a", account]);
  if (code === 0) return true;
  if (code === NOT_FOUND) return false;
  throw new KeychainError("Couldn't read your Mac's Keychain. Open Keychain Access to check it isn't locked, then try again.");
}

export async function removeKeychainItem(account: string): Promise<void> {
  const code = await security(["delete-generic-password", "-a", account]);
  if (code !== 0 && code !== NOT_FOUND) {
    throw new KeychainError("Couldn't remove an item from your Mac's Keychain. Open Keychain Access to check it isn't locked, then try again.");
  }
}
