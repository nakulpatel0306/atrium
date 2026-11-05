import { expect, test } from "bun:test";
import type { State } from "../../src/dashboard/api";
import type { StorageView } from "../../src/engine/repos";
import { draftErrors, draftSummary, folderFor, removalSize, storageRow, tildeShown } from "../../src/dashboard/repos";

type Row = StorageView["repos"][number];

test("draftErrors uses the engine's own wording, and is quiet for a good draft", () => {
  expect(draftErrors({ name: "demo-app", description: "A demo" })).toEqual({ name: null, description: null });
  expect(draftErrors({ name: "--x", description: "ok" }).name).toBe(
    'Repo names use letters, numbers, ".", "-" and "_", start with a letter or number, and are at most 100 characters.',
  );
  expect(draftErrors({ name: "x.git", description: "ok" }).name).not.toBeNull();
  expect(draftErrors({ name: "ok", description: "d".repeat(351) }).description).toBe("Keep the description to one line under 350 characters.");
});

test("the folder follows the name, shown from home", () => {
  expect(folderFor("/Users/nakul/dev-workspace/projects/demo", "other")).toBe("/Users/nakul/dev-workspace/projects/other");
  expect(tildeShown("/Users/nakul/dev-workspace/projects/demo")).toBe("~/dev-workspace/projects/demo");
  expect(tildeShown("/private/tmp/x")).toBe("/private/tmp/x");
});

test("draftSummary reads like the Needs you row", () => {
  const draft = { name: "demo", description: "d", visibility: "private", template: "bun-ts" } as const;
  expect(draftSummary(draft)).toBe('Create GitHub repo "demo"? · Private · bun + TypeScript');
  expect(draftSummary({ ...draft, visibility: "public", template: "empty" })).toBe('Create GitHub repo "demo"? · Public · Empty');
});

test("removalSize reads the size from the removal's detail", () => {
  expect(removalSize("~/dev-workspace/projects/demo · 12.4 MB. Everything is committed and on GitHub")).toBe("12.4 MB");
  expect(removalSize("no size here")).toBeNull();
});

test("storageRow says who made a folder and whether it can go", () => {
  const now = Date.now();
  const base: Row = {
    spaceId: "spc_1", spaceName: "demo", path: "/Users/nakul/dev-workspace/projects/demo", github: "fakeuser/demo", createdBy: "atrium",
    cloneId: "cln_1", bytes: 3 * 1024 * 1024, lastUsedAt: now - 2 * 86_400_000, removable: { ok: true }, pendingApprovalId: null,
  };
  expect(storageRow(base, now)).toEqual({
    name: "demo", path: "~/dev-workspace/projects/demo", size: "3.0 MB", owner: "Made by Atrium", lastUsed: "2d ago",
    status: "Can be removed", reasons: [], canAsk: true,
  });
  const refused = storageRow({ ...base, removable: { ok: false, reasons: ["There are uncommitted changes.", "There are stashed changes."] } }, now);
  expect(refused).toMatchObject({ status: "There are uncommitted changes.", reasons: ["There are uncommitted changes.", "There are stashed changes."], canAsk: false });
  expect(storageRow({ ...base, pendingApprovalId: "apr_1" }, now)).toMatchObject({ status: "Waiting for you in Needs you", canAsk: false });
  const mine = storageRow({ ...base, createdBy: "you", cloneId: null, removable: null, lastUsedAt: null }, now);
  expect(mine).toMatchObject({ owner: "Yours, never removed", lastUsed: "—", status: "Kept", canAsk: false });
});

test("State carries the repo drafts the form needs", () => {
  const view: State["repoActions"][number] = {
    id: "rpa_1", approvalId: "apr_1", kind: "create", draft: null, path: null, folderTaken: false, github: null, pickedUp: false, bytes: null,
  };
  expect(view.kind).toBe("create");
});
