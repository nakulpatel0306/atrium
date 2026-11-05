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

// Reconnect waits after an unexpected close: 5s, 30s, then every 2 minutes.
export const RECONNECT_MS = [5_000, 30_000, 120_000];
