import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { timingSafeEqual } from "node:crypto";
import { config } from "../../config";
import { bus } from "../../events";
import { getSetting, setSetting } from "../../settings";
import { createKeychain, type Keychain } from "../../markets/keychain";
import { getAccount, upsertAccount, type MailAccount } from "../store";
import { MailProblem } from "../types";

// Google sign-in as an installed app: the user's own OAuth client ID, PKCE (S256), a random state checked on the
// way back, and a one-shot listener on 127.0.0.1 at a random port as the redirect. Refresh tokens live only in the
// Keychain; access tokens only in memory.
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];
export const CLIENT_ID_KEY = "mail.google.clientId";
const SECRET_ACCOUNT = "google.client.secret";
const refreshAccount = (accountId: string) => `google.refresh.${accountId}`;
const FLOW_TIMEOUT_MS = 10 * 60_000;
const HTTP_TIMEOUT_MS = 20_000;

export const CLIENT_ID_COPY = "That doesn't look like a Google OAuth client ID. It ends in .apps.googleusercontent.com; Settings → Accounts shows where to find it.";
export const isClientId = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{2,200}\.apps\.googleusercontent\.com$/.test(s.trim());

// Tokens hold "/", "-" and "." which the `security -i` line can't carry safely, so the Keychain gets them as hex.
const toHex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const fromHex = (s: string) => Buffer.from(s, "hex").toString("utf8");
export const mailKeychain = (bin?: string): Keychain =>
  createKeychain(bin, {
    label: "Atrium mail and calendar",
    accepts: (s) => /^[0-9a-f]{2,16384}$/.test(s),
    locked: "Keychain is locked. Unlock it, then sync again from the Inbox.",
  });

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
// Compared as bytes: two strings of the same length can differ in byte length, which timingSafeEqual refuses.
const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.byteLength === y.byteLength && timingSafeEqual(x, y);
};

// Google ends sign-ins after 7 days for an app left in Testing, which is the usual cause; a revoke reads the same.
export const signedOutCopy = (address: string) =>
  `Google signed Atrium out of ${address}. If your Google Cloud app is still in Testing, Google does this every 7 days: press Publish app under Google Auth Platform › Audience, then connect again in Settings → Accounts.`;
const CLIENT_REFUSED = "Google didn't accept the client ID and secret. Check both in Settings → Accounts, then connect again.";
const OFFLINE = "Atrium couldn't reach Google. Check the Mac is online; it tries again on the next sync.";

