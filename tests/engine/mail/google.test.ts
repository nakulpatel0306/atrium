import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { openDb } from "../../../src/engine/db";
import { appleAccounts, appleSource } from "../../../src/engine/mail/apple";
import { createGoogleAuth, mailKeychain, type GoogleAuth } from "../../../src/engine/mail/google/oauth";
import { googleSource } from "../../../src/engine/mail/google/source";
import { getAccount, listAccounts, listEvents, listThreads, threadMessages } from "../../../src/engine/mail/store";
import { createMailSync } from "../../../src/engine/mail/sync";
import { tempHome } from "../../helpers";
import { approveInBrowser, CLIENT_ID, FAKE_SECURITY, useFakes } from "./fakes";
import { SAM, T0 } from "./helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let fakes: ReturnType<typeof useFakes>;
let auth: GoogleAuth;
const NOW = T0 + 5 * 86_400_000;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  fakes = useFakes();
  auth = createGoogleAuth({ db, keychain: mailKeychain(FAKE_SECURITY) });
});
afterEach(() => {
  fakes.undo();
  db.close();
  home.cleanup();
});

const sync = () => createMailSync({ db, google: googleSource(auth), apple: appleSource(), appleAccounts, now: () => NOW });

async function connect() {
  const flow = await auth.start({ clientId: CLIENT_ID });
  const page = await approveInBrowser(flow.url);
  expect(page.status).toBe(200);
  const r = await flow.done;
  if (!r.ok) throw new Error(r.error);
  return r.account;
}

describe("Google sign-in (PKCE on a loopback redirect)", () => {
  test("the sign-in URL asks for PKCE, a state and a 127.0.0.1 redirect on a random port", async () => {
    const flow = await auth.start({ clientId: CLIENT_ID });
    const u = new URL(flow.url);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")!.length).toBeGreaterThan(40);
    expect(u.searchParams.get("state")!.length).toBeGreaterThan(20);
    expect(u.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    expect(u.searchParams.get("scope")).toContain("gmail.modify");
    expect(u.searchParams.get("access_type")).toBe("offline");
    // Starting again replaces the first flow, whose listener stops.
    const second = await auth.start({ clientId: CLIENT_ID });
    expect((await flow.done).ok).toBe(false);
    expect(second.redirect).not.toBe(flow.redirect);
  });

  test("connecting stores the refresh token only in the Keychain, hex-encoded, and adds the account", async () => {
    const account = await connect();
    expect(account.address).toBe(SAM);
    expect(account.source).toBe("google");
    const keychain = JSON.parse(readFileSync(fakes.keychainFile, "utf8")) as Record<string, string>;
    const stored = keychain[`Atrium/google.refresh.${account.id}`]!;
    expect(stored).toMatch(/^[0-9a-f]+$/);
    const token = Buffer.from(stored, "hex").toString("utf8");
    expect(token).toStartWith("rt-");
    // Nowhere in the database.
    const dump = JSON.stringify([db.query("SELECT * FROM settings").all(), db.query("SELECT * FROM mail_accounts").all()]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain("at-");
  });

  test("a callback with the wrong state is refused, and the real one still works", async () => {
    const flow = await auth.start({ clientId: CLIENT_ID });
    const bad = await approveInBrowser(flow.url, (u) => u.searchParams.set("state", "forged"));
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("forged");
    expect(listAccounts(db)).toEqual([]);
    const good = await approveInBrowser(flow.url);
    expect(good.status).toBe(200);
    expect((await flow.done).ok).toBe(true);
  });

  test("the listener answers only on 127.0.0.1 with its own Host", async () => {
    const flow = await auth.start({ clientId: CLIENT_ID });
    const port = Number(new URL(flow.redirect).port);
    const reply = await new Promise<string>((resolve) => {
      let got = "";
      void Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open: (s) => void s.write(`GET /oauth/callback?state=x&code=y HTTP/1.1\r\nHost: evil.example.com:${port}\r\nConnection: close\r\n\r\n`),
          data: (_s, d) => void (got += d.toString()),
          close: () => resolve(got),
        },
      });
    });
    expect(reply).toStartWith("HTTP/1.1 404");
  });

  test("a client ID that isn't one is refused before anything starts", async () => {
    await expect(auth.start({ clientId: "not a client id" })).rejects.toThrow("Google OAuth client ID");
    expect(auth.pending()).toBe(false);
  });

  test("an expired access token is refreshed, and a revoked one becomes a plain signed-out error", async () => {
    const account = await connect();
    fakes.google.expireAccessTokens();
    await sync().syncNow();
    expect(getAccount(db, account.id)!.status).toBe("ok");
    expect(fakes.google.log.filter((l) => l === "POST /token").length).toBeGreaterThanOrEqual(2);

    fakes.google.revokeAccount(SAM);
    fakes.google.expireAccessTokens();
    await expect(createGoogleAuth({ db, keychain: mailKeychain(FAKE_SECURITY) }).accessToken(account.id)).rejects.toThrow(
      `Google signed Atrium out of ${SAM}. Connect it again in Settings → Accounts.`,
    );
    const fresh = createGoogleAuth({ db, keychain: mailKeychain(FAKE_SECURITY) });
    await createMailSync({ db, google: googleSource(fresh), apple: appleSource(), appleAccounts, now: () => NOW }).syncNow();
    const after = getAccount(db, account.id)!;
    expect(after.status).toBe("signed_out");
    expect(after.lastError).toBe(`Google signed Atrium out of ${SAM}. Connect it again in Settings → Accounts.`);
  });

  test("disconnect revokes with Google and removes the Keychain item", async () => {
    const account = await connect();
    await auth.disconnect(account.id);
    const keychain = JSON.parse(readFileSync(fakes.keychainFile, "utf8")) as Record<string, string>;
    expect(Object.keys(keychain).filter((k) => k.includes("refresh"))).toEqual([]);
    expect(fakes.google.revoked.size).toBe(1);
  });
});

