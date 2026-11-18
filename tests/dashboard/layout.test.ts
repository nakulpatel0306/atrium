import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "..", "src", "dashboard", "styles.css"), "utf8");
const rule = (selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.*]/g, "\\$&")} \\{([^}]*)\\}`))?.[2] ?? "";

test("the ask bar is docked under the page, so it never covers what's being read", () => {
  // A band at the bottom of the column, not a box floating over the content.
  expect(rule(".cmd-dock")).toContain("position: sticky");
  expect(rule(".cmd-dock")).toContain("bottom: 0");
  expect(rule(".cmd")).not.toContain("position: fixed");
  // Scrolling something into view stops above the band.
  expect(rule("main")).toContain("scroll-padding-bottom: var(--cmd-clear)");
  expect(Number(rule(":root").match(/--cmd-clear:\s*(\d+)px/)?.[1])).toBeGreaterThanOrEqual(10 + 48 + 14);
});

test("no rule sets a display on every input in the ask bar, which would show its hidden file picker", () => {
  // Any selector list holding a bare `.cmd input` must not carry a display.
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = m[1]!.split(",").map((s) => s.trim());
    if (selectors.includes(".cmd input")) expect(m[2]).not.toMatch(/display\s*:/);
  }
});

test("a long dialog scrolls inside itself and keeps its buttons on screen in a short window", () => {
  expect(rule(".dialog")).toContain("max-height: calc(100dvh - 48px)");
  expect(rule(".dialog")).toContain("overflow-y: auto");
  expect(rule(".dialog-acts")).toContain("position: sticky");
  expect(rule(".dialog-acts")).toContain("background: var(--panel)");
});

// Every padding, margin and gap in the dashboard, with the selector it's under.
const spacing = () =>
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].flatMap((m) =>
    [...m[2]!.matchAll(/(?:^|;)\s*((?:padding|margin|gap|row-gap|column-gap)[a-z-]*)\s*:\s*([^;]+)/g)].map((d) => ({ at: `${m[1]!.trim()} { ${d[1]}: ${d[2]!.trim()} }`, value: d[2]!.trim() })),
  );

test("spacing comes from one scale of tokens, not one-off pixel values", () => {
  const scale = [...rule(":root").matchAll(/--space-(\d+):\s*(\d+)px/g)].map((m) => [Number(m[1]), Number(m[2])]);
  // Named for their size, on a 4px rhythm with 2 and 6 as the half steps dense controls need.
  expect(scale).toEqual([2, 4, 6, 8, 12, 16, 20, 24, 32, 48, 64].map((n) => [n, n]));
  // A hairline (1px), nothing, auto or a viewport share are fine; every other length is a token.
  // A sum of steps (an indent that lines up with a column) is still the scale.
  const bare = (v: string) => v.replace(/calc\(([^()]|var\(--space-\d+\))*\)/g, (c) => c.replace(/var\(--space-\d+\)|calc|[\d\s()+*-]/g, "")).replace(/var\(--space-\d+\)|-?1px|\b0\b|auto|\d+vh/g, "").trim();
  const odd = spacing().filter((d) => bare(d.value) !== "");
  expect(odd.map((d) => d.at)).toEqual([]);
});

test("type comes from one scale: every font size and line height is a token, in a shorthand too", () => {
  // A `font:` shorthand's size and line height count as well.
  const shorthand = [...css.matchAll(/(?:^|[;{\s])font:\s*([^;]+);/g)].map((m) => m[1]!.trim()).filter((v) => v !== "inherit");
  expect(shorthand.filter((v) => /\d(px|em|rem)\b|\/\s*[\d.]/.test(v.replace(/var\(--[a-z0-9-]+\)/g, "")))).toEqual([]);
  const heights = [...css.matchAll(/line-height:\s*([^;]+);/g)].map((m) => m[1]!.trim());
  expect(heights.filter((v) => !/^var\(--lh-[a-z]+\)$/.test(v))).toEqual([]);
  expect([...rule(":root").matchAll(/--lh-([a-z]+):/g)].map((m) => m[1])).toEqual(["none", "tight", "snug", "body", "loose"]);
  const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1]!.trim());
  // Inline code is sized against the text it sits in, so it keeps a relative size.
  expect(sizes.filter((v) => !/^var\(--fs-[a-z0-9]+\)$/.test(v) && !/^\d*\.?\d+em$/.test(v))).toEqual([]);
});

test("a Home row shows its whole reason on a line under the title, never cut to a few letters", () => {
  expect(rule(".summary-row > .t")).toContain("white-space: normal");
  expect(rule(".summary-row > .t span")).toContain("display: block");
  expect(rule(".summary-row > .t span")).not.toContain("line-clamp");
  // Every row's status, cost and button share columns, so they line up down the list.
  expect(rule(".needs-list .summary-row")).toContain('grid-template-areas: "dot who t state cost acts"');
  // Its columns are tokens too, so Home's rows and a space's rows can't drift apart.
  for (const m of css.matchAll(/\.summary-row \{[^}]*grid-template-columns:\s*([^;]+);/g)) expect(m[1]!.replace(/var\(--[a-z0-9-]+\)|minmax\(0, 1fr\)|auto/g, "").trim()).toBe("");
});

test("buttons take their height from the control scale, so one row never mixes two heights", () => {
  expect([...rule(":root").matchAll(/--control(-[a-z]+)?:\s*(\d+)px/g)].map((m) => Number(m[2]))).toEqual([24, 28, 32, 36]);
  // No control sets its own pixel floor.
  expect(css.match(/min-height:\s*2[0-9]px/g)).toBeNull();
  expect(rule(".btn")).toContain("min-height: var(--control-sm)");
  expect(rule(".mk-form .btn")).toContain("min-height: var(--control)");
  expect(rule(".decision-acts .btn")).toContain("min-height: var(--control-lg)");
});

test("a stage it got past but that failed draws a red dot, not the green one passed stages use", () => {
  expect(rule(".stages li.past.bad::before")).toContain("background: var(--red)");
  expect(rule(".stages li.past.bad::before")).toContain("border-color: var(--red)");
  expect(rule(".stages li.past.bad")).toContain("color: var(--red)");
});

test("a short window gives the queue's height to the decision, so its buttons are on screen at 900×420", () => {
  // Measured in a browser at 900×420: a clean result's Approve and every way on from a loop or budget pause sit above the
  // ask bar. These are the rules that make that so.
  expect(rule(".queue-page h1")).toContain("font-size: var(--fs-2xl)");
  const short = css.slice(css.indexOf("@media (max-height: 640px)"));
  expect(short).toMatch(/\.queue-page \.dp-means,\s*\.queue-page \.dp-body > \.stages,\s*\.queue-page \.nudge p \{\s*display: none;/);
  expect(short).toMatch(/\.queue-page \.paused \.hint-form \.acts \{\s*order: -1;/);
  expect(short).toMatch(/\.queue-page \.paused \.hint-form \{\s*display: contents;/);
});

test("a failure line in Activity and History wraps rather than cutting off what went wrong", () => {
  expect(css).toMatch(/\n\.feed \.tone-failure \.msg \{[^}]*white-space: normal;/);
});

test("on a phone every Home row wraps the same way: status and cost on one line, the button on the next", () => {
  const phone = css.slice(css.indexOf("Always two lines under the reason"));
  expect(phone).toMatch(/^[^}]*\.needs-list \.summary-row > \.acts \{\s*flex: 1 1 100%;/);
});

test("opening Changes keeps the space page in two columns: the diff takes the main one and Live stays beside it", () => {
  // Two tracks, the first the diff's: never the single column that sent Live under Activity.
  const block = css.match(/\n\.cols:has\(\.changes-section\) \{([^}]*)\}/)![1]!;
  expect(block).toContain("grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr)");
  expect(css).not.toContain(".cols:has(.changes-section) > .live");
});

test("queue rows stay one line, and below 480px the space's name gives its room to the title", () => {
  expect(css).toMatch(/@media \(max-width: 479px\) \{\s*\.q-row \.q-space \{\s*display: none;/);
});

test("on the narrow rail each space shows its name, cut with an ellipsis, under its swatch", () => {
  const rail = css.slice(css.indexOf("@media (max-width: 999px)"));
  const name = rail.match(/aside:not\(\.open\) \.space-link \.label \{([^}]*)\}/)?.[1] ?? "";
  // Undoes the rail's visually-hidden label for spaces only.
  expect(name).toContain("position: static");
  expect(name).toContain("clip-path: none");
  expect(name).toContain("text-overflow: ellipsis");
  expect(name).toContain("font-size: var(--fs-xs)");
  expect(rail).toMatch(/aside:not\(\.open\) \.space-link \{[^}]*flex-direction: column;/);
});

test("in one column, a waiting question's Answer form comes first on the space page, above the task list", () => {
  const one = css.slice(css.indexOf("A question waiting before its task starts is the page's first thing"));
  // Live, holding the question, moves above the tasks...
  expect(one).toMatch(/^[^@]*@container main \(max-width: 960px\) \{\s*\.cols > \.live:has\(\.live-ask\) \{\s*order: -1;/);
  // ...and inside it the form comes before the terminal or the idle line.
  expect(one).toMatch(/\.live:has\(\.live-ask\) \.live-ask \{\s*order: -1;/);
});
