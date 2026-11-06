import type { Database } from "bun:sqlite";
import { logActivity } from "../events";
import { stripHidden } from "../repos/rules";
import { getSetting, setSetting } from "../settings";
import { runOsa } from "./osascript";
import { MessagingProblem, problemFor } from "./problems";
import { normalizeHandle } from "./rules";
import { LOOKUP_SCRIPT } from "./scripts";
import { type Candidate, getMessageAction, setCandidates } from "./store";

const RS = String.fromCharCode(30);
const US = String.fromCharCode(31);

export const noMatchCopy = (name: string) => `No one called "${name}" in your Contacts. Type their phone number or email.`;
export const severalCopy = (name: string) => `More than one match for "${name}". Pick who this goes to.`;

const plain = (s: string) => stripHidden(s.replace(/[\u0000-\u001f\u007f]/g, "")).trim();

// Contacts stores built-in labels as "_$!<Mobile>!$_" and an unlabelled entry as missing value.
function cleanLabel(raw: string): string | null {
  const t = plain(raw);
  if (!t || t === "missing value") return null;
  return /^_\$!<(.+)>!\$_$/.exec(t)?.[1] ?? t;
}

// Records with anything other than five fields are dropped whole, so a separator inside a name can only lose
// that one record.
export function parseContacts(out: string): Candidate[] {
  const seen = new Set<string>();
  const list: Candidate[] = [];
  for (const rec of out.replace(/\n$/, "").split(RS)) {
    const f = rec.split(US);
    if (f.length !== 5) continue;
    const [personId, name, kind, label, value] = f as [string, string, string, string, string];
    if (kind !== "phone" && kind !== "email") continue;
    const handle = normalizeHandle(value);
    if (!handle || seen.has(`${personId}\n${handle}`)) continue;
    seen.add(`${personId}\n${handle}`);
    list.push({ personId: plain(personId), name: plain(name), kind, label: cleanLabel(label), handle });
  }
  return list;
}

// macOS asks for Contacts permission on the first lookup, so automatic lookups wait until one of Nakul's own
// has worked: the dialog then only ever appears while he's at the Mac.
export async function lookup(db: Database, actionId: string, opts: { timeoutMs?: number } = {}): Promise<{ candidates: Candidate[]; picked: string | null }> {
  const action = getMessageAction(db, actionId);
  if (!action) throw new Error(`No message draft with id ${actionId}`);
  const res = await runOsa(LOOKUP_SCRIPT, [action.toName], opts);
  if (res.code !== 0 || res.timedOut) {
    const problem = problemFor(res, "Contacts");
    if (problem.kind === "contacts_denied") setSetting(db, "messaging.contactsReady", "false");
    throw problem;
  }
  setSetting(db, "messaging.contactsReady", "true");
  const candidates = parseContacts(res.out);
  const picked = candidates.length === 1 ? candidates[0]!.handle : null;
  setCandidates(db, actionId, candidates, picked);
  return { candidates, picked };
}

export async function autoLookup(db: Database, actionId: string): Promise<void> {
  const action = getMessageAction(db, actionId);
  if (getSetting(db, "messaging.contactsReady") !== "true" || !action || action.handle) return;
  try {
    await lookup(db, actionId);
  } catch (e) {
    // The draft went while Contacts answered (its task or space was deleted): there's nothing left to fill in.
    if (!getMessageAction(db, actionId)) return;
    const why = e instanceof MessagingProblem ? e.message : `${(e as Error).message}.`;
    try {
      logActivity(db, action.spaceId, "atrium", `Couldn't look up ${action.toName} in Contacts. ${why}`, { taskId: action.taskId });
    } catch {
      // A background lookup must never take the engine down over a log line.
    }
  }
}
