import { HIDDEN_TEXT } from "../repos/rules";
import { MAX_NAME, textProblem } from "./rules";

// How a task agent asks for a text: a fenced block tagged exactly atrium-message. The agent only ever gets a
// draft out of it; anything beyond "to" and "text" (an "approved" flag, a "handle") is ignored.
const FENCE = /```atrium-message[ \t]*\r?\n([\s\S]*?)```/g;

export function parseMessageBlock(text: string): { to: string; text: string; body: string } | null {
  const last = [...text.matchAll(FENCE)].at(-1);
  if (!last) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(last[1]!);
  } catch {
    return null;
  }
  const o = obj as { to?: unknown; text?: unknown } | null;
  if (typeof o?.to !== "string" || typeof o.text !== "string") return null;
  const to = o.to.replace(/[\u0000-\u001f\u007f]/g, "").replace(new RegExp(HIDDEN_TEXT.source, "g"), "").trim();
  if (!to || [...to].length > MAX_NAME) return null;
  if (textProblem(o.text)) return null;
  const body = (text.slice(0, last.index) + text.slice(last.index! + last[0].length)).trim();
  return { to, text: o.text.trim(), body };
}
