// What a permanent delete says it will remove and keep, shared by the dashboard and the terminal app.
import type { SpaceDeletePreview, TaskDeletePreview } from "../engine/delete";
import { bytes, plural } from "../engine/text";

export type { SpaceDeletePreview, TaskDeletePreview };

// The typed name has to match the space's own, ignoring spaces around it; the engine checks it again.
export const nameMatches = (typed: string, name: string) => typed.trim() !== "" && typed.trim() === name.trim();

export function spaceDeleteLines(p: SpaceDeletePreview): { goes: string[]; stays: string[] } {
  const goes: string[] = [];
  if (p.tasks > 0) goes.push(`${plural(p.tasks, "task")}${p.runs > 0 ? `, with ${plural(p.runs, "run")} and their transcripts` : ""}`);
  else goes.push("The space itself (it has no tasks)");
  if (p.folder) {
    const what = p.folder.files === 0 ? "nothing in it yet" : `${p.folder.more ? "over " : ""}${plural(p.folder.files, "file")}, ${bytes(p.folder.bytes)}`;
    goes.push(`Its folder ${p.folder.path} (${what})`);
  }
  if (p.history > 0) goes.push(`Its history: ${plural(p.history, "activity line")}`);
  if (p.texts.drafts > 0) goes.push(`${plural(p.texts.drafts, "unsent draft text")}`);
  if (p.investing > 0) goes.push("Its holdings, watchlists, alerts and other investing data");

  const stays: string[] = [];
  if (p.texts.sent > 0) {
    stays.push(`${p.texts.sent === 1 ? "The text already sent stays" : `The ${p.texts.sent} texts already sent stay`} in Messages on your Mac. Atrium can't unsend a text.`);
  }
  if (p.repo?.atriumClone) {
    stays.push(`The copy Atrium cloned at ${p.repo.path} is removed only if everything in it is on GitHub. Otherwise Atrium keeps it and says why.`);
  } else if (p.repo) {
    stays.push(`Your repo at ${p.repo.path} stays exactly as it is, including any atrium/ branches. Delete those yourself if you don't need them.`);
  }
  if (p.repo) stays.push("Nothing on GitHub changes.");
  return { goes, stays };
}

export function taskDeleteLine(p: TaskDeletePreview): string {
  const parts = [p.runs > 0 ? `its ${plural(p.runs, "run")} and transcripts` : null, "its history", p.files > 0 ? `the ${plural(p.files, "file")} it made` : null].filter(Boolean);
  const followers = p.followers > 0 ? ` and its ${p.followers === 1 ? "review or fix" : `${p.followers} reviews and fixes`}` : "";
  const last = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  const kept = [p.files > 0 ? "Files it only changed stay." : null, p.branch ? `Its branch ${p.branch} stays in your repo.` : null].filter(Boolean).join(" ");
  return `Deletes this task${followers}, along with ${last}.${kept ? ` ${kept}` : ""} This can't be undone.`;
}
