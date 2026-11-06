# Copy inventory

Every surface Atrium shows text on, the rules that text follows, and where each file stands. The copy lint
(`tests/copy/lint.test.ts`) and the rendered checks (`tests/copy/rendered.test.tsx`) enforce the mechanical parts;
this page is the record of the reading pass.

## Rules

- Sentence case for buttons, headings, tabs, menu items, field labels and notification titles. Status tags and kind chips stay lowercase (`queued`, `in review`).
- Product terms: space, task, Needs you, review. The agents are Claude, Codex, Gemini and Auto. "Claude Code" appears only when the message is about the CLI program itself (install, login, update, sandbox). Also Atrium, dashboard, terminal app, Mac app, and engine (connection messages only).
- Every error says what happened in plain words, then what to do next, and ends with a full stop. Never `Error:`, `Failed to …`, `Unable to …`, or a bare status code.
- Full sentences end with a full stop and labels don't. One space after a full stop. Use `…` (one character), never `...`. Use straight quotes `"` around names. Use `·` as the inline separator. Avoid em dashes in UI copy.

## Surfaces

### Dashboard

| Area | File | String groups | Reviewed | Changed |
| --- | --- | --- | --- | --- |
| Views | `src/dashboard/components/Activity.tsx` | activity rows, empty state | yes | No change needed |
| Views | `src/dashboard/components/AgentPicker.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/Agents.tsx` | agent cards, status lines, reserve | yes | Cards say Claude, not Claude Code; straight quotes around "Run now" |
| Views | `src/dashboard/components/Avatar.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/CommandBar.tsx` | placeholder, hints, errors | yes | "e.g." became "like" |
| Investing | `src/dashboard/components/DataBudget.tsx` | labels, buttons, empty states, errors | deferred | Deferred to the investing redesign; read for outright errors, none found |
| Views | `src/dashboard/components/FilesTab.tsx` | folder line, file rows, empty states | yes | New in this plan; written to the rules |
| Views | `src/dashboard/components/Home.tsx` | greeting, briefing, space cards, new-space card | yes | New-space card: "just describe it" became "Describe it in a sentence and Atrium sets it up."; centred, balanced, focus ring; card titles carry a full title |
| Views | `src/dashboard/components/Logo.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/Markdown.tsx` | labels, buttons, empty states, errors | yes | New in this plan |
| Views | `src/dashboard/components/NeedsYou.tsx` | row summaries, decision buttons, send-back note, empty state | yes | Row summary is the first paragraph as plain text (no markdown); detail shows What it made; "View transcript in" became "Open the task in"; full title on hover |
| Views | `src/dashboard/components/PreviewPane.tsx` | preview notes, calendar list | yes | New in this plan; written to the rules |
| Views | `src/dashboard/components/ProjectDraft.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/Proposal.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/RepoRemoval.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/Rules.tsx` | rule list, rule detail, undo, empty states | yes | Em dash in the prose warning became a comma |
| Views | `src/dashboard/components/Settings.tsx` | section titles, help text, toggles, errors | yes | "Markets spaces" became "investing spaces"; Plan 10: Finnhub Required, Alpha Vantage Optional, Tiingo Not needed; Alpaca removal row |
| Views | `src/dashboard/components/Sidebar.tsx` | nav labels, footer status | yes | No change needed |
| Views | `src/dashboard/components/SpaceView.tsx` | tabs, task rows, task detail, not-found page, live column | yes | "Space not found" became "This space isn't here" with what to do; Tasks/Files tabs; "You asked" renders markdown; straight quotes around the parent task; full title on hover |
| Views | `src/dashboard/components/StatusIcon.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/Storage.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/Thread.tsx` | labels, buttons, empty states, errors | yes | Message bodies render as markdown |
| Views | `src/dashboard/components/Transcript.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/WaitLine.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/WhatItMade.tsx` | summary heading, decided line, file rows, actions | yes | New in this plan; written to the rules |
| Investing | `src/dashboard/components/markets/AdviceTag.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Investing | `src/dashboard/components/markets/Alerts.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Investing | `src/dashboard/components/markets/AllocationBars.tsx` | labels, buttons, empty states, errors | deferred | Deferred to the investing redesign; read for outright errors, none found |
| Investing | `src/dashboard/components/markets/Digest.tsx` | labels, buttons, empty states, errors | yes | Body renders as markdown; clamp works on any block |
| Investing | `src/dashboard/components/markets/Freshness.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Investing | `src/dashboard/components/markets/Health.tsx` | labels, buttons, empty states, errors | deferred | Deferred to the investing redesign; read for outright errors, none found |
| Investing | `src/dashboard/components/markets/Holdings.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Investing | `src/dashboard/components/markets/Ideas.tsx` | labels, buttons, empty states, errors | deferred | Deferred to the investing redesign; read for outright errors, none found |
| Investing | `src/dashboard/components/markets/ImportDialog.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Investing | `src/dashboard/components/markets/MarketsPanel.tsx` | back link | yes | Now AdvancedPanel; "← Back to ideas" |
| Investing | `src/dashboard/components/invest/AdvancedToggle.tsx` | switch label, hint, error | yes | New in Plan 10; written to the rules |
| Investing | `src/dashboard/components/invest/AlertsSimple.tsx` | alert rows, status chips, Turn on/off, paused line, hint | yes | New in Plan 10; singular and plural paused line |
| Investing | `src/dashboard/components/invest/Earnings.tsx` | date headings, time words, EPS line, chips, empty state, source footer | yes | New in Plan 10 |
| Investing | `src/dashboard/components/invest/InvestPanel.tsx` | tab labels, loading | yes | New in Plan 10 |
| Investing | `src/dashboard/components/invest/Portfolio.tsx` | hero labels, What moved, left-out line, empty state, import buttons | yes | New in Plan 10 |
| Investing | `src/dashboard/components/invest/Money.tsx` | ask box, starter questions, privacy line, month, categories, recurring, unusual, Wealthsimple totals, rules link | yes | New in Plan 10 (Money view) |
| Investing | `src/dashboard/components/invest/MoneyImport.tsx` | file picker, format line, column labels, sign and date choices, import result | yes | New in Plan 10 (Money view) |
| Investing | `src/dashboard/components/invest/MoneyRules.tsx` | rule editor labels, buttons, saved line, load error | yes | New in Plan 10 (Money view) |
| Investing | `src/dashboard/components/invest/PriceRow.tsx` | no-price and Alpha Vantage lines | yes | New in Plan 10 |
| Investing | `src/dashboard/components/invest/Sparkline.tsx` | none (aria-hidden) | yes | New in Plan 10 |
| Investing | `src/dashboard/components/invest/SymbolPage.tsx` | header, actions, alert form, position, earnings, stats, news, note, Ask Claude | yes | New in Plan 10; errors from the engine shown as written |
| Investing | `src/dashboard/components/invest/SymbolSearch.tsx` | placeholder, results, actions, added line, no-match line | yes | New in Plan 10 |
| Investing | `src/dashboard/components/invest/TvChart.tsx` | labels, privacy line, offline and failed cards, toggle | yes | New in Plan 10; privacy line shown once |
| Investing | `src/dashboard/components/invest/TvWidget.tsx` | frame titles | yes | New in Plan 10 |
| Investing | `src/dashboard/components/invest/Watchlists.tsx` | list chips, new and rename form, list menu, delete confirm, empty state, remove labels | yes | New in Plan 10 |
| Investing | `src/dashboard/simple.ts` | time words, date headings, money formats | yes | New in Plan 10 |
| Investing | `src/dashboard/components/markets/Paper.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Investing | `src/dashboard/components/markets/PriceChart.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Investing | `src/dashboard/components/markets/Research.tsx` | labels, buttons, empty states, errors | yes | Thesis draft and check render as markdown (layout deferred to the investing redesign) |
| Investing | `src/dashboard/components/markets/Screener.tsx` | labels, buttons, empty states, errors | deferred | Deferred to the investing redesign; read for outright errors, none found |
| Investing | `src/dashboard/components/markets/SourceTag.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Investing | `src/dashboard/components/markets/Strategies.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Investing | `src/dashboard/components/markets/TfsaCard.tsx` | labels, buttons, empty states, errors | deferred | Deferred to the investing redesign; read for outright errors, none found |
| Investing | `src/dashboard/components/markets/Watchlist.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Shared | `src/dashboard/agents.ts` | agent names, wait reasons | yes | No change needed |
| Shared | `src/dashboard/api.ts` | client error messages | yes | "Atrium answered with an error (500). Try again." became "Atrium couldn't do that (error 500). Try again, and check the engine log if it keeps happening." |
| Investing | `src/dashboard/chart-data.ts` | messages | yes | No change needed |
| Shared | `src/dashboard/files.ts` | action labels, feedback lines | yes | New in this plan; action labels and feedback lines |
| Shared | `src/dashboard/format.ts` | relative times, sizes | yes | No change needed |
| Investing | `src/dashboard/investing.ts` | messages | yes | No change needed |
| Shared | `src/dashboard/markdown.ts` | messages | yes | New in this plan |
| Investing | `src/dashboard/markets.ts` | messages | yes | No change needed |
| Shared | `src/dashboard/repos.ts` | messages | yes | No change needed |
| Shared | `src/dashboard/route.ts` | messages | yes | No change needed |
| Shared | `src/dashboard/summary.ts` | status text, review lines, briefing lines | yes | summaryLine() for one-line agent text |

