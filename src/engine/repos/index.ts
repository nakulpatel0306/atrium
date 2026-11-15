import type { Database } from "bun:sqlite";
import { type Approval, getApproval, UNDO_MS } from "../approvals";
import { getSetting, setSetting } from "../settings";
import { listSpaces, type Space } from "../spaces";
import { atriumDiskUsage } from "../storage";
import { askToRemove, checkRemovable, dirBytes, pendingRemovalId, removeClone, scanIdleClones } from "./cleanup";
import { createCloner } from "./clones";
import { createProject } from "./create";
import { actionForApproval, getRepoAction, listClones, markDeclined, presentCloneForPath, setActionStatus, touchClone } from "./store";

const DAY_MS = 86_400_000;
const SIZE_CACHE_MS = 10 * 60_000;

export type StorageView = {
  atrium: ReturnType<typeof atriumDiskUsage>;
  repos: {
    // Null for a copy Atrium kept after its space was deleted (it had work that isn't on GitHub).
    spaceId: string | null;
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
  // Yeses still held when the engine last stopped; boot calls it once recovery has run (boot.ts).
  resumeHeld(now?: number): void;
};

// The engine's side of repos: what runs after the user decides, on-demand clones, and the daily idle check.
// `holdMs` is how long a yes waits before its work starts, so it can be taken back (UNDO_MS unless a test says less).
export function createRepos(deps: { db: Database; kick(): void; ghTimeoutMs?: number; holdMs?: number }): Repos {
  const { db, kick } = deps;
  const holdMs = deps.holdMs ?? UNDO_MS;
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

  // Starts an approved action once its hold is over, unless the yes was taken back meanwhile (its action then points
  // to a fresh, pending approval).
  function start(actionId: string, approvalId: string) {
    const action = getRepoAction(db, actionId);
    const yes = getApproval(db, approvalId);
    if (!action || action.status !== "draft" || action.approvalId !== approvalId || yes?.status !== "approved" || yes.undoneAt !== null) return;
    if (action.kind === "create") track(action.id, () => createProject(db, action.id, { kick, ghTimeoutMs: deps.ghTimeoutMs }));
    else track(action.id, () => removeClone(db, action.id));
  }

  function hold(actionId: string, approvalId: string, approvedAt: number) {
    const left = approvedAt + holdMs - Date.now();
    if (left <= 0) return start(actionId, approvalId);
    setTimeout(() => start(actionId, approvalId), left).unref?.();
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
      hold(action.id, a.id, a.resolvedAt ?? Date.now());
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
    resumeHeld(now = Date.now()) {
      const held = db
        .query("SELECT r.id AS action, a.id AS approval, a.resolved_at AS at FROM repo_actions r JOIN approvals a ON a.id = r.approval_id WHERE r.status = 'draft' AND a.status = 'approved' AND a.undone_at IS NULL")
        .all() as { action: string; approval: string; at: number | null }[];
      for (const h of held) {
        // A hold that ran out while the engine was down starts over, so the yes gets its full minute to be taken back.
        const at = (h.at ?? 0) + holdMs > now ? (h.at ?? now) : now;
        if (at !== h.at) db.query("UPDATE approvals SET resolved_at = ? WHERE id = ?").run(at, h.approval);
        hold(h.action, h.approval, at);
      }
    },
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
      for (const clone of listClones(db)) {
        if (clone.status !== "present" || clone.spaceId !== null || repos.some((r) => r.path === clone.path)) continue;
        const check = await checkRemovable(db, clone.id);
        repos.push({
          spaceId: null,
          spaceName: clone.github,
          path: clone.path,
          github: clone.github,
          createdBy: "atrium",
          cloneId: clone.id,
          bytes: await sizeOf(clone.path),
          lastUsedAt: clone.lastUsedAt,
          removable: check.ok ? { ok: true } : { ok: false, reasons: check.reasons },
          pendingApprovalId: pendingRemovalId(db, clone.id),
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
