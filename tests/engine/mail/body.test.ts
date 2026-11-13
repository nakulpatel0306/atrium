import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { bodiesBytes, cacheBody, htmlToText } from "../../../src/engine/mail/body";
import { ingestMessages, threadMessages, listThreads, upsertAccount } from "../../../src/engine/mail/store";
import { tempHome } from "../../helpers";
import { msg } from "./helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

function seed(n: number): string[] {
  const a = upsertAccount(db, { address: "sam@example.com", name: "", source: "google", ref: null });
  ingestMessages(db, a, Array.from({ length: n }, (_, i) => msg({ sourceId: `g${i}`, threadKey: `t${i}`, messageId: `<m${i}@x>`, date: 1_000 + i })));
  return listThreads(db).flatMap((t) => threadMessages(db, t.id).map((m) => m.id));
}

test("a body over the per-message cap is cut with a marker", () => {
  const [id] = seed(1);
  cacheBody(db, id!, "é".repeat(2000), 1, { each: 1000, total: 1e9 });
  const row = db.query("SELECT text, bytes, truncated FROM mail_bodies").get() as { text: string; bytes: number; truncated: number };
  expect(row.truncated).toBe(1);
  expect(row.bytes).toBeLessThanOrEqual(1000);
  expect(row.text).toContain("cut this message short");
  expect(row.text).not.toContain("�");
});

test("the total cap evicts the oldest cached bodies first", () => {
  const ids = seed(4);
  ids.forEach((id, i) => cacheBody(db, id, "x".repeat(100), i + 1, { each: 1000, total: 250 }));
  expect(bodiesBytes(db)).toBeLessThanOrEqual(250);
  const kept = (db.query("SELECT message_id FROM mail_bodies ORDER BY cached_at").all() as { message_id: string }[]).map((r) => r.message_id);
  expect(kept).toEqual(ids.slice(2));
  const evicted = db.query("SELECT body_cached_at FROM mail_messages WHERE id = ?").get(ids[0]!) as { body_cached_at: number | null };
  expect(evicted.body_cached_at).toBeNull();
});

test("HTML becomes plain text: no images, scripts or styles, links keep their address", () => {
  const text = htmlToText(
    '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p>Hi&nbsp;Sam,</p><img src="https://tracker.example.com/p.gif"><p>See <a href="https://example.com/lease">the lease</a> &amp; reply.</p></body></html>',
  );
  expect(text).toBe("Hi Sam,\nSee the lease [https://example.com/lease] & reply.");
  expect(text).not.toContain("tracker");
});
