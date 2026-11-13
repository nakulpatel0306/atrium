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
| Views | `src/dashboard/components/Activity.tsx` | day headings, folded lines, Show more, task History | yes | Plan 13: grouped by day, one line per stretch of a task's work ("ran, wrote 2 files, waiting for review"), repeats folded with ×N, "Show more · N earlier" |
| Views | `src/dashboard/components/BriefCard.tsx`, `BriefQuestions.tsx`, `LoopPanel.tsx` | brief fields, gap hints, stage strip, checks badge, pause actions | yes | New with the loop; "Give it a hint", "Explain the problem instead", "Unverified: no checks found" |
| Views | `src/dashboard/components/Shape.tsx` | shape line and override, cost chip, parts and attempts | yes | New with shapes: "Single writer: …", "Change", "Open 2 pull requests", "Merge into one branch", "Pick this one", "None of these", estimates labelled "est." |
| Views | `src/dashboard/components/Agents.tsx` | models by job, plan gauge, spend | yes | "Models by job", "Atrium ran … in this window", what the gauge can't see |
| Views | `src/dashboard/components/ArchivedSpaces.tsx` | Archived spaces heading, rows, Restore, Delete…, empty state | yes | New in Plan 13 |
| Views | `src/dashboard/components/DeleteSpace.tsx` | Delete "Name" for good?, This removes, what stays, typed-name prompt, Delete forever | yes | New in Plan 13; says plainly that a repo task's branch stays and Atrium never touches your repo or GitHub |
| Views | `src/dashboard/components/DeleteTask.tsx` | Delete task…, what goes with it | yes | New in Plan 13 |
| Views | `src/dashboard/components/StopTask.tsx` | Stop…, the two-step confirm, Keep running | yes | New in Plan 15 |
| Views | `src/dashboard/components/Toast.tsx` | toast text, Undo, Dismiss | yes | New in Plan 13: Archived / Restored / Deleted lines |
| Shared | `src/dashboard/deletion.ts` | delete lists for space and task | yes | New in Plan 13; shared with the terminal app |
| Views | `src/dashboard/components/AgentPicker.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/Agents.tsx` | agent cards, status lines, reserve | yes | Cards say Claude, not Claude Code; straight quotes around "Run now" |
| Views | `src/dashboard/components/Avatar.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/CommandBar.tsx` | placeholder, hints, errors | yes | "e.g." became "like" |
| Views | `src/dashboard/components/FilesTab.tsx` | folder line, file rows, empty states | yes | New in this plan; written to the rules |
| Views | `src/dashboard/components/Home.tsx` | greeting, briefing, space cards, new-space card | yes | New-space card: "just describe it" became "Describe it in a sentence and Atrium sets it up."; centred, balanced, focus ring; card titles carry a full title |
| Views | `src/dashboard/components/Logo.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/Markdown.tsx` | labels, buttons, empty states, errors | yes | New in this plan |
| Views | `src/dashboard/components/OutcomeBanner.tsx` | Couldn't do this, Partly done, can't tell banners; Accept anyway / Accept as is | yes | New in Plan 11 |
| Views | `src/dashboard/components/NeedsYou.tsx` | row summaries, decision buttons, send-back note, empty state | yes | Row summary is the first paragraph as plain text (no markdown); detail shows What it made; "View transcript in" became "Open the task in"; full title on hover; Plan 11: outcome banner under the row, "Accept anyway" / "Accept as is" |
| Views | `src/dashboard/components/PreviewPane.tsx` | preview notes, calendar list | yes | New in this plan; written to the rules |
| Views | `src/dashboard/components/ProjectDraft.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/Proposal.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/RepoRemoval.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/Rules.tsx` | rule list, rule detail, undo, empty states | yes | Em dash in the prose warning became a comma |
| Views | `src/dashboard/components/Settings.tsx` | section titles, help text, toggles, errors | yes | Market data and accounts sections removed with those features |
| Views | `src/dashboard/components/Sidebar.tsx` | nav labels, footer status | yes | No change needed |
| Views | `src/dashboard/components/SpaceView.tsx` | tabs, task rows, task detail, not-found page, live column | yes | "Space not found" became "This space isn't here" with what to do; Tasks/Files tabs; "You asked" renders markdown; straight quotes around the parent task; full title on hover |
| Views | `src/dashboard/components/StatusIcon.tsx` | labels, buttons, empty states, errors | yes | Plan 11: Not done and Partly done labels for finished tasks |
| Views | `src/dashboard/components/Storage.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/Thread.tsx` | labels, buttons, empty states, errors | yes | Message bodies render as markdown |
| Views | `src/dashboard/components/Transcript.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/WaitLine.tsx` | labels, buttons, empty states, errors | yes | No change needed |
| Views | `src/dashboard/components/WhatItMade.tsx` | summary heading, decided line, file rows, actions | yes | New in this plan; written to the rules |
| Shared | `src/dashboard/agents.ts` | agent names, wait reasons | yes | No change needed |
| Shared | `src/dashboard/api.ts` | client error messages | yes | "Atrium answered with an error (500). Try again." became "Atrium couldn't do that (error 500). Try again, and check the engine log if it keeps happening." |
| Shared | `src/dashboard/files.ts` | action labels, feedback lines | yes | New in this plan; action labels and feedback lines |
| Shared | `src/dashboard/format.ts` | relative times, sizes | yes | No change needed |
| Shared | `src/dashboard/markdown.ts` | messages | yes | New in this plan |
| Shared | `src/dashboard/repos.ts` | messages | yes | No change needed |
| Shared | `src/dashboard/route.ts` | messages | yes | No change needed |
| Shared | `src/dashboard/summary.ts` | status text, review lines, briefing lines | yes | summaryLine() for one-line agent text |

