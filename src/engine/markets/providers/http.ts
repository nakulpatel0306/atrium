import { ProviderError } from "./types";

// Provider failures become fixed sentences: a fetch error or response body can echo the URL (with its token)
// or the request headers, so nothing from them is ever passed on.
export async function fetchJson(
  url: string,
  opts: { fetch: typeof fetch; name: string; authMessage: string; now: () => number; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<unknown> {
  let res: Response;
  try {
    res = await opts.fetch(url, { headers: opts.headers, signal: opts.signal });
  } catch {
    throw new ProviderError("unavailable", `Couldn't reach ${opts.name}. Check your internet connection; Atrium will try again.`);
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError("auth", opts.authMessage);
  if (res.status === 429) {
    throw new ProviderError("rate_limited", `${opts.name} says too many requests; Atrium will try again in a minute.`, opts.now() + 60_000);
  }
  if (!res.ok) throw new ProviderError("unavailable", `${opts.name} returned an error (HTTP ${res.status}); Atrium will try again.`);
  try {
    return await res.json();
  } catch {
    throw new ProviderError("unavailable", `${opts.name} sent a reply Atrium couldn't read; it will try again.`);
  }
}

// The same fixed sentences for keyless sources that send files rather than JSON (issuer holdings, filings). The body
// is capped, and a server that never finishes is given up on.
export async function fetchText(
  url: string,
  opts: { fetch: typeof fetch; name: string; now: () => number; headers?: Record<string, string>; maxBytes?: number; timeoutMs?: number },
): Promise<string> {
  return new TextDecoder().decode(await fetchBytes(url, opts));
}

export async function fetchBytes(
  url: string,
  opts: { fetch: typeof fetch; name: string; now: () => number; headers?: Record<string, string>; maxBytes?: number; timeoutMs?: number },
): Promise<Uint8Array> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await opts.fetch(url, { headers: opts.headers, signal });
  } catch {
    throw new ProviderError("unavailable", `Couldn't reach ${opts.name}. Check your internet connection; Atrium will try again.`);
  }
  if (res.status === 429) {
    throw new ProviderError("rate_limited", `${opts.name} says too many requests; Atrium will try again later.`, opts.now() + 60_000);
  }
  if (!res.ok) throw new ProviderError("unavailable", `${opts.name} returned an error (HTTP ${res.status}); Atrium will try again.`);
  // Read with a running count, so an endless or oversized body is cut off as it streams, not after it's in memory.
  try {
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("too big");
      }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  } catch {
    throw new ProviderError("unavailable", `${opts.name} sent a reply Atrium couldn't read; it will try again.`);
  }
}

// Reconnect waits after an unexpected close: 5s, 30s, then every 2 minutes.
export const RECONNECT_MS = [5_000, 30_000, 120_000];
