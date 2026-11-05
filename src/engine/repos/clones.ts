import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { logActivity } from "../events";
import { git } from "../git";
import { setSpaceRepo, type Space } from "../spaces";
import { listTasks, setTaskStatus } from "../tasks";
import { cloneRepo } from "./gitops";
import { sameGithubRepo, tildePath, validateGithubSlug } from "./names";
import { recordClone } from "./store";

// Local copies of attached GitHub repos, made only when a queued task needs one. One clone per space at a time.
export function createCloner(db: Database, kick: () => void): { request(space: Space): void; pending(spaceId: string): boolean; settle(): Promise<void> } {
  const inflight = new Map<string, Promise<void>>();

  function blockQueued(space: Space, reason: string) {
    for (const task of listTasks(db, { spaceId: space.id, status: ["queued"] })) {
      setTaskStatus(db, task.id, "blocked", { blockedReason: reason });
      logActivity(db, space.id, "atrium", `Blocked: ${task.title}. ${reason}`);
    }
  }

  async function run(space: Space) {
    const { owner, name } = validateGithubSlug(space.github!);
    const slug = `${owner}/${name}`;
    const root = config().projectsRoot;
    const dest = join(root, name);
    if (existsSync(dest)) {
      // A folder Nakul already has for this repo is his: used as is, never recorded as Atrium's to remove.
      const origin = existsSync(join(dest, ".git")) ? await git(dest, ["config", "--get", "remote.origin.url"]) : null;
      if (origin?.code === 0 && sameGithubRepo(origin.out, slug)) {
        setSpaceRepo(db, space.id, { repoPath: dest });
        return;
      }
      blockQueued(space, `A folder named "${name}" already exists in ${tildePath(root)} and isn't ${slug}. Rename or move it, then retry the task.`);
      return;
    }
    mkdirSync(root, { recursive: true });
    try {
      await cloneRepo(`https://github.com/${slug}.git`, dest);
    } catch (e) {
      // The folder didn't exist before, so whatever is there now is the clone's partial work.
      rmSync(dest, { recursive: true, force: true });
      blockQueued(space, e instanceof Error ? e.message : String(e));
      return;
    }
    db.transaction(() => {
      recordClone(db, { spaceId: space.id, path: dest, github: slug, origin: "clone" });
      setSpaceRepo(db, space.id, { repoPath: dest });
      logActivity(db, space.id, "atrium", `Cloned ${slug} into ${tildePath(dest)}`);
    })();
  }

  return {
    request(space) {
      if (inflight.has(space.id) || !space.github) return;
      const job = run(space)
        .catch((e) => logActivity(db, space.id, "atrium", `Couldn't get a local copy of ${space.github}: ${(e as Error).message}`))
        .finally(() => {
          inflight.delete(space.id);
          kick();
        });
      inflight.set(space.id, job);
    },
    pending: (spaceId) => inflight.has(spaceId),
    async settle() {
      while (inflight.size > 0) await Promise.all([...inflight.values()]);
    },
  };
}
