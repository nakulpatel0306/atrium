import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Toast } from "../../src/dashboard/components/Toast";
import { dismissToast, showToast, UNDO_TOAST_MS, withdrawUndo } from "../../src/dashboard/toast";

const shown = () => [...renderToStaticMarkup(<Toast />).matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);

test("two quick approvals keep two Undos, a plain message doesn't push one out, and a push withdraws its Undo", () => {
  dismissToast();
  const undo = async () => ({ ok: true });
  showToast("Approved: A", undo, "tsk_a");
  showToast("Approved: B", undo, "tsk_b");
  showToast("Deleted a file.");
  expect(shown()).toEqual(["Approved: A", "Approved: B", "Deleted a file."]);
  expect(renderToStaticMarkup(<Toast />).match(/>Undo</g)?.length).toBe(2);
  withdrawUndo("tsk_a");
  expect(shown()).toEqual(["Approved: B", "Deleted a file."]);
  // As long as the engine lets an approval be taken back.
  expect(UNDO_TOAST_MS).toBe(60_000);
  dismissToast();
});

test("a yes to a new repo or a removal gets an Undo for its held minute; other asks don't", async () => {
  const { approvedToast } = await import("../../src/dashboard/components/Decision");
  const { makeState } = await import("../tui/fixtures");
  const base = { ...makeState().approvals[0]!, kind: "question" as const, taskId: null, spaceId: null };
  dismissToast();
  approvedToast({ ...base, id: "apr_rm", title: "Remove the local copy of fakeuser/demo?", alwaysAsk: "remove_clone" });
  expect(shown()).toEqual(["Approved: Remove the local copy of fakeuser/demo? It starts in a minute."]);
  expect(renderToStaticMarkup(<Toast />)).toContain(">Undo<");
  dismissToast();
  approvedToast({ ...base, id: "apr_dep", title: "Deploy?", alwaysAsk: "deploy" });
  expect(renderToStaticMarkup(<Toast />)).not.toContain(">Undo<");
  dismissToast();
});