### Terminal app

| Area | File | String groups | Reviewed | Changed |
| --- | --- | --- | --- | --- |
| Shared | `src/tui/client.ts` | messages | yes | Error copy matches the dashboard ("Atrium couldn't do that (error 500). Try again…") |
| Shared | `src/tui/detail.ts` | messages | yes | Plan 15: empty states point at the new layout ("Pick a task on the left", "Press space and describe one") |
| Shared | `src/tui/edit.ts` | messages | yes | No change needed |
| Shared | `src/tui/effects.ts` | messages | yes | Plan 15: stop, and the replies to a new request |
| Shared | `src/tui/hooks.ts` | messages | yes | No change needed |
| Shared | `src/tui/keys.ts` | help, key strip, flashes | yes | Plan 15: help grouped by tab; key strip labels |
| Shared | `src/tui/markdown.ts` | messages | yes | No change needed |
| Shared | `src/tui/select.ts` | messages | yes | No change needed |
| Shared | `src/tui/text.ts` | messages | yes | No change needed |
| Shared | `src/tui/theme.ts` | Claude meter | yes | Plan 15: "Claude · no reading yet", "paused" when tasks wait on the reserve |
| Shared | `src/tui/ui.ts` | messages | yes | No change needed |
| Shared | `src/tui/canvas.ts`, `src/tui/mouse.ts`, `src/tui/boot-env.ts` | none | yes | New in Plan 15; no user-facing text |
| Screens | `src/tui/screens/chrome.ts` | tabs, Ask box titles and suggestions, offline word | yes | New in Plan 15 |
| Screens | `src/tui/screens/home.ts` | briefing, Needs you cards and their keys, Today, Running | yes | New in Plan 15 |
| Screens | `src/tui/screens/spaces.ts` | section labels, empty lists, Live | yes | New in Plan 15 (from the Plan 3 panes) |
| Screens | `src/tui/screens/activity.ts` | feed, Lines | yes | New in Plan 15 (from the Plan 13 pane) |
| Screens | `src/tui/screens/overlays.ts` | confirms (send, accept, archive, stop, import), delete box, pickers, help, agents and usage | yes | New in Plan 15 (from Confirm, DeleteBox, Picker, Help, AgentsView); buttons in sentence case |
| Screens | `src/tui/screens/compose.ts` | full view titles | yes | New in Plan 15 |
| Views | `src/tui/components/App.tsx` | connecting, offline, too small | yes | Plan 15: no change to the words |
| Views | `src/tui/components/Screen.tsx` | none | yes | New in Plan 15 |

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
| Core | `mac/Sources/Core/Decide.swift` | messages | yes | Review notes say how many files the task made; titles say when a result is only partly done or couldn't be done |
| Core | `mac/Sources/Core/ContentRules.swift` | none | yes | New in Plan 10 |
| Core | `mac/Sources/Core/Model.swift` | messages | yes | Need.files, Need.outcome (titles come from the engine) |

### Engine messages that reach the UI

| Area | File | String groups | Reviewed | Changed |
| --- | --- | --- | --- | --- |
| Runs | `src/engine/runner.ts` | messages | yes | "Runner error:" became a sentence with a next step; "Atrium couldn't start the run" says what to check; "Repo is on …" says what to do; requeue lines are sentences; em dashes removed; made line added to reviews; kept-files path shown with ~ |
| Runs | `src/engine/handoff.ts`, `src/engine/checks/` | review prompt, loop notes on approvals, attention notes | yes | The loop: "Checks: passed (…)", "Unverified: … couldn't run", "Already failing before this task", "Review round N by …", "Look closely: …" |
| Server | `src/server/loop.ts` | errors | yes | Brief, hint, explain and budget routes; errors say what to do next. Shape, parts and pick routes refuse with the reason ("Two of the parts touch the same files, so one writer does it.") |
| Runs | `src/engine/shape.ts`, `fanout.ts`, `scouts.ts`, `sessions.ts` | shape reasons, fan-out activity, scout and judge prompts, progress notes | yes | New with shapes; "Dropped: its checks failed (…)", "None of the 2 attempts passed Atrium's checks…" |
| Runs | `src/engine/approvals.ts` | messages | yes | No change needed |
| Delete | `src/engine/delete.ts`, `src/engine/delete-files.ts` | refusals, kept-folder lines | yes | New in Plan 13: every refusal says nothing was deleted and what to do; "Kept <file>: it changed after the task made it."; clone-in-flight and space-busy refusals; "Deleted "X". Its folder … went to the Trash." / "Atrium couldn't move … to the Trash, so it's still there; delete it in Finder if you don't need it." |
| Engine | `src/engine/crash-guard.ts` | restart line | yes | Plan 13: "Atrium restarted after an error. Check engine.log if something looks off." |
| Runs | `src/engine/handoff.ts` | messages | yes | No change needed |
| Agents | `src/engine/agents/atrium-paths.ts` | messages | yes | No change needed |
| Agents | `src/engine/agents/claude.ts` | messages | yes | Not-installed message says how to fix it; probe detail is the next step only; Plan 14: a private space's run on an old Claude Code says to run `claude update` |
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
| API errors | `src/server/repos.ts` | messages | yes | No change needed |
| API errors | `src/server/server.ts` | messages | yes | No change needed |
| Runs | `src/cli.ts` | messages | yes | No change needed |

## Glossary

| Term | Use | Not |
| --- | --- | --- |
| space | A place for one kind of work: a repo or a general folder. | project (except a new GitHub project), workspace |
| task | One thing an agent does in a space. | job, ticket |
| Needs you | The list of things waiting on you. Always capitalised this way. | inbox, approvals |
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
