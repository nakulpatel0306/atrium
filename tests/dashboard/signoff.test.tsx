import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DecisionPanel } from "../../src/dashboard/components/NeedsPage";
import { attentionQueue } from "../../src/dashboard/queue";
import type { State } from "../../src/engine/state";
import { ids, makeState } from "../tui/fixtures";

let root: Root | null = null;
const realFetch = globalThis.fetch;
const now = Date.now();
beforeEach(() => {
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith(`/spaces/${ids.jobHunt}/files`))
      return Response.json({
        folder: "/Users/me/Atrium/job-hunt",
        shown: "~/Atrium/job-hunt",
        truncated: false,
        files: [
          { root: "space", ref: null, path: "notes/changelog-0.9.md", absPath: "/Users/me/Atrium/job-hunt/notes/changelog-0.9.md", size: 120, at: now, kind: "markdown", madeBy: null },
          { root: "space", ref: null, path: "other.md", absPath: "/Users/me/Atrium/job-hunt/other.md", size: 40, at: now, kind: "markdown", madeBy: null },
        ],
      });
    if (url.includes("/file?path=")) return Response.json({ kind: "markdown", text: "# 0.9\n\n- Faster search", truncated: false, size: 120 });
    return Response.json({});
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  globalThis.fetch = realFetch;
});
openDom();
afterAll(() => closeDom());

async function panel(state: State, key: string): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  const item = attentionQueue(state).find((i) => i.key === key)!;
  await act(async () => root!.render(<DecisionPanel item={item} state={state} />));
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  return el;
}

const ask = (over: Partial<State["approvals"][number]>): State["approvals"][number] => ({ ...makeState().approvals[0]!, taskId: null, kind: "question", ...over });

test("a sign-off on a draft shows the file it names, open, and a way to its space", async () => {
  const s = makeState({ approvals: [ask({ id: "apr_pub", spaceId: ids.jobHunt, title: "Publish the 0.9 changelog draft?", detail: "The draft is in notes/changelog-0.9.md." })] });
  const el = await panel(s, "apr_pub");
  const files = el.querySelector(".signoff-files")!;
  expect(files.querySelectorAll(".made-row").length).toBe(1);
  expect(files.textContent).toContain("changelog-0.9.md");
  expect(files.textContent).toContain("Faster search");
  expect([...el.querySelectorAll(".dp-meta a")].map((a) => a.textContent)).toEqual(["Open the space"]);
});

test("a new repo's sign-off says what it creates before the yes", async () => {
  const s = makeState({
    approvals: [ask({ id: "apr_new", spaceId: null, title: "Create a GitHub repo?", detail: "", alwaysAsk: "create_repo" })],
    repoActions: [{ id: "rpa_1", approvalId: "apr_new", kind: "create", draft: { name: "pocket-cli", description: "A tiny CLI", visibility: "private", template: "bun-ts" }, path: "/Users/me/Projects/pocket-cli", folderTaken: false, github: null, pickedUp: false, bytes: null }],
  });
  const el = await panel(s, "apr_new");
  const dl = el.querySelector('dl.signoff[aria-label="What this creates"]')!;
  expect(dl.textContent).toContain("pocket-cli");
  expect(dl.textContent).toContain("Private");
  expect(dl.textContent).toContain("~/Projects/pocket-cli");
});

test("a removal's sign-off says what goes and what GitHub keeps, without a View click", async () => {
  const s = makeState({
    approvals: [ask({ id: "apr_rm", spaceId: null, title: "Remove the local copy of example/demo?", detail: "~/Projects/demo · 3.0 MB. Everything is committed and on GitHub.", alwaysAsk: "remove_clone" })],
    repoActions: [{ id: "rpa_2", approvalId: "apr_rm", kind: "remove", draft: null, path: "/Users/me/Projects/demo", folderTaken: false, github: "example/demo", pickedUp: false, bytes: null }],
  });
  const el = await panel(s, "apr_rm");
  const dl = el.querySelector('dl.signoff[aria-label="What this removes"]')!;
  expect(dl.textContent).toContain("~/Projects/demo · 3.0 MB");
  expect(dl.textContent).toContain("example/demo");
});
