import { config } from "../config";

export const KEYCHAIN_SERVICE = "Atrium";
export const KEY_ACCOUNTS = {
  alpacaKeyId: "alpaca.keyId",
  alpacaSecret: "alpaca.secret",
  finnhub: "finnhub.token",
  alphavantage: "alphavantage.key",
} as const;

export type Keychain = {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  remove(account: string): Promise<void>;
};

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainError";
  }
}

// Keys are only ever letters and digits, which also means they can't break out of the `security -i` line.
export const isKeyShaped = (s: string): boolean => /^[A-Za-z0-9]{8,128}$/.test(s);

// `security` exits 44 when the item isn't there.
const NOT_FOUND = 44;

// stdout and stderr never go into an error: `security` echoes its input, which can hold the secret.
export function createKeychain(bin = config().securityBin): Keychain {
  const run = async (args: string[], stdin?: string) => {
    const proc = Bun.spawn([bin, ...args], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      await proc.stdin.end();
    }
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { out, code };
  };
  const id = (account: string) => ["-s", KEYCHAIN_SERVICE, "-a", account];
  return {
    async get(account) {
      const r = await run(["find-generic-password", ...id(account), "-w"]);
      if (r.code === NOT_FOUND) return null;
      if (r.code !== 0) throw new KeychainError("Couldn't read your Mac's Keychain. Open Keychain Access to check it isn't locked, then try again.");
      return r.out.replace(/\n$/, "") || null;
    },
    async set(account, secret) {
      if (!isKeyShaped(secret)) throw new KeychainError("That doesn't look like a key: keys are letters and numbers only.");
      // Interactive mode reads the command from stdin, so the secret never appears in argv (visible to `ps`).
      const line = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -l "Atrium market data" -w ${secret}\n`;
      const r = await run(["-i"], line);
      if (r.code !== 0) throw new KeychainError("Couldn't save to your Mac's Keychain. Open Keychain Access to check it isn't locked, then try again.");
    },
    async remove(account) {
      const r = await run(["delete-generic-password", ...id(account)]);
      if (r.code !== 0 && r.code !== NOT_FOUND) {
        throw new KeychainError("Couldn't remove the key from your Mac's Keychain. Open Keychain Access to check it isn't locked, then try again.");
      }
    },
  };
}
