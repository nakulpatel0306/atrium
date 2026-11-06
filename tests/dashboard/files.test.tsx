import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PreviewPane } from "../../src/dashboard/components/PreviewPane";
import { WhatItMadeList } from "../../src/dashboard/components/WhatItMade";
import { fileActions, fileUrl, icsEvents, sizeText } from "../../src/dashboard/files";
import type { OutputFile, TaskOutputs } from "../../src/engine/outputs/views";

const row = (path: string, over: Partial<OutputFile> = {}): OutputFile => ({
  id: `rf_${path}`,
  runId: "run_1",
  root: "space",
  ref: null,
  path,
  absPath: `/Users/n/Atrium/weekly-planning/${path}`,
  change: "created",
  size: 2662,
  insertions: null,
  deletions: null,
  kind: path.endsWith(".md") ? "markdown" : path.endsWith(".ics") ? "calendar" : path.endsWith(".png") ? "image" : "text",
  exists: true,
  at: Date.now() - 60_000,
  ...over,
});

test("fileActions offers only what is safe for each row", () => {
  expect(fileActions({ root: "space", kind: "markdown", path: "list.md", exists: true }, "general")).toEqual(["open", "reveal", "copyPath", "copyText"]);
  expect(fileActions({ root: "space", kind: "calendar", path: "week.ics", exists: true }, "general")).toEqual(["calendar", "reveal", "copyPath"]);
  expect(fileActions({ root: "space", kind: "text", path: "page.html", exists: true }, "general")).toEqual(["reveal", "copyPath", "copyText"]);
  expect(fileActions({ root: "space", kind: "other", path: "run.command", exists: true }, "general")).toEqual(["reveal", "copyPath"]);
  expect(fileActions({ root: "space", kind: "image", path: "chart.png", exists: true }, "general")).toEqual(["open", "reveal", "copyPath"]);
  expect(fileActions({ root: "branch", kind: "markdown", path: "docs/a.md", exists: true }, "repo")).toEqual(["reveal", "copyPath", "copyText"]);
  expect(fileActions({ root: "space", kind: "markdown", path: "gone.md", exists: false }, "general")).toEqual(["copyPath"]);
});

test("fileUrl reads space files from the space and branch files from the task", () => {
  expect(fileUrl({ spaceId: "s1", taskId: "t1", root: "space", path: "a b/c.md" })).toBe("/api/spaces/s1/file?path=a%20b%2Fc.md");
  expect(fileUrl({ spaceId: "s1", taskId: "t1", root: "branch", path: "x.png" }, true)).toBe("/api/tasks/t1/file/raw?path=x.png");
});

test("sizeText is short and exact enough", () => {
  expect(sizeText(null)).toBe("");
  expect(sizeText(512)).toBe("512 B");
  expect(sizeText(2662)).toBe("2.6 KB");
  expect(sizeText(52_000)).toBe("51 KB");
  expect(sizeText(5_242_880)).toBe("5.0 MB");
});

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "SUMMARY:Gym: legs and",
  "  core",
  "DTSTART;TZID=America/Toronto:20261109T070000",
  "DTEND;TZID=America/Toronto:20261109T080000",
  "LOCATION:Summit Fitness\\, Queen St",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Groceries",
  "DTSTART:20261110T180000",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Errands",
  "DTSTART;VALUE=DATE:20261111",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("icsEvents reads events, unfolding long lines", () => {
  expect(icsEvents(ICS)).toEqual([
    { summary: "Gym: legs and core", start: "Mon, Nov 9 · 7:00 AM", end: "Mon, Nov 9 · 8:00 AM", location: "Summit Fitness, Queen St" },
    { summary: "Groceries", start: "Tue, Nov 10 · 6:00 PM", end: null, location: null },
    { summary: "Errands", start: "Wed, Nov 11", end: null, location: null },
  ]);
  expect(icsEvents("BEGIN:VCALENDAR\nEND:VCALENDAR")).toEqual([]);
});

test("WhatItMadeList shows the rendered summary and every file with its actions", () => {
  const outputs: TaskOutputs = {
    summary: { text: "**Done.** Made your week.", status: "approved", decidedBy: "you", at: Date.now() - 3_600_000 },
    files: [row("grocery-list.md"), row("gym-schedule.md"), row("errands.md"), row("week-of-nov-9.ics"), row("old.md", { exists: false })],
  };
  const html = renderToStaticMarkup(<WhatItMadeList outputs={outputs} spaceId="s1" taskId="t1" spaceKind="general" />);
  expect(html).not.toContain("**");
  expect(html).toContain("<strong>Done.</strong>");
  expect(html).toContain("Approved by you · 1h ago");
  expect(html).toContain("What it made");
  expect(html.match(/class="made-row/g)?.length).toBe(5);
  expect(html.match(/Add to Calendar/g)?.length).toBe(1);
  expect(html).toContain("No longer in the folder");
  const missing = html.slice(html.indexOf("old.md"));
  expect(missing).not.toContain(">Open<");
  expect(html).toContain("2.6 KB");
});

test("WhatItMadeList says when a run made nothing", () => {
  const html = renderToStaticMarkup(
    <WhatItMadeList outputs={{ summary: { text: "Answered.", status: "pending", decidedBy: "you", at: Date.now() }, files: [] }} spaceId="s1" taskId="t1" spaceKind="general" />,
  );
  expect(html).toContain("Waiting for you");
  expect(html).toContain("No files. This run answered in text only.");
});

test("PreviewPane shows the cut note and images from the raw route", () => {
  const base = { path: "big.txt", absPath: "/x/big.txt", size: 2_000_000, kind: "text" as const, note: null };
  expect(renderToStaticMarkup(<PreviewPane preview={{ ...base, text: "abc", truncated: true }} rawUrl="" />)).toContain(
    "Showing the first 256 KB. Open the file to see all of it.",
  );
  const img = renderToStaticMarkup(
    <PreviewPane preview={{ ...base, path: "chart.png", kind: "image", text: null, truncated: false }} rawUrl="/api/spaces/s1/file/raw?path=chart.png" />,
  );
  expect(img).toContain('<img src="/api/spaces/s1/file/raw?path=chart.png"');
  const json = renderToStaticMarkup(<PreviewPane preview={{ ...base, path: "a.json", text: '{"a":1}', truncated: false }} rawUrl="" />);
  expect(json).toContain("&quot;a&quot;: 1");
});