### Terminal app

| Area | File | String groups | Reviewed | Changed |
| --- | --- | --- | --- | --- |
| Shared | `src/tui/client.ts` | messages | yes | Error copy matches the dashboard ("Atrium couldn't do that (error 500). Try again…") |
| Shared | `src/tui/detail.ts` | messages | yes | Summary and What it made; agent text through markdownLines; straight quotes around the parent task |
| Shared | `src/tui/edit.ts` | messages | yes | No change needed |
| Shared | `src/tui/effects.ts` | messages | yes | Open and reveal flashes |
| Shared | `src/tui/hooks.ts` | messages | yes | No change needed |
| Shared | `src/tui/keys.ts` | messages | yes | f F, o and R file keys in help and hints |
| Shared | `src/tui/layout.ts` | messages | yes | No change needed |
| Shared | `src/tui/markdown.ts` | messages | yes | New in this plan |
| Shared | `src/tui/select.ts` | messages | yes | No change needed |
| Shared | `src/tui/text.ts` | messages | yes | No change needed |
| Shared | `src/tui/theme.ts` | messages | yes | No change needed |
| Shared | `src/tui/ui.ts` | messages | yes | No change needed |
| Panes | `src/tui/components/ActivityPane.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/AgentsView.tsx` | labels, buttons, empty states, errors | yes | Agents are named Claude, Codex, Gemini, not Claude Code |
| Panes | `src/tui/components/App.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/Body.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/Confirm.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/DetailPane.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/Float.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/Header.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/Help.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/Lines.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/List.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/LivePane.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/NeedsPane.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/Pane.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/Picker.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/Prompt.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/Row.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/SpacesPane.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/StatusBar.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/TasksPane.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Panes | `src/tui/components/Transcript.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Shared | `src/tui/main.tsx` | labels, buttons, empty states, errors | yes | No change needed |

