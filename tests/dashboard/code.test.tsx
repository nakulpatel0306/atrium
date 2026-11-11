import { expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiffResult } from "../../src/engine/diff-parse";
import { ChangesList, changesHeader } from "../../src/dashboard/components/ChangesView";
import { PR_START, PrForm, PrLink, prReducer, type PrState, requestPr } from "../../src/dashboard/components/PullRequest";
import { requestSteer, STEER_START, SteerForm, steerReducer, type SteerState } from "../../src/dashboard/components/SteerTask";
import { ids, makeState } from "../tui/fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const running = () => makeState().tasks.find((t) => t.id === ids.running)!;

// No DOM here: a press calls the element's own handler, found in the tree a view function returns.
function find(tree: ReactNode, match: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, any>> {
  let found: ReactElement<Record<string, any>> | null = null;
  const walk = (n: ReactNode) => {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const el = n as ReactElement<Record<string, any>>;
    if (match(el)) found = el;
    else walk(el.props?.children);
  };
  walk(tree);
  if (!found) throw new Error("not found");
  return found;
}
const button = (tree: ReactNode, label: string) => find(tree, (el) => el.type === "button" && text(renderToStaticMarkup(el)) === label);
const submit = (tree: ReactNode) => find(tree, (el) => el.type === "form").props.onSubmit({ preventDefault() {} });

const DIFF: DiffResult = {
  files: [
    {
      path: "src/footer.tsx",
      status: "added",
      additions: 2,
      deletions: 0,
      binary: false,
      truncated: false,
      hunks: [{ header: "@@ -0,0 +1,2 @@", lines: [{ kind: "add", text: "export const Footer = () => null;", newNo: 1 }, { kind: "add", text: "// made-up line", newNo: 2 }] }],
    },
    {
      path: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      binary: false,
      truncated: false,
      hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "del", text: "# Old title", oldNo: 1 }, { kind: "add", text: "# New title", newNo: 1 }] }],
    },
    { path: "logo.png", status: "added", additions: 0, deletions: 0, binary: true, truncated: false, hunks: [] },
  ],
  totals: { files: 3, additions: 3, deletions: 1 },
  truncated: false,
};

test("the Changes view lists the files with their counts and shows each file's lines", () => {
  const html = renderToStaticMarkup(<ChangesList diff={DIFF} live={null} />);
  const t = text(html);
  expect(t).toContain("3 files changed · +3 −1");
  expect(t).toContain("src/footer.tsx new +2 −0");
  expect(t).toContain("README.md changed +1 −1");
  expect(t).toContain("export const Footer = () =&gt; null;");
  expect(t).toContain("# Old title");
  expect(t).toContain("A binary file, so there are no lines to show.");
  expect(t).not.toContain("Updating as");
  expect(t.toLowerCase()).not.toContain("diff");
});

test("while the agent works the view says so; with nothing changed it says that", () => {
  expect(text(renderToStaticMarkup(<ChangesList diff={DIFF} live="Claude" />))).toContain("Updating as Claude works");
  const empty = text(renderToStaticMarkup(<ChangesList diff={{ files: [], totals: { files: 0, additions: 0, deletions: 0 }, truncated: false }} live="Claude" />));
  expect(empty).toContain("0 files changed · +0 −0");
  expect(empty).toContain("No changes yet.");
  expect(changesHeader({ files: 12, additions: 340, deletions: 52 })).toBe("12 files changed · +340 −52");
  expect(changesHeader({ files: 1, additions: 1200, deletions: 0 })).toBe("1 file changed · +1,200 −0");
});

test("a file over 400 lines starts folded; one Atrium couldn't show says why", () => {
  const lines = Array.from({ length: 450 }, (_, i) => ({ kind: "add" as const, text: `row ${i}`, newNo: i + 1 }));
  const big: DiffResult = {
    files: [
      { path: "data.json", status: "added", additions: 450, deletions: 0, binary: false, truncated: false, hunks: [{ header: "@@ -0,0 +1,450 @@", lines }] },
      { path: "video.mov", status: "modified", additions: 0, deletions: 0, binary: false, truncated: true, hunks: [], note: "Too large to show. Open the file in your editor to see what changed." },
    ],
    totals: { files: 2, additions: 450, deletions: 0 },
    truncated: true,
  };
  const t = text(renderToStaticMarkup(<ChangesList diff={big} live={null} />));
  expect(t).not.toContain("row 0");
  expect(t).toContain("Too large to show.");
  expect(t).toContain("Some changes were left out to keep this view under 200 KB.");
});

