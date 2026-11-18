# Architecture

Atrium is a local engine plus three ways to look at it. Everything runs on one Mac.

## The engine

A bun/TypeScript process (`src/main.ts`) that binds `127.0.0.1:7420` only. It owns a SQLite database (`atrium.db` in the data folder), a transcripts folder, and the schedule of work. When installed, launchd starts it at login. Nothing polls while it is idle: the runner wakes when a task is queued, an approval is resolved or power changes, plus one power check a minute.

Personal values live in the database's `settings` table, in other tables, or in `~/Atrium` (space files). Source holds neutral defaults only. `atrium data` lists where each lives.

## Spaces and tasks

A **space** is a place for one kind of work. There are two kinds: `repo` (a git checkout) and `general` (a folder under `~/Atrium`). A space of a kind an older version had (Investing, Inbox) opens as a plain private general space. A **task** belongs to a space, has a weight (heavy tasks wait for AC power) and goes to an agent. Each run keeps a transcript, and the task ends with an outcome: done, partial or couldn't, in the agent's own words.

## The loop

A coding task runs brief → write → verify → review → you. Its first stage drafts a brief with a small read-only Claude pass. After each writer turn the engine runs the repo's own checks in a checkout of their own (under a sandbox profile of their own), feeds failures back, sends passing work to a fresh reviewer as a child task, and then creates the approval. Budgets and loop detection pause a task that stops making progress. The pre-pass also proposes the task's shape (one writer, scouts, a split into child tasks, or best-of-N attempts), and each run is logged in `usage_log` with its tokens by model and a list-price estimate. See [the loop](loop.md).

## Agents

An adapter per CLI: `claude` (the Claude Code CLI on your subscription), `codex` and `agy` (Gemini through Antigravity). A registry probes whether each is installed and signed in, tracks usage limits and decides which agent a task can use. Free agents are preferred when allowed; private spaces only ever use Claude. Code tasks run on a branch named `atrium/<taskId>`.

## The sandbox

Claude runs inside Claude Code's own sandbox with settings Atrium pins. Codex and Gemini run inside a `sandbox-exec` profile. Both block credentials, loopback (so an agent can't call Atrium's API), Apple Events, `open` and Shortcuts. Agents never see `.env` files, keys or tokens.

## What needs you

`src/engine/needs.ts` is the one definition of what's waiting on the user, imports nothing but types, and every surface reads it: the dashboard's queue, the terminal app's Home, the Mac app's badge and notifications (through `/api/summary`) and `atrium status`. It also decides which results may be approved together, and the engine checks that rule again before a batch approval.

## Draft-and-wait

Anything that leaves the Mac is done by the engine, never an agent, and only after the user's yes: a push, a new GitHub repo. The agent drafts; Atrium stores the draft on an approval card in **Needs you**; pressing Approve is the only path to the action. Standing rules can pre-approve some results, and every rule decision is logged and can be undone.

## The dashboard

A React app (`src/dashboard`) served by the engine on the same port and kept live by a WebSocket. It includes Get started (Claude, a projects folder, and an optional sample task that copies `assets/sample-repo` under the data folder's `samples/` and runs the loop on it), Needs you (the queue beside one decision screen per item, the diff included; every decision on a result goes through one `DecisionBar`), every space view and Settings. ⌘K opens a command palette of every action by name, built from state in `palette.ts`; / goes to the ask bar. Styles are one CSS file on design tokens (colour, type, line height, space, control heights, radius, motion). `tests/dashboard/layout.test.ts` checks that every padding, margin, gap, font size and line height uses a token, that no control sets its own pixel height, and that the summary rows' columns are tokens; other widths (the sidebar, cards, the queue's columns) are still set where they're used with a dark and a light set, following the Mac's setting unless the palette picks one. Long lists draw only what's in view, off-screen diff files skip layout, and render budgets for the queue and the diff view are part of the test suite.

## The terminal app

`atrium` with no arguments starts an Ink app (`src/tui`) that talks to the engine over the same HTTP API as the dashboard. Its Home is the same queue in the same order, with the same keys.

## The Mac app

`atrium app install` builds `Atrium.app` with `swiftc` from `mac/`: a small native window around the dashboard, plus notifications for things that need you. It points at the engine's port.
