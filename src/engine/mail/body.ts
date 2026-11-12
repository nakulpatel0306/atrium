import type { Database } from "bun:sqlite";
import type { SourceBody } from "./types";

// Bodies are fetched only when a thread is opened or an agent task needs one, and kept as plain text: HTML never
// reaches the dashboard, so no remote image, script or tracking pixel can load from it.
export const BODY_CAP_BYTES = 2 * 1024 * 1024;
export const BODIES_TOTAL_CAP_BYTES = 200 * 1024 * 1024;
const TRUNCATED = "\n\n[Atrium cut this message short at 2 MB.]";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Readable text from an email's HTML: block tags become line breaks, links keep their address in brackets, and
// everything that isn't text (style, script, head, images) is dropped.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<a\b[^>]*?href\s*=\s*["']?(https?:[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href: string, text: string) => {
      const label = text.replace(/<[^>]*>/g, "").trim();
      return label && label !== href ? `${label} [${href}]` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<blockquote\b[^>]*>/gi, "\n> ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const bodyText = (b: SourceBody): string => (b.text?.trim() ? b.text : b.html ? htmlToText(b.html) : "");

// Cuts to `cap` bytes without splitting a character.
function cut(text: string, cap: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= cap) return { text, truncated: false };
  return { text: bytes.subarray(0, cap - Buffer.byteLength(TRUNCATED)).toString("utf8").replace(/�$/, "") + TRUNCATED, truncated: true };
}

// Stores one body, then evicts the oldest cached bodies until the total is under its cap.
export function cacheBody(db: Database, messageId: string, text: string, now = Date.now(), caps = { each: BODY_CAP_BYTES, total: BODIES_TOTAL_CAP_BYTES }): void {
  const c = cut(text, caps.each);
  const size = Buffer.byteLength(c.text, "utf8");
  db.transaction(() => {
    db.query("INSERT INTO mail_bodies (message_id, text, bytes, truncated, cached_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET text = excluded.text, bytes = excluded.bytes, truncated = excluded.truncated, cached_at = excluded.cached_at").run(
      messageId,
      c.text,
      size,
      c.truncated ? 1 : 0,
      now,
    );
    db.query("UPDATE mail_messages SET body_cached_at = ? WHERE id = ?").run(now, messageId);
    let total = (db.query("SELECT COALESCE(SUM(bytes), 0) AS n FROM mail_bodies").get() as { n: number }).n;
    if (total <= caps.total) return;
    const oldest = db.query("SELECT message_id, bytes FROM mail_bodies WHERE message_id != ? ORDER BY cached_at, rowid").all(messageId) as { message_id: string; bytes: number }[];
    for (const o of oldest) {
      if (total <= caps.total) break;
      db.query("DELETE FROM mail_bodies WHERE message_id = ?").run(o.message_id);
      db.query("UPDATE mail_messages SET body_cached_at = NULL WHERE id = ?").run(o.message_id);
      total -= o.bytes;
    }
  })();
}

export const bodiesBytes = (db: Database): number => (db.query("SELECT COALESCE(SUM(bytes), 0) AS n FROM mail_bodies").get() as { n: number }).n;
