import { useState } from "react";
import type { ProjectDraft } from "../../engine/repos/names";
import { TEMPLATE_LABELS, type TemplateId } from "../../engine/repos/rules";
import { post, type State } from "../api";
import { draftErrors, draftSummary, folderFor, tildeShown } from "../repos";

type Approval = State["approvals"][number];
type Action = State["repoActions"][number];

// A new GitHub repo Atrium drafted. Nakul edits the fields and his "Create repo" is the approval; only the name
// changes the folder, which always sits in the projects folder.
export function ProjectDraftRow({ approval, action }: { approval: Approval; action: Action }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<ProjectDraft>(action.draft!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = draftErrors(fields);
  const invalid = problems.name !== null || problems.description !== null;
  const folder = action.path ? tildeShown(folderFor(action.path, fields.name || "…")) : null;
  // The engine only checked the drafted name; any other name is checked when he presses Create repo.
  const taken = action.folderTaken && fields.name === action.draft!.name;
  const lastTry = approval.detail.match(/^Last try failed: .*$/m)?.[0];
  const set = (patch: Partial<ProjectDraft>) => {
    setFields({ ...fields, ...patch });
    setError(null);
  };

  const create = async () => {
    if (invalid) return setOpen(true);
    setBusy(true);
    setError(null);
    const res = await post(`/api/repo-actions/${action.id}/approve`, fields);
    // On success the row leaves with the next state push, and the space appears once the repo is made.
    if (!res.ok) {
      setError(res.error);
      setOpen(true);
      setBusy(false);
    }
  };
  const decline = async () => {
    setBusy(true);
    const res = await post(`/api/approvals/${approval.id}`, { decision: "reject" });
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
    }
  };

  return (
    <div className="entry">
      <div className="item">
        <span className="sd" style={{ background: "var(--accent)" }} />
        <span className="who">Atrium</span>
        <span className="t">
          {draftSummary(fields)}
          {lastTry && <span className="err">{lastTry}</span>}
        </span>
        <div className="acts">
          <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide" : "Edit"}
          </button>
          <button className="btn" disabled={busy} onClick={() => void decline()}>
            Don't create
          </button>
          <button className="btn p" disabled={busy || invalid} onClick={() => void create()}>
            {busy ? "Creating…" : "Create repo"}
          </button>
        </div>
      </div>
      {open && (
        <form
          className="detail repo-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          {lastTry && <p className="err">{lastTry}</p>}
          <label>
            Name
            <input className="mk-input" value={fields.name} spellCheck={false} onChange={(e) => set({ name: e.target.value.trim() })} />
            {problems.name && <span className="err">{problems.name}</span>}
          </label>
          <label>
            Description
            <input className="mk-input" value={fields.description} onChange={(e) => set({ description: e.target.value })} />
            {problems.description && <span className="err">{problems.description}</span>}
          </label>
          <fieldset>
            <legend>Visibility</legend>
            {(["private", "public"] as const).map((v) => (
              <label key={v} className="inline">
                <input type="radio" name={`vis-${action.id}`} checked={fields.visibility === v} onChange={() => set({ visibility: v })} />
                {v === "private" ? "Private" : "Public"}
              </label>
            ))}
          </fieldset>
          <label>
            Template
            <select className="mk-input" value={fields.template} onChange={(e) => set({ template: e.target.value as TemplateId })}>
              {(Object.keys(TEMPLATE_LABELS) as TemplateId[]).map((t) => (
                <option key={t} value={t}>
                  {TEMPLATE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Local folder
            <input className="mk-input" value={folder ?? ""} readOnly tabIndex={-1} />
            {taken && <span className="err">A folder with this name already exists. Pick another name.</span>}
          </label>
          <p className="hint">
            On yes, Atrium creates the repo on your GitHub account with gh, sets up the folder from the template, makes a signed first commit as
            you, pushes it to main, and adds a repo space.
          </p>
          <button type="submit" hidden />
        </form>
      )}
      {error && <div className="row-err err">{error}</div>}
    </div>
  );
}
