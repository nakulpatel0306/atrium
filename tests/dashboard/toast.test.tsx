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
