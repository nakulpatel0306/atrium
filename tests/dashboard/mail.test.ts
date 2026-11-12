import { expect, test } from "bun:test";
import { agenda, overlaps, peopleLine, placeDay, splitQuoted, type EventView } from "../../src/dashboard/mail";

const H = 3600_000;
const DAY = Date.parse("2026-11-09T00:00:00");
const ev = (id: string, start: number, end: number, allDay = false): EventView => ({
  id,
  calendar: { id: "c", title: "Home", color: "#4cb782", source: "apple" },
  title: id,
  start,
  end,
  allDay,
  location: "",
  attendees: [],
  organizer: null,
  myStatus: null,
  recurring: false,
});

test("quoted history folds at 'On … wrote:' and at a trailing run of > lines", () => {
  expect(splitQuoted("Thursday works.\n\nOn Mon, Nov 9, Robin wrote:\n> Can we sign?")).toEqual({ body: "Thursday works.", quoted: "On Mon, Nov 9, Robin wrote:\n> Can we sign?" });
  expect(splitQuoted("Yes.\n> earlier\n>\n> more")).toEqual({ body: "Yes.", quoted: "> earlier\n>\n> more" });
  // Inline quoting that the reply answers between stays in the body.
  expect(splitQuoted("> one\nanswer\n> two\nanswer").quoted).toBeNull();
  expect(splitQuoted("Just text").quoted).toBeNull();
});

test("overlapping events share the day's width; separate ones get it all", () => {
  const placed = placeDay([ev("a", DAY + 9 * H, DAY + 10 * H), ev("b", DAY + 9.5 * H, DAY + 11 * H), ev("c", DAY + 13 * H, DAY + 14 * H), ev("all", DAY, DAY + 24 * H, true)]);
  const by = Object.fromEntries(placed.map((p) => [p.event.id, [p.col, p.cols]]));
  expect(by).toEqual({ a: [0, 2], b: [1, 2], c: [0, 1] });
  expect([...overlaps([ev("a", DAY + 9 * H, DAY + 10 * H), ev("b", DAY + 9.5 * H, DAY + 11 * H), ev("c", DAY + 13 * H, DAY + 14 * H)])].sort()).toEqual(["a", "b"]);
});

test("the agenda always shows today and tomorrow, then only days with events", () => {
  const now = DAY + 8 * H;
  const groups = agenda([ev("x", DAY + 3 * 24 * H + 9 * H, DAY + 3 * 24 * H + 10 * H)], now);
  expect(groups.map((g) => [g.label === "Today" || g.label === "Tomorrow" ? g.label : "later", g.events.length])).toEqual([["Today", 0], ["Tomorrow", 0], ["later", 1]]);
});

test("people lines name first names and count the rest", () => {
  expect(peopleLine([{ name: "Robin Vale", address: "r@example.net" }, { name: "", address: "kit@example.org" }, { name: "Ana", address: "a@example.com" }])).toBe("Robin, kit +1");
  expect(peopleLine([])).toBe("Only you");
});
