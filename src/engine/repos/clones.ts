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

// Local copies of attached GitHub repos, made only when a queued task needs one. One clone per destination folder at
// a time: two spaces on one repo, or two repos sharing a name (alice/utils, bob/utils), never clone into it at once.
export function createCloner(db: Database, kick: () => void): { request(space: Space): void; pending(spaceId: string): boolean; settle(): Promise<void> } {
  const inflight = new Map<string, { job: Promise<void>; spaces: Set<string> }>();

  function blockQueued(space: Space, reason: string) {
    for (const task of listTasks(db, { spaceId: space.id, status: ["queued"] })) {
      setTaskStatus(db, task.id, "blocked", { blockedReason: reason });
      logActivity(db, space.id, "atrium", `Blocked: ${task.title}. ${reason}`);
    }
  }

  async function run(space: Space, slug: string, name: string, dest: string) {
    const root = config().projectsRoot;
    mkdirSync(root, { recursive: true });
    try {
      // Not recursive: claiming the folder is how this run knows it made it, and so may delete it on failure.
      mkdirSync(dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A folder already there for this repo is used as is and never recorded as Atrium's to remove.
      const origin = existsSync(join(dest, ".git")) ? await git(dest, ["config", "--get", "remote.origin.url"]) : null;
      if (origin?.code === 0 && sameGithubRepo(origin.out, slug)) {
        setSpaceRepo(db, space.id, { repoPath: dest });
        return;
      }
      blockQueued(space, `A folder named "${name}" already exists in ${tildePath(root)} and isn't ${slug}. Rename or move it, then retry the task.`);
      return;
    }
    try {
      await cloneRepo(`https://github.com/${slug}.git`, dest);
    } catch (e) {
      // This run made the folder, so whatever is in it is the clone's partial work.
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
      if (!space.github) return;
      const { owner, name } = validateGithubSlug(space.github);
      const dest = join(config().projectsRoot, name);
      // macOS folders ignore case, so "Utils" and "utils" are one destination.
      const key = dest.toLowerCase();
      const running = inflight.get(key);
      if (running) {
        // Handled when this space asks again after the running clone lands: then the folder exists and is checked.
        running.spaces.add(space.id);
        return;
      }
      const job = run(space, `${owner}/${name}`, name, dest)
        .catch((e) => logActivity(db, space.id, "atrium", `Couldn't get a local copy of ${space.github}: ${(e as Error).message}`))
        .finally(() => {
          inflight.delete(key);
          kick();
        });
      inflight.set(key, { job, spaces: new Set([space.id]) });
    },
    pending: (spaceId) => [...inflight.values()].some((r) => r.spaces.has(spaceId)),
    async settle() {
      while (inflight.size > 0) await Promise.all([...inflight.values()].map((r) => r.job));
    },
  };
}
