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
| Views | `src/dashboard/components/Activity.tsx` | activity rows, empty state | no | |
| Views | `src/dashboard/components/AgentPicker.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/Agents.tsx` | agent cards, status lines, reserve | no | |
| Views | `src/dashboard/components/Avatar.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/CommandBar.tsx` | placeholder, hints, errors | no | |
| Investing | `src/dashboard/components/DataBudget.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/FilesTab.tsx` | folder line, file rows, empty states | no | |
| Views | `src/dashboard/components/Home.tsx` | greeting, briefing, space cards, new-space card | no | |
| Views | `src/dashboard/components/Logo.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/Markdown.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/NeedsYou.tsx` | row summaries, decision buttons, send-back note, empty state | no | |
| Views | `src/dashboard/components/PreviewPane.tsx` | preview notes, calendar list | no | |
| Views | `src/dashboard/components/ProjectDraft.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/Proposal.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/RepoRemoval.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/Rules.tsx` | rule list, rule detail, undo, empty states | no | |
| Views | `src/dashboard/components/Settings.tsx` | section titles, help text, toggles, errors | no | |
| Views | `src/dashboard/components/Sidebar.tsx` | nav labels, footer status | no | |
| Views | `src/dashboard/components/SpaceView.tsx` | tabs, task rows, task detail, not-found page, live column | no | |
| Views | `src/dashboard/components/StatusIcon.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/Storage.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/Thread.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/Transcript.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/WaitLine.tsx` | labels, buttons, empty states, errors | no | |
| Views | `src/dashboard/components/WhatItMade.tsx` | summary heading, decided line, file rows, actions | no | |
| Investing | `src/dashboard/components/markets/AdviceTag.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/Alerts.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/AllocationBars.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/Digest.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/Freshness.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/Health.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/Holdings.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/Ideas.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/ImportDialog.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/MarketsPanel.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/Paper.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/PriceChart.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/Research.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/Screener.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/SourceTag.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/Strategies.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/TfsaCard.tsx` | labels, buttons, empty states, errors | no | |
| Investing | `src/dashboard/components/markets/Watchlist.tsx` | labels, buttons, empty states, errors | no | |
| Shared | `src/dashboard/agents.ts` | agent names, wait reasons | no | |
| Shared | `src/dashboard/api.ts` | client error messages | no | |
| Investing | `src/dashboard/chart-data.ts` | messages | no | |
| Shared | `src/dashboard/files.ts` | action labels, feedback lines | no | |
| Shared | `src/dashboard/format.ts` | relative times, sizes | no | |
| Investing | `src/dashboard/investing.ts` | messages | no | |
| Shared | `src/dashboard/markdown.ts` | messages | no | |
| Investing | `src/dashboard/markets.ts` | messages | no | |
| Shared | `src/dashboard/repos.ts` | messages | no | |
| Shared | `src/dashboard/route.ts` | messages | no | |
| Shared | `src/dashboard/summary.ts` | status text, review lines, briefing lines | no | |

### Terminal app

| Area | File | String groups | Reviewed | Changed |
| --- | --- | --- | --- | --- |
| Shared | `src/tui/client.ts` | messages | no | |
| Shared | `src/tui/detail.ts` | messages | no | |
| Shared | `src/tui/edit.ts` | messages | no | |
| Shared | `src/tui/effects.ts` | messages | no | |
| Shared | `src/tui/hooks.ts` | messages | no | |
| Shared | `src/tui/keys.ts` | messages | no | |
| Shared | `src/tui/layout.ts` | messages | no | |
| Shared | `src/tui/markdown.ts` | messages | no | |
| Shared | `src/tui/select.ts` | messages | no | |
| Shared | `src/tui/text.ts` | messages | no | |
| Shared | `src/tui/theme.ts` | messages | no | |
| Shared | `src/tui/ui.ts` | messages | no | |
| Panes | `src/tui/components/ActivityPane.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/AgentsView.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/App.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/Body.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/Confirm.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/DetailPane.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/Float.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/Header.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/Help.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/Lines.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/List.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/LivePane.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/NeedsPane.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/Pane.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/Picker.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/Prompt.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/Row.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/SpacesPane.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/StatusBar.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/TasksPane.tsx` | labels, buttons, empty states, errors | no | |
| Panes | `src/tui/components/Transcript.tsx` | labels, buttons, empty states, errors | no | |
| Shared | `src/tui/main.tsx` | labels, buttons, empty states, errors | no | |

### Mac app

| Area | File | String groups | Reviewed | Changed |
| --- | --- | --- | --- | --- |
| App | `mac/Sources/App/AppDelegate.swift` | messages | no | |
| App | `mac/Sources/App/EngineClient.swift` | messages | no | |
| App | `mac/Sources/App/MainWindow.swift` | messages | no | |
| App | `mac/Sources/App/Notifier.swift` | messages | no | |
| App | `mac/Sources/App/OfflineView.swift` | messages | no | |
| App | `mac/Sources/App/StatusMenu.swift` | messages | no | |
| App | `mac/Sources/App/WebController.swift` | messages | no | |
| App | `mac/Sources/App/main.swift` | messages | no | |
| Core | `mac/Sources/Core/Decide.swift` | messages | no | |
| Core | `mac/Sources/Core/Model.swift` | messages | no | |

### Engine messages that reach the UI

