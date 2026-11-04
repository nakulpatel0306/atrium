import { useSyncExternalStore } from "react";

export type Route = { name: "home" } | { name: "space"; id: string };

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

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

export function parseRoute(path: string): Route {
  const m = path.match(/^\/space\/([^/]+)$/);
  return m ? { name: "space", id: decodeURIComponent(m[1]!) } : { name: "home" };
}
