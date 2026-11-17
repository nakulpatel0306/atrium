import type { State } from "../api";
import { useSpaceFiles } from "../files";
import { FileRow } from "./FilesTab";

type Space = State["spaces"][number];
type Approval = State["approvals"][number];

// The files a sign-off names, opened for reading right where it's decided: "Publish the changelog draft?" shows the
// draft. A file counts when the question names its path or its file name.
export function SignOffFiles({ approval, space }: { approval: Approval; space: Space }) {
  const files = useSpaceFiles(space.id);
  const text = `${approval.title}\n${approval.detail}`;
  const named = (files?.files ?? []).filter((f) => text.includes(f.path) || text.includes(f.path.slice(f.path.lastIndexOf("/") + 1)));
  if (!named.length) return null;
  return (
    <section className="signoff-files" aria-label="Files it names">
      <h4>{named.length === 1 ? "The file it names" : "The files it names"}</h4>
      <ul className="made-files">
        {named.map((f) => (
          <FileRow key={`${f.root}:${f.path}`} file={f} space={space} open={named.length === 1} />
        ))}
      </ul>
    </section>
  );
}