// The page the browser lands on. Fixed text only: nothing from the request is echoed back.
const page = (ok: boolean) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Atrium</title><body style="font:15px -apple-system,system-ui,sans-serif;margin:3em;max-width:32em"><h1 style="font-size:18px">${
      ok ? "Connected to Atrium" : "Atrium couldn't connect"
    }</h1><p>${ok ? "You can close this tab and go back to Atrium." : "Go back to Atrium and press Connect Google again."}</p></body>`,
    { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "cache-control": "no-store" } },
  );

export type FlowResult = { ok: true; account: MailAccount } | { ok: false; error: string };
export type GoogleAuth = {
  start(input: { clientId: string; clientSecret?: string }): Promise<{ url: string; redirect: string; done: Promise<FlowResult> }>;
  accessToken(accountId: string, force?: boolean): Promise<string>;
  disconnect(accountId: string): Promise<void>;
  pending(): boolean;
};

export function createGoogleAuth(deps: { db: Database; keychain?: Keychain; fetch?: typeof fetch; onConnected?(a: MailAccount): void }): GoogleAuth {
  const { db } = deps;
  const keychain = deps.keychain ?? mailKeychain();
  const http = deps.fetch ?? fetch;
  const tokens = new Map<string, { token: string; expires: number }>();
  let flow: { server: Server<undefined>; finish(r: FlowResult): void } | null = null;

  const clientSecret = async () => {
    const hex = await keychain.get(SECRET_ACCOUNT);
    return hex ? fromHex(hex) : null;
  };

  async function post(url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await http(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch {
      throw new MailProblem("offline", OFFLINE);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }

  async function exchange(code: string, verifier: string, redirect: string, clientId: string): Promise<{ access: string; refresh: string; expires: number }> {
    const secret = await clientSecret();
    const r = await post(config().google.tokenUrl, {
      code,
      client_id: clientId,
      ...(secret ? { client_secret: secret } : {}),
      redirect_uri: redirect,
      grant_type: "authorization_code",
      code_verifier: verifier,
    });
    const { access_token, refresh_token, expires_in } = r.body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if ((r.body as { error?: unknown }).error === "invalid_client") throw new Error(CLIENT_REFUSED);
    if (r.status !== 200 || typeof access_token !== "string") throw new Error("Google didn't accept the sign-in. Check the client ID (and secret, if your client has one), then connect again.");
    if (typeof refresh_token !== "string") {
      throw new Error("Google didn't give Atrium lasting access. Remove Atrium under Third-party access in your Google account, then connect again.");
    }
    return { access: access_token, refresh: refresh_token, expires: Date.now() + (typeof expires_in === "number" ? expires_in : 3600) * 1000 };
  }

  async function profile(access: string): Promise<{ address: string }> {
    let res: Response;
    try {
      res = await http(`${config().google.gmailUrl}/gmail/v1/users/me/profile`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch {
      throw new MailProblem("offline", OFFLINE);
    }
    const body = (await res.json().catch(() => ({}))) as { emailAddress?: unknown };
    if (!res.ok || typeof body.emailAddress !== "string") throw new Error("Google signed in but wouldn't say which account it was. Connect again.");
    return { address: body.emailAddress };
  }

  return {
    pending: () => flow !== null,

    async start(input) {
      const clientId = input.clientId.trim();
      if (!isClientId(clientId)) throw new MailProblem("other", CLIENT_ID_COPY);
      // A second Connect replaces the first, before anything here waits, so two close together can't both stay live.
      if (flow) flow.finish({ ok: false, error: "A newer Connect Google replaced this one." });

      const verifier = random(48);
      const challenge = b64url(new Uint8Array(new Bun.CryptoHasher("sha256").update(verifier).digest()));
      const state = random(24);
      let used = false;
      let finish!: (r: FlowResult) => void;
      const done = new Promise<FlowResult>((resolve) => (finish = resolve));
      let redirect = "";
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        reusePort: false,
        fetch: async (req) => {
          const url = new URL(req.url);
          // Only the browser on this Mac, at exactly the address Google was given.
          if (req.headers.get("host") !== `127.0.0.1:${server.port}` || req.method !== "GET" || url.pathname !== "/oauth/callback") return new Response("Not found.", { status: 404 });
          if (used) return new Response("Already used.", { status: 410 });
          const got = url.searchParams.get("state") ?? "";
          if (!sameText(got, state)) return page(false);
          used = true;
          const code = url.searchParams.get("code");
          try {
            if (!code) throw new Error(url.searchParams.get("error") === "access_denied" ? "You cancelled the Google sign-in. Press Connect Google to try again." : "Google didn't finish the sign-in. Press Connect Google to try again.");
            const t = await exchange(code, verifier, redirect, clientId);
            const who = await profile(t.access);
            const account = upsertAccount(db, { address: who.address, name: "", source: "google", ref: null });
            await keychain.set(refreshAccount(account.id), toHex(t.refresh));
            db.query("UPDATE mail_accounts SET status = 'ok', last_error = NULL WHERE id = ?").run(account.id);
            tokens.set(account.id, { token: t.access, expires: t.expires });
            finish({ ok: true, account: getAccount(db, account.id)! });
            return page(true);
          } catch (e) {
            finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
            return page(false);
          }
        },
      });
      redirect = `http://127.0.0.1:${server.port}/oauth/callback`;
      const timer = setTimeout(() => finish({ ok: false, error: "The Google sign-in timed out. Press Connect Google to try again." }), FLOW_TIMEOUT_MS);
      const current = { server, finish };
      flow = current;
      // Attached before the Keychain step, so a failure there still stops the listener and clears the flow.
      void done.then((r) => {
        // Let the browser get its page before the listener goes.
        clearTimeout(timer);
        setTimeout(() => {
          server.stop(true);
          if (flow === current) flow = null;
          // The dashboard stops showing "finish signing in" even when nothing else changed (a second cancel).
          bus.emit({ type: "changed" });
        }, 50);
        if (r.ok) deps.onConnected?.(r.account);
      });
      try {
        // A secret belongs to its client: a new client ID without one clears the old one rather than reuse it.
        const secret = input.clientSecret?.trim();
        if (secret) await keychain.set(SECRET_ACCOUNT, toHex(secret));
        else if (getSetting(db, CLIENT_ID_KEY) !== clientId) await keychain.remove(SECRET_ACCOUNT);
        setSetting(db, CLIENT_ID_KEY, clientId);
      } catch (e) {
        finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: SCOPES.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        access_type: "offline",
        prompt: "consent",
      });
      return { url: `${config().google.authUrl}?${params}`, redirect, done };
    },

    async accessToken(accountId, force = false) {
      const cached = tokens.get(accountId);
      if (!force && cached && cached.expires - 60_000 > Date.now()) return cached.token;
      const account = getAccount(db, accountId);
      if (!account) throw new MailProblem("other", "That account isn't connected anymore.");
      const hex = await keychain.get(refreshAccount(accountId));
      const clientId = getSetting(db, CLIENT_ID_KEY);
      if (!hex || !clientId) throw new MailProblem("signed_out", signedOutCopy(account.address));
      const secret = await clientSecret();
      const r = await post(config().google.tokenUrl, { grant_type: "refresh_token", refresh_token: fromHex(hex), client_id: clientId, ...(secret ? { client_secret: secret } : {}) });
      const access = (r.body as { access_token?: unknown }).access_token;
      if ((r.body as { error?: unknown }).error === "invalid_client") throw new MailProblem("other", CLIENT_REFUSED);
      if (r.status === 400 || r.status === 401) throw new MailProblem("signed_out", signedOutCopy(account.address));
      if (r.status !== 200 || typeof access !== "string") throw new MailProblem("other", "Google didn't answer the sign-in check. Atrium tries again on the next sync.");
      const expiresIn = (r.body as { expires_in?: unknown }).expires_in;
      tokens.set(accountId, { token: access, expires: Date.now() + (typeof expiresIn === "number" ? expiresIn : 3600) * 1000 });
      return access;
    },

    // Revoking is a courtesy to Google; the Keychain item goes whether or not Google answers.
    async disconnect(accountId) {
      tokens.delete(accountId);
      const hex = await keychain.get(refreshAccount(accountId)).catch(() => null);
      if (hex) await post(config().google.revokeUrl, { token: fromHex(hex) }).catch(() => {});
      await keychain.remove(refreshAccount(accountId));
      // The client secret goes with the last Google account; the client ID stays in Settings for next time.
      const others = db.query("SELECT 1 FROM mail_accounts WHERE source = 'google' AND id != ?").get(accountId);
      if (!others) await keychain.remove(SECRET_ACCOUNT);
    },
  };
}
