import type { Database } from "bun:sqlite";
import type { Repos } from "./repos";
import { recoverRemovals } from "./repos/cleanup";
import { recoverRepoActions } from "./repos/create";
import { removeOrphanSamples } from "./sample";

// Repo work after a restart, in the one safe order: first recovery marks what the last engine left running as cut
// off, then the yeses still held resume (with a fresh minute if theirs ran out), so nothing recovery touches has
// started yet. Called once the server has bound, since the port is the lock.
export function bootRepos(db: Database, repos: Repos): void {
  recoverRepoActions(db);
  recoverRemovals(db);
  repos.resumeHeld();
  removeOrphanSamples(db);
}