describe("Google ingest", () => {
  test("threads, messages and calendar events come in through the fake; cancelled events don't", async () => {
    await connect();
    const s = sync();
    await s.syncNow();
    const threads = listThreads(db);
    expect(threads.map((t) => t.subject)).toEqual(["This week's deals", "Lease renewal"]);
    const lease = threads.find((t) => t.subject === "Lease renewal")!;
    expect(lease.count).toBe(2);
    expect(lease.needsReply).toBe(false);
    expect(threads[0]!.unread).toBe(1);

    // Bodies arrive on demand, as plain text, with the attachment list.
    const ids = threadMessages(db, lease.id).map((m) => m.id);
    expect(await s.fetchBodies(ids)).toBeNull();
    const msgs = threadMessages(db, lease.id);
    expect(msgs[0]!.body).toContain("lease renews on Dec 1");
    expect(msgs[1]!.attachments).toEqual([{ name: "lease.pdf", size: 15 }]);
    const deals = threadMessages(db, threads[0]!.id)[0]!;
    await s.fetchBodies([deals.id]);
    expect(threadMessages(db, threads[0]!.id)[0]!.body).toBe("Deals!");

    const events = listEvents(db, NOW - 30 * 86_400_000, NOW + 90 * 86_400_000);
    expect(events.map((e) => e.title).sort()).toEqual(["Day off", "Planning with Kit"]);
    const planning = events.find((e) => e.title === "Planning with Kit")!;
    expect(planning.myStatus).toBe("accepted");
    expect(events.find((e) => e.title === "Day off")!.allDay).toBe(true);
  });

  test("an unchanged thread isn't fetched again", async () => {
    await connect();
    const s = sync();
    await s.syncNow();
    const first = fakes.google.log.filter((l) => l.startsWith("GET /gmail/v1/users/me/threads/")).length;
    await s.syncNow();
    expect(fakes.google.log.filter((l) => l.startsWith("GET /gmail/v1/users/me/threads/")).length).toBe(first);
  });

  test("an attachment is saved inside Atrium's data folder", async () => {
    await connect();
    const s = sync();
    await s.syncNow();
    const lease = listThreads(db).find((t) => t.subject === "Lease renewal")!;
    const reply = threadMessages(db, lease.id)[1]!;
    await s.fetchBodies([reply.id]);
    const path = await s.saveAttachment(reply.id, 0);
    expect(path.startsWith(home.home)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("%PDF-1.4 fake");
  });
});

describe("Google and Apple together", () => {
  test("the address both reach syncs once, through Google; Calendar.app's copy of the Google calendar is skipped", async () => {
    await connect();
    const s = sync();
    s.appleOnNow("mail");
    s.appleOnNow("calendar");
    await s.syncNow();
    const accounts = listAccounts(db);
    expect(accounts.map((a) => [a.address, a.source, a.preferred]).sort()).toEqual([
      ["sam.rivera@example.org", "apple", true],
      [SAM, "apple", false],
      [SAM, "google", true],
    ]);
    const subjects = listThreads(db).map((t) => t.subject);
    expect(subjects.filter((x) => x === "Lease renewal")).toHaveLength(1);
    expect(subjects.filter((x) => x === "Trip plan")).toHaveLength(1);
    const events = listEvents(db, NOW - 30 * 86_400_000, NOW + 90 * 86_400_000).map((e) => e.title);
    expect(events.filter((t) => t === "Planning with Kit")).toHaveLength(1);
    expect(events).toContain("Dentist");
  });
});
