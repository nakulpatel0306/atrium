import { expect, test } from "bun:test";
import { etClock, etDate, etInstant, marketNow, usEarlyCloses, usHolidays, usSession } from "../../../src/engine/markets/calendar";

test("NYSE holidays", () => {
  expect(usHolidays(2026).map((h) => h.date)).toEqual([
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  ]);
  const y27 = usHolidays(2027).map((h) => h.date);
  for (const d of ["2027-03-26", "2027-06-18", "2027-07-05", "2027-12-24"]) expect(y27).toContain(d);
  const y22 = usHolidays(2022).map((h) => h.date);
  expect(y22).not.toContain("2021-12-31");
  expect(y22).not.toContain("2022-01-01");
  expect(usHolidays(2026).find((h) => h.date === "2026-11-26")!.name).toBe("Thanksgiving Day");
});

test("early closes", () => {
  expect(usEarlyCloses(2026)).toEqual(["2026-11-27", "2026-12-24"]);
  expect(usEarlyCloses(2027)).toEqual(["2027-11-26"]);
});

test("sessions", () => {
  expect(usSession(Date.parse("2026-11-05T14:30:00Z")).open).toBe(true);
  const pre = usSession(Date.parse("2026-07-01T13:29:00Z"));
  expect(pre.open).toBe(false);
  expect(pre.nextOpen).toBe(Date.parse("2026-07-01T13:30:00Z"));
  expect(pre.opensAt).toBe(Date.parse("2026-07-01T13:30:00Z"));
  expect(pre.closesAt).toBe(Date.parse("2026-07-01T20:00:00Z"));
  const early = usSession(Date.parse("2026-11-27T18:30:00Z"));
  expect(early.open).toBe(false);
  expect(early.earlyClose).toBe(true);
  expect(early.closesAt).toBe(Date.parse("2026-11-27T18:00:00Z"));
  const hol = usSession(Date.parse("2026-11-26T15:00:00Z"));
  expect(hol.open).toBe(false);
  expect(hol.holiday).toBe("Thanksgiving Day");
  expect(hol.opensAt).toBeNull();
  expect(hol.nextOpen).toBe(Date.parse("2026-11-27T14:30:00Z"));
  const sat = usSession(Date.parse("2026-11-07T17:00:00Z"));
  expect(sat.open).toBe(false);
  expect(sat.nextOpen).toBe(Date.parse("2026-11-09T14:30:00Z"));
  const afterClose = usSession(Date.parse("2026-11-05T21:30:00Z"));
  expect(afterClose.open).toBe(false);
  expect(afterClose.nextOpen).toBe(Date.parse("2026-11-06T14:30:00Z"));
});

test("ET helpers", () => {
  expect(etDate(Date.parse("2026-11-05T03:00:00Z"))).toBe("2026-11-04");
  expect(etClock(Date.parse("2026-11-05T15:42:00Z"))).toBe("10:42 AM ET");
  expect(etInstant("2026-11-05", "09:30")).toBe(Date.parse("2026-11-05T14:30:00Z"));
  expect(etInstant("2026-07-01", "16:00")).toBe(Date.parse("2026-07-01T20:00:00Z"));
});

test("the shifted market clock only applies in demo mode", () => {
  process.env.ATRIUM_MARKET_NOW = "2026-11-04T10:00:00-05:00";
  try {
    const demo = marketNow("demo");
    // The shift is fixed when the module loads, so the demo clock has run on by however long this process has.
    const target = Date.parse("2026-11-04T15:00:00Z");
    expect(demo).toBeGreaterThanOrEqual(target - 1000);
    expect(demo).toBeLessThanOrEqual(target + process.uptime() * 1000 + 1000);
    expect(Math.abs(marketNow("alpaca") - Date.now())).toBeLessThan(1000);
  } finally {
    delete process.env.ATRIUM_MARKET_NOW;
  }
  expect(Math.abs(marketNow("demo") - Date.now())).toBeLessThan(1000);
});
