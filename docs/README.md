# Atrium docs

Start with the [main README](../README.md) for what Atrium does and how to set it up.

## The design

- [`2026-11-03-atrium-design.md`](2026-11-03-atrium-design.md) is the design.
  Decisions made later are added as dated addenda at the end.
- [`copy-inventory.md`](copy-inventory.md) holds the wording rules for every
  screen. All UI text follows them.
- [`brand/`](brand) has the logo and brand options. [`mockups/`](mockups) has the
  first home screen mockup.
- [`screenshots/`](screenshots) has the images used in the README.

## How it was built

Atrium was built in numbered plans, each one a working step.

| Plan | What it added |
| --- | --- |
| 1 | The engine, the dashboard and the `atrium` command |
| 2 | Agent sandboxes, signed commits, Codex and Gemini |
| 3 | The terminal app |
| 4 | Earned autonomy: rules for what can run without asking |
| 5 | Markets and paper trading |
| 6 | The native Mac app |
| 7 | The investing workspace |
| 8 | Creating new projects and GitHub repos |
| 9 | Seeing what agents made, and a full wording pass |
| 10 | Simpler investing with TradingView charts, plus Money |
| 11 | Sending texts, and honest "couldn't do it" results |
| 13 | Delete, undo and a shorter activity feed |

Plan 12, talking to Atrium by voice, comes next.

In [`plans/`](plans):
- `YYYY-MM-DD-plan-N-*.md` is the plan as written.
- `plan-N-record/` holds what actually happened: the build report, reviews and
  rulings.
- `plan-N-shots/` holds the screenshots taken while building.

There are also two smaller rounds of work:
- `investing-audit-2026-11-06.md` and `investing-fixes-record/` cover a check of
  the investing views against real data, and the fixes that followed.
- `tsx-intraday-record/` covers live TSX prices from Yahoo Finance.

Research notes: `plan-2-research.md` covers agent CLIs and sandboxing, and
`investing-data-research.md` covers free market data sources.
