import type { State } from "../api";
import { useSpaceFiles } from "../files";
import { FileRow } from "./FilesTab";

type Space = State["spaces"][number];
type Approval = State["approvals"][number];

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// The path-like words of a question: split on spaces, quotes and brackets, with a sentence's closing stop or comma
// taken off, and only words with a "." or "/" in them, so a plain word never names a file.
export function pathTokens(text: string): string[] {
  return text
    .split(/[\s"'`()[\]{}<>]+/)
    .map((t) => t.replace(/^\.\//, "").replace(/[.,;:!?]+$/, ""))
    .filter((t) => /[./]/.test(t));
}

// Whether a question names a file: its whole path, a path ending in it, or its file name when that has an extension.
// A file called "a" or "README" is never named by a word that merely contains it.
export function namesFile(tokens: string[], path: string): boolean {
  return tokens.some((t) => t === path || t.endsWith(`/${path}`) || (base(path).includes(".") && base(t) === base(path)));
}

// The files a sign-off names, opened for reading right where it's decided: "Publish the changelog draft?" shows the
// draft. One that may hold a secret is listed but never opened.
export function SignOffFiles({ approval, space }: { approval: Approval; space: Space }) {
  const files = useSpaceFiles(space.id);
  const tokens = pathTokens(`${approval.title}\n${approval.detail}`);
  const named = (files?.files ?? []).filter((f) => namesFile(tokens, f.path));
  if (!named.length) return null;
  return (
    <section className="signoff-files" aria-label="Files it names">
      <h4>{named.length === 1 ? "The file it names" : "The files it names"}</h4>
      <ul className="made-files">
        {named.map((f) => (
          <FileRow key={`${f.root}:${f.path}`} file={f} space={space} open={named.filter((x) => !x.secret).length === 1} />
        ))}
      </ul>
    </section>
  );
}
