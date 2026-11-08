import type { Database } from "bun:sqlite";
import { ACCOUNT_KINDS, OTHER_ACCOUNT } from "./banks";
import { cleanAccount } from "./import";
import { knownAccounts } from "./imports";

export type AccountInput = { name: string; kind: string; institution?: string };

// An account the user adds by hand, for files that don't name theirs. Returns the name rows will carry.
export function addAccount(db: Database, spaceId: string, input: AccountInput): string {
  const name = cleanAccount(input.name);
  if (!name || name === OTHER_ACCOUNT) throw new Error("Give the account a name, like Everyday chequing.");
  if (!(ACCOUNT_KINDS as readonly string[]).includes(input.kind)) throw new Error("Pick chequing, savings or credit card.");
  const institution = (cleanAccount(input.institution) ?? "").slice(0, 40);
  db.query("INSERT INTO money_accounts (space_id, name, kind, institution, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(space_id, name) DO NOTHING").run(
    spaceId,
    name,
    input.kind,
    institution,
    Date.now(),
  );
  return name;
}

// What the import picker offers: accounts already imported or added, the one the file's format suggests, and the catch-all.
export function accountChoices(db: Database, spaceId: string, suggested: string | null): string[] {
  const known = knownAccounts(db, spaceId);
  if (suggested && suggested !== OTHER_ACCOUNT && !known.includes(suggested)) known.push(suggested);
  return [...known, OTHER_ACCOUNT];
}
