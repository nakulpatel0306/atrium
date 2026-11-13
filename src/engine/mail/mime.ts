import type { Outgoing, Person } from "./types";

// The RFC 5322 message Gmail is handed as `raw`. Every header value has its line breaks removed before it's written,
// so nothing in a name or subject can add a header (a Bcc) or start the body early.

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

// Plain ASCII stays as is; anything else becomes UTF-8 encoded words of at most 45 bytes each (75 characters encoded).
export function encodeWord(text: string): string {
  const s = oneLine(text);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > 45) {
      words.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join(" ");
}

export function formatAddress(p: Person): string {
  const name = oneLine(p.name);
  if (!name) return p.address;
  const shown = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : encodeWord(name);
  return `${shown} <${p.address}>`;
}

const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n");

export const newMessageId = (from: string): string => `<atrium.${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex")}@${from.split("@")[1] || "localhost"}>`;

// RFC 2231 for a filename that isn't plain ASCII.
function fileParam(name: string): string {
  const n = oneLine(name).replace(/["\\]/g, "_");
  if (/^[\x20-\x7e]*$/.test(n)) return `filename="${n}"`;
  return `filename*=UTF-8''${encodeURIComponent(n)}`;
}

export function buildMime(m: Outgoing, files: { name: string; data: Uint8Array }[] = [], date = new Date()): string {
  const headers = [
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to.map(formatAddress).join(", ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(formatAddress).join(", ")}`] : []),
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${oneLine(m.messageId)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${oneLine(m.inReplyTo)}`] : []),
    ...(m.references.length ? [`References: ${m.references.map(oneLine).join(" ")}`] : []),
    "MIME-Version: 1.0",
  ];
  const text = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(m.text.replace(/\r?\n/g, "\r\n")).toString("base64"))].join("\r\n");
  if (!files.length) return `${headers.join("\r\n")}\r\n${text}`;
  const boundary = `atrium-${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex")}`;
  const parts = [
    text,
    ...files.map((f) =>
      ["Content-Type: application/octet-stream", `Content-Disposition: attachment; ${fileParam(f.name)}`, "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(f.data).toString("base64"))].join("\r\n"),
    ),
  ];
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--`, ""].join("\r\n");
}
