import type { Database } from "bun:sqlite";
import type { Approval } from "../approvals";
import { type ChatMatch, findChats } from "./chats";
import { autoLookup, lookup } from "./contacts";
import { actionForApproval, BadMessage, type GroupChat, type MessageAction, setGroupChat } from "./store";
import { rejectMessage, sendMessage, sendSeparately } from "./send";

export const PICK_AGAIN_COPY = "That chat isn't on the list Atrium found. Press Find group chat again.";

export type Messaging = {
  onDecision(a: Approval, d: "approve" | "reject"): void;
  lookup(actionId: string): ReturnType<typeof lookup>;
  findChat(actionId: string): Promise<ChatMatch>;
  pickChat(actionId: string, chatId: string): MessageAction;
  separately(actionId: string, text: string): MessageAction[];
  settle(): Promise<void>;
};

// The engine's side of messaging: what runs after Nakul decides on a text, and his Contacts and chat lookups.
export function createMessaging(deps: { db: Database; kick(): void; timeoutMs?: number }): Messaging {
  const { db } = deps;
  const work = new Map<string, Promise<unknown>>();
  // The chats Find listed for each group draft, so a pick can only be one of them. Held in memory only: nothing about
  // Nakul's other chats is written down, and an engine restart simply means pressing Find again.
  const listed = new Map<string, GroupChat[]>();

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
      if (action) listed.delete(action.id);
      if (action?.status !== "draft") return;
      if (d === "reject") return rejectMessage(db, action.id);
      track(`send:${action.id}`, () => sendMessage(db, action.id, { timeoutMs: deps.timeoutMs })).catch((e) =>
        console.error(`Sending ${action.id} failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    },
    lookup: (actionId) => track(`lookup:${actionId}`, () => lookup(db, actionId, { timeoutMs: deps.timeoutMs })),
    findChat: (actionId) =>
      track(`chats:${actionId}`, async () => {
        const match = await findChats(db, actionId, { timeoutMs: deps.timeoutMs });
        listed.set(actionId, match.shown);
        return match;
      }),
    pickChat(actionId, chatId) {
      const chat = listed.get(actionId)?.find((c) => c.id === chatId);
      if (!chat) throw new BadMessage(PICK_AGAIN_COPY);
      return setGroupChat(db, actionId, chat);
    },
    separately(actionId, text) {
      const made = sendSeparately(db, actionId, text);
      listed.delete(actionId);
      // Each new card looks its person up the same way a drafted text does: only once a lookup of his has worked.
      for (const m of made) void track(`lookup:${m.id}`, () => autoLookup(db, m.id));
      return made;
    },
    async settle() {
      while (work.size > 0) await Promise.allSettled([...work.values()]);
    },
  };
}
