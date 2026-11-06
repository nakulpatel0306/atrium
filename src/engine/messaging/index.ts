import type { Database } from "bun:sqlite";
import type { Approval } from "../approvals";
import { lookup } from "./contacts";
import { actionForApproval } from "./store";
import { rejectMessage, sendMessage } from "./send";

export type Messaging = {
  onDecision(a: Approval, d: "approve" | "reject"): void;
  lookup(actionId: string): ReturnType<typeof lookup>;
  settle(): Promise<void>;
};

// The engine's side of messaging: what runs after Nakul decides on a text, and his Contacts lookups.
export function createMessaging(deps: { db: Database; kick(): void; timeoutMs?: number }): Messaging {
  const { db } = deps;
  const work = new Map<string, Promise<unknown>>();

  // One job per key; a second request for the same key joins the first. A failure is logged, never thrown into
  // the approval path.
  function track<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = work.get(key);
    if (running) return running as Promise<T>;
    const job = fn().finally(() => {
      work.delete(key);
      deps.kick();
    });
    work.set(key, job);
    return job;
  }

  return {
    onDecision(a, d) {
      if (a.alwaysAsk !== "send_message") return;
      const action = actionForApproval(db, a.id);
      if (action?.status !== "draft") return;
      if (d === "reject") return rejectMessage(db, action.id);
      track(`send:${action.id}`, () => sendMessage(db, action.id, { timeoutMs: deps.timeoutMs })).catch((e) =>
        console.error(`Sending ${action.id} failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    },
    lookup: (actionId) => track(`lookup:${actionId}`, () => lookup(db, actionId, { timeoutMs: deps.timeoutMs })),
    async settle() {
      while (work.size > 0) await Promise.allSettled([...work.values()]);
    },
  };
}
