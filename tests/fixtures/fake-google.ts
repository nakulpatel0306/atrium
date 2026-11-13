#!/usr/bin/env bun
// Stands in for Google's sign-in, token, Gmail and Calendar endpoints, bound to 127.0.0.1 only. Tests start it in
// process; a dev engine can run it standalone (`bun tests/fixtures/fake-google.ts data.json`), which prints its URL.
// Its consent screen approves at once, as the account named by `login_hint` or the first account in the data.
import { readFileSync } from "node:fs";

export type FakeMessageInput = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: number;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  text?: string;
  // The text part's charset; its bytes are encoded in it, as Gmail serves them.
  charset?: "ISO-8859-1";
  html?: string;
  labels?: string[];
  attachments?: { name: string; size: number; data: string }[];
};
export type FakeAccount = {
  threads: { id: string; historyId: string; messages: FakeMessageInput[] }[];
  calendars: { id: string; summary: string; backgroundColor?: string; accessRole?: string }[];
  events: Record<string, Record<string, unknown>[]>;
};
export type FakeData = Record<string, FakeAccount>;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

// Gmail's full message shape, the way users.messages.get returns it.
export function gmailMessage(m: FakeMessageInput, format: "full" | "metadata") {
  const headers = [
    { name: "From", value: m.from },
    { name: "To", value: m.to },
    ...(m.cc ? [{ name: "Cc", value: m.cc }] : []),
    { name: "Subject", value: m.subject },
    { name: "Date", value: new Date(m.date).toUTCString() },
    ...(m.messageId ? [{ name: "Message-ID", value: m.messageId }] : []),
    ...(m.inReplyTo ? [{ name: "In-Reply-To", value: m.inReplyTo }] : []),
    ...(m.references ? [{ name: "References", value: m.references }] : []),
  ];
  const parts = [
    ...(m.text !== undefined
      ? [
          m.charset
            ? { mimeType: "text/plain", filename: "", headers: [{ name: "Content-Type", value: `text/plain; charset=${m.charset}` }], body: { data: Buffer.from(m.text, "latin1").toString("base64url"), size: m.text.length } }
            : { mimeType: "text/plain", filename: "", body: { data: b64(m.text), size: m.text.length } },
        ]
      : []),
    ...(m.html !== undefined ? [{ mimeType: "text/html", filename: "", body: { data: b64(m.html), size: m.html.length } }] : []),
    ...(m.attachments ?? []).map((a, i) => ({ mimeType: "application/octet-stream", filename: a.name, body: { attachmentId: `att${i}`, size: a.size } })),
  ];
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labels ?? ["INBOX"],
    snippet: (m.text ?? "").slice(0, 100).replace(/'/g, "&#39;"),
    internalDate: String(m.date),
    payload: format === "full" ? { mimeType: "multipart/mixed", headers, parts } : { mimeType: "multipart/mixed", headers },
  };
}

export type FakeGoogle = {
  url: string;
  stop(): void;
  // Every request's method and path, for checking what Atrium asked for.
  log: string[];
  revoked: Set<string>;
  // Makes every access token handed out so far fail, as if they'd expired.
  expireAccessTokens(): void;
  // Revokes every refresh token for this address, as if the user removed Atrium in their Google account.
  revokeAccount(address: string): void;
  data: FakeData;
};