test("the steer form sends the note, then shows the restart until the task runs again", async () => {
  let state: SteerState = STEER_START;
  const sent: [string, unknown][] = [];
  const view = () =>
    SteerForm({
      state,
      onEdit: (note) => (state = steerReducer(state, { type: "edit", note })),
      onSend: () => {
        state = steerReducer(state, { type: "sending" });
        void requestSteer(running(), state.note, async (path, body) => (sent.push([path, body]), { ok: true, data: { ...running(), status: "queued" } })).then(
          (res) => (state = steerReducer(state, res.ok ? { type: "sent", status: res.data.status } : { type: "failed", error: res.error })),
        );
      },
    });
  expect(renderToStaticMarkup(view())).toContain('placeholder="Steer: tell it what to change…"');
  // An empty note sends nothing.
  submit(view());
  expect(sent).toEqual([]);
  find(view(), (el) => el.type === "input").props.onChange({ target: { value: "Use the brand colour" } });
  submit(view());
  await Bun.sleep(1);
  expect(sent).toEqual([[`/api/tasks/${ids.running}/steer`, { note: "Use the brand colour" }]]);
  expect(text(renderToStaticMarkup(view()))).toBe("Restarting with your note…");
  // Queued, then running again: the form comes back, empty.
  state = steerReducer(state, { type: "status", status: "queued" });
  expect(state.restarting).toBe(true);
  state = steerReducer(state, { type: "status", status: "running" });
  expect(state).toEqual(STEER_START);
});

test("a steer that answered while the old run was still winding down waits for it to leave and come back", () => {
  let s = steerReducer({ ...STEER_START, busy: true }, { type: "sent", status: "running" });
  s = steerReducer(s, { type: "status", status: "running" });
  expect(s.restarting).toBe(true);
  s = steerReducer(s, { type: "status", status: "queued" });
  s = steerReducer(s, { type: "status", status: "running" });
  expect(s.restarting).toBe(false);
  expect(steerReducer({ ...STEER_START, busy: true }, { type: "failed", error: "It finished or stopped before your note arrived, so nothing was restarted." })).toMatchObject({
    busy: false,
    error: "It finished or stopped before your note arrived, so nothing was restarted.",
  });
});

test("Open pull request shows the confirm step, submits the edited title, then shows the link", async () => {
  const info = { eligible: true as const, url: null, branch: "atrium/tsk_run", sha: "abc1234def5678abc1234def5678abc1234def56", base: "main", repo: "fakeuser/app", title: "Add the status bar", body: "Added it.\n\nOpened from Atrium." };
  let state: PrState = PR_START;
  const sent: [string, unknown][] = [];
  const view = () =>
    PrForm({
      info,
      state,
      onAsk: () => (state = prReducer(state, { type: "ask", title: info.title, body: info.body })),
      onCancel: () => (state = prReducer(state, { type: "cancel" })),
      onEdit: (e) => (state = prReducer(state, { type: "edit", ...e })),
      onSubmit: () => {
        state = prReducer(state, { type: "sending" });
        void requestPr("tsk_run", { title: state.title, body: state.body, sha: info.sha }, async (path, body) => (sent.push([path, body]), { ok: true, data: { url: "https://github.com/fakeuser/app/pull/1" } })).then(
          (res) => (state = prReducer(state, res.ok ? { type: "done", url: res.data.url } : { type: "failed", error: res.error })),
        );
      },
    });
  button(view(), "Open pull request").props.onClick();
  const confirm = text(renderToStaticMarkup(view()));
  expect(confirm).toContain("Branch atrium/tsk_run at abc1234 Into main Repo fakeuser/app");
  expect(confirm).toContain("Push and open PR");
  find(view(), (el) => el.type === "input").props.onChange({ target: { value: "Add a status bar" } });
  submit(view());
  await Bun.sleep(1);
  expect(sent).toEqual([["/api/tasks/tsk_run/pr", { title: "Add a status bar", body: "Added it.\n\nOpened from Atrium.", sha: info.sha }]]);
  expect(state.url).toBe("https://github.com/fakeuser/app/pull/1");
  const link = renderToStaticMarkup(<PrLink url={state.url!} />);
  expect(text(link)).toBe("Pull request opened · View on GitHub");
  expect(link).toContain('href="https://github.com/fakeuser/app/pull/1"');
  expect(link).toContain('target="_blank"');
});

test("Cancel backs out of the confirm without sending; an error keeps the form open with it", () => {
  let s = prReducer(PR_START, { type: "ask", title: "t", body: "b" });
  expect(prReducer(s, { type: "cancel" }).asking).toBe(false);
  s = prReducer(prReducer(s, { type: "sending" }), { type: "failed", error: "gh is signed out of GitHub. Run `gh auth login` in a terminal, then try again." });
  expect(s).toMatchObject({ asking: true, busy: false, error: "gh is signed out of GitHub. Run `gh auth login` in a terminal, then try again." });
});

test("large files Atrium couldn't check sit in their own folded group, never dropped", () => {
  const html = renderToStaticMarkup(<ChangesList diff={{ ...DIFF, unchecked: [{ path: "assets/video.mov", note: "Too large to check" }] }} live={null} />);
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
  expect(text(html)).toContain("Large files not checked · 1 assets/video.mov Too large to check");
});
