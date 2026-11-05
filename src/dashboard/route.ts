import { useSyncExternalStore } from "react";

export type Route = { name: "home" } | { name: "agents" } | { name: "rules" } | { name: "settings" } | { name: "space"; id: string; task: string | null };

const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  window.addEventListener("popstate", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("popstate", fn);
  };
}

export function navigate(path: string): void {
  if (path === location.pathname + location.search) return;
  history.pushState(null, "", path);
  for (const fn of [...listeners]) fn();
}

// Includes the query so `?task=` links re-render when only the query changes.
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname + location.search);
}

export function parseRoute(path: string): Route {
  const [pathname = "", search = ""] = path.split("?");
  if (pathname === "/agents") return { name: "agents" };
  if (pathname === "/rules") return { name: "rules" };
  if (pathname === "/settings") return { name: "settings" };
  const m = pathname.match(/^\/space\/([^/]+)$/);
  if (!m) return { name: "home" };
  try {
    return { name: "space", id: decodeURIComponent(m[1]!), task: new URLSearchParams(search).get("task") };
  } catch {
    // A hand-typed URL with a stray "%" shouldn't crash the page.
    return { name: "home" };
  }
}