| Area | File | String groups | Reviewed | Changed |
| --- | --- | --- | --- | --- |
| Runs | `src/engine/runner.ts` | messages | no | |
| Runs | `src/engine/approvals.ts` | messages | no | |
| Runs | `src/engine/handoff.ts` | messages | no | |
| Agents | `src/engine/agents/atrium-paths.ts` | messages | no | |
| Agents | `src/engine/agents/claude.ts` | messages | no | |
| Agents | `src/engine/agents/codex.ts` | messages | no | |
| Agents | `src/engine/agents/gemini.ts` | messages | no | |
| Agents | `src/engine/agents/limits.ts` | messages | no | |
| Agents | `src/engine/agents/process.ts` | messages | no | |
| Agents | `src/engine/agents/registry.ts` | messages | no | |
| Agents | `src/engine/agents/seatbelt.ts` | messages | no | |
| Agents | `src/engine/agents/short.ts` | messages | no | |
| Agents | `src/engine/agents/types.ts` | messages | no | |
| Runs | `src/engine/setup.ts` | messages | no | |
| Runs | `src/engine/git.ts` | messages | no | |
| Runs | `src/engine/scratch.ts` | messages | no | |
| Repos | `src/engine/repos/cleanup.ts` | messages | no | |
| Repos | `src/engine/repos/clones.ts` | messages | no | |
| Repos | `src/engine/repos/create.ts` | messages | no | |
| Repos | `src/engine/repos/gh.ts` | messages | no | |
| Repos | `src/engine/repos/gitops.ts` | messages | no | |
| Repos | `src/engine/repos/index.ts` | messages | no | |
| Repos | `src/engine/repos/names.ts` | messages | no | |
| Repos | `src/engine/repos/push.ts` | messages | no | |
| Repos | `src/engine/repos/rules.ts` | messages | no | |
| Repos | `src/engine/repos/store.ts` | messages | no | |
| Repos | `src/engine/repos/templates.ts` | messages | no | |
| Investing | `src/engine/markets/agent.ts` | messages | no | |
| Investing | `src/engine/markets/alerts.ts` | messages | no | |
| Investing | `src/engine/markets/backtest.ts` | messages | no | |
| Investing | `src/engine/markets/briefing.ts` | messages | no | |
| Investing | `src/engine/markets/budget.ts` | messages | no | |
| Investing | `src/engine/markets/cache.ts` | messages | no | |
| Investing | `src/engine/markets/calendar.ts` | messages | no | |
| Investing | `src/engine/markets/closes.ts` | messages | no | |
| Investing | `src/engine/markets/csv.ts` | messages | no | |
| Investing | `src/engine/markets/data.ts` | messages | no | |
| Investing | `src/engine/markets/edgar.ts` | messages | no | |
| Investing | `src/engine/markets/eod.ts` | messages | no | |
| Investing | `src/engine/markets/estimate.ts` | messages | no | |
| Investing | `src/engine/markets/events.ts` | messages | no | |
| Investing | `src/engine/markets/feed.ts` | messages | no | |
| Investing | `src/engine/markets/fx.ts` | messages | no | |
| Investing | `src/engine/markets/health.ts` | messages | no | |
| Investing | `src/engine/markets/holdings.ts` | messages | no | |
| Investing | `src/engine/markets/ideas.ts` | messages | no | |
| Investing | `src/engine/markets/import.ts` | messages | no | |
| Investing | `src/engine/markets/indicators.ts` | messages | no | |
| Investing | `src/engine/markets/instrument.ts` | messages | no | |
| Investing | `src/engine/markets/jobs.ts` | messages | no | |
| Investing | `src/engine/markets/keychain.ts` | messages | no | |
| Investing | `src/engine/markets/labels.ts` | messages | no | |
| Investing | `src/engine/markets/meta.ts` | messages | no | |
| Investing | `src/engine/markets/paper.ts` | messages | no | |
| Investing | `src/engine/markets/performance.ts` | messages | no | |
| Investing | `src/engine/markets/portfolio.ts` | messages | no | |
| Investing | `src/engine/markets/redact.ts` | messages | no | |
| Investing | `src/engine/markets/research.ts` | messages | no | |
| Investing | `src/engine/markets/schema.ts` | messages | no | |
| Investing | `src/engine/markets/screen.ts` | messages | no | |
| Investing | `src/engine/markets/screener.ts` | messages | no | |
| Investing | `src/engine/markets/seed.ts` | messages | no | |
| Investing | `src/engine/markets/sourced.ts` | messages | no | |
| Investing | `src/engine/markets/strategies.ts` | messages | no | |
| Investing | `src/engine/markets/tfsa.ts` | messages | no | |
| Investing | `src/engine/markets/watchlist.ts` | messages | no | |
| Rules | `src/engine/autonomy/facts.ts` | messages | no | |
| Rules | `src/engine/autonomy/kinds.ts` | messages | no | |
| Rules | `src/engine/autonomy/proposals.ts` | messages | no | |
| Rules | `src/engine/autonomy/rules.ts` | messages | no | |
| Runs | `src/engine/briefing.ts` | messages | no | |
| Runs | `src/engine/summary.ts` | status text, review lines, briefing lines | no | |
| Runs | `src/engine/folders.ts` | messages | no | |
| Files | `src/engine/outputs/files.ts` | action labels, feedback lines | no | |
| Files | `src/engine/outputs/kinds.ts` | messages | no | |
| Files | `src/engine/outputs/open.ts` | messages | no | |
| Files | `src/engine/outputs/snapshot.ts` | messages | no | |
| Files | `src/engine/outputs/store.ts` | messages | no | |
| Files | `src/engine/outputs/views.ts` | messages | no | |
| API errors | `src/server/files.ts` | action labels, feedback lines | no | |
| API errors | `src/server/http.ts` | messages | no | |
| API errors | `src/server/investing.ts` | messages | no | |
| API errors | `src/server/markets.ts` | messages | no | |
| API errors | `src/server/repos.ts` | messages | no | |
| API errors | `src/server/server.ts` | messages | no | |
| Runs | `src/cli.ts` | messages | no | |

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

The mechanical rules were already clean; the reading pass below is where the real changes are.
