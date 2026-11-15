import { useSyncExternalStore } from "react";

export type Route = { name: "home" } | { name: "needs"; item: string | null; batch: boolean } | { name: "activity" } | { name: "agents" } | { name: "rules" } | { name: "settings" } | { name: "start" } | { name: "space"; id: string; task: string | null; tab: SpaceTab; changes: boolean; at: ChangeSpot | null };
// A place in a task's Changes to open at, from a walkthrough's "where to look first".
export type ChangeSpot = { file: string; line: number | null };
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
  // `?item=` opens the queue at one item, from a row elsewhere; `?batch=1` opens the list of clean results to approve.
  if (pathname === "/needs-you") {
    const q = new URLSearchParams(search);
    return { name: "needs", item: q.get("item"), batch: q.get("batch") === "1" };
  }
  if (pathname === "/activity") return { name: "activity" };
  if (pathname === "/agents") return { name: "agents" };
  if (pathname === "/rules") return { name: "rules" };
  if (pathname === "/settings") return { name: "settings" };
  if (pathname === "/start") return { name: "start" };
  const m = pathname.match(/^\/space\/([^/]+)$/);
  if (!m) return { name: "home" };
  try {
    const q = new URLSearchParams(search);
    // `&view=changes` opens the task on its Changes, from Needs you's "See changes"; `&file=…&line=…` at one hunk.
    return {
      name: "space",
      id: decodeURIComponent(m[1]!),
      task: q.get("task"),
      tab: q.get("tab") === "files" ? "files" : "tasks",
      changes: q.get("view") === "changes",
      at: q.get("file") ? { file: q.get("file")!, line: Number(q.get("line")) > 0 ? Number(q.get("line")) : null } : null,
    };
  } catch {
    // A hand-typed URL with a stray "%" shouldn't crash the page.
    return { name: "home" };
  }
}
