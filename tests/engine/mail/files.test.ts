import { expect, test } from "bun:test";
import { canOpen, safeFileName } from "../../../src/engine/mail/files";

test("names lose folders, hidden dots, controls and every bidi or invisible format character", () => {
  expect(safeFileName("../../etc/passwd")).toBe("passwd");
  expect(safeFileName(".hidden")).toBe("hidden");
  expect(safeFileName("invoice‮fdp.app")).toBe("invoicefdp.app");
  expect(safeFileName("re​port⁦‎.pdf")).toBe("report.pdf");
  expect(safeFileName("a\u0007b\u0085c.txt")).toBe("a_b_c.txt");
  expect(safeFileName("‮")).toBe("attachment");
});

test("only types Atrium opens with a named app get Open; apps, scripts and archives are Finder only", () => {
  for (const ok of ["lease.pdf", "photo.JPG", "notes.txt", "invite.ics", "deck.pptx"]) expect([ok, canOpen(ok)]).toEqual([ok, true]);
  for (const no of ["setup.app", "run.command", "a.sh", "bundle.zip", "x.dmg", "page.html", "invoice‮fdp.app", "noext"]) expect([no, canOpen(no)]).toEqual([no, false]);
});