export function startFakeGoogle(data: FakeData): FakeGoogle {
  const codes = new Map<string, { challenge: string; clientId: string; redirect: string; email: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();
  const revoked = new Set<string>();
  const log: string[] = [];
  let n = 0;
  const err = (status: number, body: unknown) => Response.json(body, { status });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      log.push(`${req.method} ${url.pathname}${url.search}`);
      const p = url.pathname;

      if (p === "/auth") {
        const q = url.searchParams;
        if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return err(400, { error: "invalid_request" });
        const email = q.get("login_hint") ?? Object.keys(data)[0]!;
        const code = `code-${++n}`;
        codes.set(code, { challenge: q.get("code_challenge")!, clientId: q.get("client_id")!, redirect: q.get("redirect_uri")!, email });
        const back = new URL(q.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        return Response.redirect(back.toString(), 302);
      }
      if (p === "/token" && req.method === "POST") {
        const f = new URLSearchParams(await req.text());
        // A client Google doesn't know, as when the ID or secret is wrong.
        if (f.get("client_id")?.startsWith("unknown-")) return err(401, { error: "invalid_client" });
        if (f.get("grant_type") === "authorization_code") {
          const c = codes.get(f.get("code") ?? "");
          codes.delete(f.get("code") ?? "");
          if (!c) return err(400, { error: "invalid_grant" });
          const hash = Buffer.from(new Bun.CryptoHasher("sha256").update(f.get("code_verifier") ?? "").digest()).toString("base64url");
          if (hash !== c.challenge || f.get("redirect_uri") !== c.redirect || f.get("client_id") !== c.clientId) return err(400, { error: "invalid_grant" });
          const at = `at-${++n}`;
          const rt = `rt-${n}-x/y_z.w`;
          access.set(at, c.email);
          refresh.set(rt, c.email);
          return Response.json({ access_token: at, refresh_token: rt, expires_in: 3600, token_type: "Bearer" });
        }
        if (f.get("grant_type") === "refresh_token") {
          const rt = f.get("refresh_token") ?? "";
          const email = refresh.get(rt);
          if (!email || revoked.has(rt)) return err(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
          const at = `at-${++n}`;
          access.set(at, email);
          return Response.json({ access_token: at, expires_in: 3600, token_type: "Bearer" });
        }
        return err(400, { error: "unsupported_grant_type" });
      }
      if (p === "/revoke" && req.method === "POST") {
        revoked.add(new URLSearchParams(await req.text()).get("token") ?? "");
        return new Response("");
      }

      const email = access.get((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      if (!email) return err(401, { error: { code: 401, message: "Invalid Credentials" } });
      const acct = data[email]!;

      if (p === "/gmail/v1/users/me/profile") return Response.json({ emailAddress: email });
      if (p === "/gmail/v1/users/me/threads") return Response.json({ threads: acct.threads.map((t) => ({ id: t.id, historyId: t.historyId })) });
      let m = p.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/);
      if (m) {
        const t = acct.threads.find((x) => x.id === decodeURIComponent(m![1]!));
        if (!t) return err(404, {});
        return Response.json({ id: t.id, historyId: t.historyId, messages: t.messages.map((x) => gmailMessage(x, "metadata")) });
      }
      m = p.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/);
      if (m) {
        const msg = acct.threads.flatMap((t) => t.messages).find((x) => x.id === decodeURIComponent(m![1]!));
        return msg ? Response.json(gmailMessage(msg, "full")) : err(404, {});
      }
      m = p.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/att(\d+)$/);
      if (m) {
        const msg = acct.threads.flatMap((t) => t.messages).find((x) => x.id === decodeURIComponent(m![1]!));
        const a = msg?.attachments?.[Number(m[2])];
        return a ? Response.json({ data: b64(a.data), size: a.size }) : err(404, {});
      }
      if (p === "/calendar/v3/users/me/calendarList") return Response.json({ items: acct.calendars.map((c) => ({ accessRole: "owner", ...c })) });
      m = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
      if (m) return Response.json({ items: acct.events[decodeURIComponent(m[1]!)] ?? [] });
      return err(404, { error: "not found" });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    log,
    revoked,
    expireAccessTokens: () => access.clear(),
    revokeAccount: (address) => {
      for (const [rt, email] of refresh) if (email === address) revoked.add(rt);
    },
    data,
  };
}

// The environment that points Atrium's Google endpoints at a fake.
export const fakeGoogleEnv = (url: string) => ({
  ATRIUM_GOOGLE_AUTH_URL: `${url}/auth`,
  ATRIUM_GOOGLE_TOKEN_URL: `${url}/token`,
  ATRIUM_GOOGLE_REVOKE_URL: `${url}/revoke`,
  ATRIUM_GOOGLE_GMAIL_URL: url,
  ATRIUM_GOOGLE_CALENDAR_URL: url,
});

if (import.meta.main) {
  const fake = startFakeGoogle(JSON.parse(readFileSync(process.argv[2]!, "utf8")) as FakeData);
  console.log(fake.url);
}
