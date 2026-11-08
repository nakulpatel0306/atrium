import { stripHidden } from "../repos/rules";
import { MAX_PEOPLE, nameProblem, textProblem } from "./rules";

// How a task agent asks for a text: a fenced block tagged exactly atrium-message. The agent only ever gets a
// draft out of it; anything beyond "to", "group", "people" and "text" (an "approved" flag, a "handle", a chat id) is
// ignored.
const FENCE = /```atrium-message[ \t]*\r?\n([\s\S]*?)```/g;

export type GroupAsk = { name: string | null; people: string[] };
export type MessageBlock = { to: string; group?: undefined; text: string; body: string } | { group: GroupAsk; to?: undefined; text: string; body: string };

const clean = (v: string) => stripHidden(v.replace(/[\u0000-\u001f\u007f]/g, "")).trim();

// A block with "group" or "people" is a group text, and its "to" is ignored. Every name follows the same rule as a
// draft's, so a block can never become a draft the store refuses. Like "to", a block's names lose stray control
// characters; the command bar's are refused with them (`strip` false), as its "to" is.
export function groupAskOf(o: { group?: unknown; people?: unknown }, strip = true): GroupAsk | null | "bad" {
  const cleanName = (v: string) => (strip ? clean(v) : v.trim());
  if (o.group === undefined && o.people === undefined) return null;
  if (o.group !== undefined && typeof o.group !== "string") return "bad";
  if (o.people !== undefined && (!Array.isArray(o.people) || o.people.some((p) => typeof p !== "string"))) return "bad";
  const name = typeof o.group === "string" ? cleanName(o.group) || null : null;
  const people = [...new Set(((o.people as string[] | undefined) ?? []).map(cleanName).filter(Boolean))];
  if (!name && people.length === 0) return "bad";
  if (people.length > MAX_PEOPLE || (name && nameProblem(name)) || people.some((p) => nameProblem(p))) return "bad";
  return { name, people };
}

export function parseMessageBlock(text: string): MessageBlock | null {
  const last = [...text.matchAll(FENCE)].at(-1);
  if (!last) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(last[1]!);
  } catch {
    return null;
  }
  const o = obj as { to?: unknown; text?: unknown; group?: unknown; people?: unknown } | null;
  if (typeof o?.text !== "string" || textProblem(o.text)) return null;
  const body = (text.slice(0, last.index) + text.slice(last.index! + last[0].length)).trim();
  const group = groupAskOf(o);
  if (group === "bad") return null;
  if (group) return { group, text: o.text.trim(), body };
  if (typeof o.to !== "string") return null;
  const to = clean(o.to);
  if (nameProblem(to)) return null;
  return { to, text: o.text.trim(), body };
}