### Mac app

| Area | File | String groups | Reviewed | Changed |
| --- | --- | --- | --- | --- |
| App | `mac/Sources/App/AppDelegate.swift` | messages | yes | Sentence case: "Hide others", "Select all" |
| App | `mac/Sources/App/EngineClient.swift` | messages | yes | No change needed |
| App | `mac/Sources/App/MainWindow.swift` | messages | yes | No change needed |
| App | `mac/Sources/App/Notifier.swift` | messages | yes | No change needed |
| App | `mac/Sources/App/OfflineView.swift` | messages | yes | No change needed |
| App | `mac/Sources/App/StatusMenu.swift` | messages | yes | Sentence case: "Open at login", "Open notification settings…" |
| App | `mac/Sources/App/WebController.swift` | messages | yes | No change needed |
| App | `mac/Sources/App/main.swift` | messages | yes | No change needed |
| Core | `mac/Sources/Core/Decide.swift` | messages | yes | Review notes say how many files the task made; Plan 10: alert titles name the symbol ("AMZN price alert") |
| Core | `mac/Sources/Core/ContentRules.swift` | none | yes | New in Plan 10 |
| Core | `mac/Sources/Core/Model.swift` | messages | yes | Need.files, Need.symbol, Summary.embed |

### Engine messages that reach the UI

