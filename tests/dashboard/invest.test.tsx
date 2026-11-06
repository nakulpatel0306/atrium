import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdvancedToggleView } from "../../src/dashboard/components/invest/AdvancedToggle";
import { InvestTabs } from "../../src/dashboard/components/invest/InvestPanel";

const tabs = (advanced: boolean) => renderToStaticMarkup(<InvestTabs spaceId="spc_1" advanced={advanced} tab="portfolio" onTab={() => {}} />);
const labels = (html: string) => [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);

test("Advanced off shows the four simple views only", () => {
  expect(labels(tabs(false))).toEqual(["Portfolio", "Watchlists", "Earnings", "Alerts"]);
});

test("Advanced on adds Health, Ideas, Chart and Paper", () => {
  expect(labels(tabs(true))).toEqual(["Portfolio", "Watchlists", "Earnings", "Alerts", "Health", "Ideas", "Chart", "Paper"]);
});

test("the Advanced switch explains what it hides", () => {
  const html = renderToStaticMarkup(<AdvancedToggleView on={false} open busy={false} error={null} onToggle={() => {}} onOpen={() => {}} />);
  expect(html).toContain("Advanced tools");
  expect(html).toContain("Look-through, TFSA, ideas, screener, paper trading, indicator alerts and the data budget. Off keeps them saved and stops their background work.");
  expect(html).toContain('role="switch"');
  expect(html).toContain('aria-checked="false"');
});
