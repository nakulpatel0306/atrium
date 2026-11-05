import type { Database } from "bun:sqlite";
import type { Approval } from "../approvals";
import { getSetting, setSetting } from "../settings";
import { listSpaces, type Space } from "../spaces";
import { atriumDiskUsage } from "../storage";
import { askToRemove, checkRemovable, dirBytes, pendingRemovalId, removeClone, scanIdleClones } from "./cleanup";
import { createCloner } from "./clones";
import { createProject } from "./create";
import { actionForApproval, markDeclined, presentCloneForPath, setActionStatus, touchClone } from "./store";

const DAY_MS = 86_400_000;
const SIZE_CACHE_MS = 10 * 60_000;

export type StorageView = {
  atrium: ReturnType<typeof atriumDiskUsage>;
  repos: {
    spaceId: string;
    spaceName: string;
    path: string;
    github: string | null;
    createdBy: "atrium" | "you";
    cloneId: string | null;
    bytes: number;
    lastUsedAt: number | null;
    removable: { ok: true } | { ok: false; reasons: string[] } | null;
    pendingApprovalId: string | null;
  }[];
};

export type Repos = {
  onDecision(a: Approval, d: "approve" | "reject"): void;
  requestClone(space: Space): void;
  cloning(spaceId: string): boolean;
  touch(path: string): void;
  daily(now: number): void;
  askToRemove(cloneId: string): ReturnType<typeof askToRemove>;
  storage(): Promise<StorageView>;
  settle(): Promise<void>;
};

// The engine's side of repos: what runs after Nakul decides, on-demand clones, and the daily idle check.
export function createRepos(deps: { db: Database; kick(): void; ghTimeoutMs?: number }): Repos {
  const { db, kick } = deps;
  const cloner = createCloner(db, kick);
  const work = new Map<string, Promise<unknown>>();
  const sizes = new Map<string, { bytes: number; at: number }>();

  // Fire and forget, one run per key; a failure is logged, never thrown into the approval path.
  function track(key: string, fn: () => Promise<unknown>) {
    if (work.has(key)) return;
    const job = fn()
      .catch((e) => console.error(`Repo work ${key} failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => work.delete(key));
    work.set(key, job);
  }

  async function sizeOf(path: string): Promise<number> {
    const hit = sizes.get(path);
    if (hit && Date.now() - hit.at < SIZE_CACHE_MS) return hit.bytes;
    const n = await dirBytes(path);
    sizes.set(path, { bytes: n, at: Date.now() });
    return n;
  }

  return {
    onDecision(a, d) {
      const action = actionForApproval(db, a.id);
      if (!action || action.status !== "draft") return;
      if (d === "reject") {
        setActionStatus(db, action.id, "rejected");
        if (action.kind === "remove" && action.cloneId) markDeclined(db, action.cloneId, Date.now());
        return;
      }
      if (action.kind === "create") track(action.id, () => createProject(db, action.id, { kick, ghTimeoutMs: deps.ghTimeoutMs }));
      else track(action.id, () => removeClone(db, action.id));
    },
    requestClone: cloner.request,
    cloning: cloner.pending,
    touch: (path) => touchClone(db, path, Date.now()),
    daily(now) {
      if (now - Number(getSetting(db, "repos.lastScan") ?? 0) < DAY_MS) return;
      setSetting(db, "repos.lastScan", String(now));
      track("scan", () => scanIdleClones(db, now));
    },
    askToRemove: (cloneId) => askToRemove(db, cloneId),
    async storage() {
      const repos: StorageView["repos"] = [];
      for (const space of listSpaces(db, { includeArchived: true })) {
        if (!space.repoPath) continue;
        const clone = presentCloneForPath(db, space.repoPath);
        const check = clone ? await checkRemovable(db, clone.id) : null;
        repos.push({
          spaceId: space.id,
          spaceName: space.name,
          path: space.repoPath,
          github: space.github,
          createdBy: clone ? "atrium" : "you",
          cloneId: clone?.id ?? null,
          bytes: await sizeOf(space.repoPath),
          lastUsedAt: clone?.lastUsedAt ?? null,
          removable: check ? (check.ok ? { ok: true } : { ok: false, reasons: check.reasons }) : null,
          pendingApprovalId: clone ? pendingRemovalId(db, clone.id) : null,
        });
      }
      return { atrium: atriumDiskUsage(), repos };
    },
    async settle() {
      while (work.size > 0) {
        await Promise.all([...work.values()]);
        await cloner.settle();
      }
      await cloner.settle();
    },
  };
}