| Area | File | String groups | Reviewed | Changed |
| --- | --- | --- | --- | --- |
| Runs | `src/engine/runner.ts` | messages | yes | "Runner error:" became a sentence with a next step; "Atrium couldn't start the run" says what to check; "Repo is on …" says what to do; requeue lines are sentences; em dashes removed; made line added to reviews; kept-files path shown with ~ |
| Runs | `src/engine/approvals.ts` | messages | yes | No change needed |
| Runs | `src/engine/handoff.ts` | messages | yes | No change needed |
| Agents | `src/engine/agents/atrium-paths.ts` | messages | yes | No change needed |
| Agents | `src/engine/agents/claude.ts` | messages | yes | Not-installed message says how to fix it; probe detail is the next step only |
| Agents | `src/engine/agents/codex.ts` | messages | yes | Not-installed message says how to fix it; probe detail is the next step only |
| Agents | `src/engine/agents/gemini.ts` | messages | yes | Not-installed message says how to fix it; probe detail is the next step only |
| Agents | `src/engine/agents/limits.ts` | messages | yes | No change needed |
| Agents | `src/engine/agents/process.ts` | messages | yes | No change needed |
| Agents | `src/engine/agents/registry.ts` | messages | yes | Straight quotes around "Run now"; "to override" became "to skip the wait" |
| Agents | `src/engine/agents/seatbelt.ts` | messages | yes | No change needed |
| Agents | `src/engine/agents/short.ts` | messages | yes | No change needed |
| Agents | `src/engine/agents/types.ts` | messages | yes | No change needed |
| Runs | `src/engine/setup.ts` | messages | yes | No change needed |
| Runs | `src/engine/git.ts` | messages | yes | "Could not" became "Couldn't" (git's detail kept after the colon); "Folder not found" and "Not a git repo" say where to fix it |
| Runs | `src/engine/scratch.ts` | messages | yes | No change needed |
| Repos | `src/engine/repos/cleanup.ts` | messages | yes | No change needed |
| Repos | `src/engine/repos/clones.ts` | messages | yes | No change needed |
| Repos | `src/engine/repos/create.ts` | messages | yes | "Could not" became "Couldn't" |
| Repos | `src/engine/repos/gh.ts` | messages | yes | No change needed |
| Repos | `src/engine/repos/gitops.ts` | messages | yes | "Could not" became "Couldn't" |
| Repos | `src/engine/repos/index.ts` | messages | yes | No change needed |
| Repos | `src/engine/repos/names.ts` | messages | yes | No change needed |
| Repos | `src/engine/repos/push.ts` | messages | yes | No change needed |
| Repos | `src/engine/repos/rules.ts` | messages | yes | No change needed |
| Repos | `src/engine/repos/store.ts` | messages | yes | No change needed |
| Repos | `src/engine/repos/templates.ts` | messages | yes | No change needed |
| Investing | `src/engine/money/categories.ts` | rule validation | yes | New in Plan 10 (Money view) |
| Investing | `src/engine/money/import.ts` | skip reasons, warnings, guessed-layout line | yes | New in Plan 10 (Money view); every warning says what to do |
| Investing | `src/engine/money/summary.ts` | unusual-charge reasons, ask refusals, facts for Claude | yes | New in Plan 10 (Money view) |
| Investing | `src/server/money.ts` | 400, 404 and 413 sentences | yes | New in Plan 10 (Money view) |
| Investing | `src/engine/markets/advanced.ts` | none | yes | New in Plan 10 |
| Investing | `src/engine/markets/lists.ts` | list refusals | yes | New in Plan 10; every refusal says what to do |
| Investing | `src/engine/markets/search.ts` | validation, rate-limit and key notes, typed-symbol notes | yes | New in Plan 10 |
| Investing | `src/engine/markets/symbol.ts` | ask refusals, refresh notes, stat labels | yes | New in Plan 10 |
| Investing | `src/engine/markets/tradingview.ts` | coverage sentence | yes | New in Plan 10 |
| Investing | `src/engine/markets/views.ts` | earnings source line, left-out line | yes | New in Plan 10 |
| Investing | `src/server/embed.ts` | refusal, attribution | yes | New in Plan 10; TradingView attribution kept as designed |
| Investing | `src/server/investing-simple.ts` | 404 and 400 sentences | yes | New in Plan 10 |
| Investing | `src/engine/markets/agent.ts` | messages | yes | Filled/Refused lines use · instead of an em dash; moves say "on Fri, Nov 6" when the market is closed |
| Investing | `src/engine/markets/alerts.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/backtest.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/briefing.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/budget.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/cache.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/calendar.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/closes.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/csv.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/data.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/edgar.ts` | messages | yes | "Off — add a contact email" became "Off · add a contact email to turn it on" |
| Investing | `src/engine/markets/eod.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/estimate.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/events.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/feed.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/fx.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/health.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/holdings.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/ideas.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/import.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/indicators.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/instrument.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/jobs.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/keychain.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/labels.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/meta.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/paper.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/performance.ts` | messages | yes | Results end on the last close used, not today |
| Investing | `src/engine/markets/portfolio.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/redact.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/research.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/schema.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/screen.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/screener.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/seed.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/sourced.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/strategies.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/tfsa.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Investing | `src/engine/markets/watchlist.ts` | messages | yes | Read for outright errors; deeper copy deferred to the investing redesign |
| Rules | `src/engine/autonomy/facts.ts` | messages | yes | No change needed |
| Rules | `src/engine/autonomy/kinds.ts` | messages | yes | No change needed |
| Rules | `src/engine/autonomy/proposals.ts` | messages | yes | No change needed |
| Rules | `src/engine/autonomy/rules.ts` | messages | yes | No change needed |
| Runs | `src/engine/briefing.ts` | messages | yes | No change needed |
| Runs | `src/engine/summary.ts` | status text, review lines, briefing lines | yes | Need.files for the Mac app |
| Runs | `src/engine/folders.ts` | messages | yes | New: moved-folder activity line |
| Files | `src/engine/outputs/files.ts` | action labels, feedback lines | yes | New in this plan; every refusal says what to do |
| Files | `src/engine/outputs/kinds.ts` | messages | yes | New in this plan; no user strings |
| Files | `src/engine/outputs/open.ts` | messages | yes | New in this plan; every refusal says what to do |
| Files | `src/engine/outputs/snapshot.ts` | messages | yes | New in this plan; no user strings |
| Files | `src/engine/outputs/store.ts` | messages | yes | New: made line ("Made 3 files: a, b and c.") |
| Files | `src/engine/outputs/views.ts` | messages | yes | New in this plan |
| API errors | `src/server/files.ts` | action labels, feedback lines | yes | New in this plan; errors say what to do |
| API errors | `src/server/http.ts` | messages | yes | No change needed |
| API errors | `src/server/investing.ts` | messages | yes | No change needed |
| API errors | `src/server/markets.ts` | messages | yes | No change needed |
| API errors | `src/server/repos.ts` | messages | yes | No change needed |
| API errors | `src/server/server.ts` | messages | yes | No change needed |
| Runs | `src/cli.ts` | messages | yes | No change needed |

## Glossary

| Term | Use | Not |
| --- | --- | --- |
| space | A place for one kind of work: a repo, a general folder, or Investing. | project (except a new GitHub project), workspace |
| task | One thing an agent does in a space. | job, ticket |
| Needs you | The list of things waiting on Nakul. Always capitalised this way. | inbox, approvals |
| review | Looking at finished work and approving it or sending it back; also a second agent's check. | approval request |
| Claude, Codex, Gemini, Auto | The agents, by name. | Claude Code (except the CLI program), the model |
| Claude Code | Only the CLI program: installing, logging in, updating, its sandbox. | |
| Atrium | The product. | the app (ambiguous) |
| dashboard | The web view at 127.0.0.1:7420. | web app, UI |
| terminal app | The TUI. | TUI, CLI (the `atrium` command is the CLI) |
| Mac app | The menu bar and window app. | macOS app |
| engine | The background process; only in connection messages. | server, daemon |
| What it made | The files a task created, changed or deleted. | outputs, artifacts |

## Allowed exceptions

| Where | Exception | Why |
| --- | --- | --- |
| `src/tui/**` | Two spaces between hint groups (`j k move  q quit`). | The terminal has no other way to separate groups in one line. |
| Status tags and kind chips | Lowercase (`queued`, `in review`, `new`, `changed`). | They read as tags, not sentences. |
| Transcript viewer and live terminal | Agent output shown raw, monospace. | They are the record of what happened. |
| Table cells | `—` for a value Atrium doesn't have. | A standard empty-cell mark in numeric tables. |
| Strings with no letters | Not checked (`...` in a git range, `. ` as a separator). | They are code. |

## Starting point

Run on 2026-11-05 before the copy pass:

| Rule | Offences |
| --- | --- |
| no-ascii-ellipsis | 0 |
| one-space-after-stop | 0 |
| no-error-prefix | 0 |
| errors-end-in-a-stop | 0 |
| no-trailing-space-sentence | 0 |
| button-sentence-case | 0 |
| claude-code-only-for-cli | 0 |
| contrast (`--faint` on every surface, 2.45 to 2.94:1) | 4 |

The mechanical rules were already clean; the reading pass below is where the real changes are. After Tasks 13 and
14 every rule is at 0, contrast included, so the baseline file and its mechanism are gone: the lint now fails on any
offence.
