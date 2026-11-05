const QUERY_SECRET = /\b(token|apikey|key|secret)=([^&\s"']+)/gi;

// Every provider message passes through here before it can reach a log, a response, an approval or the DB.
// Query-string secrets are caught by name too, so a key not loaded yet (a validate call) is still hidden.
export function redact(text: string, secrets: (string | null | undefined)[]): string {
  let out = text.replace(QUERY_SECRET, (_m, name: string) => `${name}=[redacted]`);
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out;
}
