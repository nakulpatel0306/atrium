import type { Database } from "bun:sqlite";
import type { Keychain } from "../markets/keychain";
import { logActivity } from "../events";
import { appleAccounts, appleSource } from "./apple";
import { createGoogleAuth, type GoogleAuth } from "./google/oauth";
import { googleSource } from "./google/source";
import { inboxSpace } from "./space";
import { createMailActions, type MailActions } from "./send";
import { createMailSync, type MailSync } from "./sync";

export type Mail = { auth: GoogleAuth; sync: MailSync; actions: MailActions };

// The engine's side of mail and calendar: Google sign-in, both sources, the sync that reads them, and the drafts the
// user's own Send sends through them.
export function createMail(deps: { db: Database; keychain?: Keychain; intervalMs?: number; now?: () => number }): Mail {
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
  const google = googleSource(auth);
  const apple = appleSource();
  sync = createMailSync({ db, google, apple, appleAccounts, intervalMs: deps.intervalMs, now: deps.now });
  return { auth, sync, actions: createMailActions({ db, google, apple, sync, now: deps.now }) };
}
