import type { Database } from "bun:sqlite";
import type { Keychain } from "../markets/keychain";
import { logActivity } from "../events";
import { appleAccounts, appleSource } from "./apple";
import { createGoogleAuth, type GoogleAuth } from "./google/oauth";
import { googleSource } from "./google/source";
import { inboxSpace } from "./space";
import { createMailSync, type MailSync } from "./sync";

export type Mail = { auth: GoogleAuth; sync: MailSync };

// The engine's side of mail and calendar: Google sign-in, both sources, and the sync that reads them.
export function createMail(deps: { db: Database; keychain?: Keychain; intervalMs?: number }): Mail {
  const { db } = deps;
  let sync: MailSync;
  const auth = createGoogleAuth({
    db,
    keychain: deps.keychain,
    onConnected(account) {
      const space = inboxSpace(db);
      logActivity(db, space.id, "atrium", `Connected ${account.address} through Google.`);
      void sync.syncNow();
    },
  });
  sync = createMailSync({ db, google: googleSource(auth), apple: appleSource(), appleAccounts, intervalMs: deps.intervalMs });
  return { auth, sync };
}
