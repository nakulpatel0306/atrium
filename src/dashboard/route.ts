import { useSyncExternalStore } from "react";

export type Route = { name: "home" } | { name: "needs" } | { name: "activity" } | { name: "agents" } | { name: "rules" } | { name: "settings" } | { name: "start" } | { name: "space"; id: string; task: string | null; tab: SpaceTab; symbol: string | null; money: boolean };
export type SpaceTab = "tasks" | "files";

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
  return useSyncExternalStore(subscribe, () => location.pathname + location.search, () => "/");
}

export function parseRoute(path: string): Route {
  const [pathname = "", search = ""] = path.split("?");
  if (pathname === "/needs-you") return { name: "needs" };
  if (pathname === "/activity") return { name: "activity" };
  if (pathname === "/agents") return { name: "agents" };
  if (pathname === "/rules") return { name: "rules" };
  if (pathname === "/settings") return { name: "settings" };
  if (pathname === "/start") return { name: "start" };
  const m = pathname.match(/^\/space\/([^/]+)$/);
  if (!m) return { name: "home" };
  try {
    const q = new URLSearchParams(search);
    // `?tab=money` opens an investing space on its Money tab, from a money reminder or heads-up.
    return { name: "space", id: decodeURIComponent(m[1]!), task: q.get("task"), tab: q.get("tab") === "files" ? "files" : "tasks", symbol: q.get("symbol"), money: q.get("tab") === "money" };
  } catch {
    // A hand-typed URL with a stray "%" shouldn't crash the page.
    return { name: "home" };
  }
}
