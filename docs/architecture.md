# Architecture

Atrium is a local engine plus three ways to look at it. Everything runs on one Mac.

## The engine

A bun/TypeScript process (`src/main.ts`) that binds `127.0.0.1:7420` only. It owns a SQLite database (`atrium.db` in the data folder), a transcripts folder, and the schedule of work. When installed, launchd starts it at login. Nothing polls while it is idle: the runner wakes when a task is queued, an approval is resolved or power changes, plus one power check a minute.

Personal values live in the database's `settings` table, in other tables, in the macOS Keychain (market-data keys) or in `~/Atrium` (space files). Source holds neutral defaults only. `atrium data` lists where each lives.

## Spaces and tasks

A **space** is a place for one kind of work. There are three kinds: `repo` (a git checkout), `general` (a folder under `~/Atrium`) and `markets` (investing and money, private). A **task** belongs to a space, has a weight (heavy tasks wait for AC power) and goes to an agent. Each run keeps a transcript, and the task ends with an outcome: done, partial or couldn't, in the agent's own words.

## Agents

An adapter per CLI: `claude` (the Claude Code CLI on your subscription), `codex` and `agy` (Gemini through Antigravity). A registry probes whether each is installed and signed in, tracks usage limits and decides which agent a task can use. Free agents are preferred when allowed; private spaces only ever use Claude. Code tasks run on a branch named `atrium/<taskId>`.

## The sandbox

Claude runs inside Claude Code's own sandbox with settings Atrium pins. Codex and Gemini run inside a `sandbox-exec` profile. Both block credentials, loopback (so an agent can't call Atrium's API), Apple Events, `open` and Shortcuts. Agents never see `.env` files, keys or tokens.

## Draft-and-wait

Anything that leaves the Mac is done by the engine, never an agent, and only after the user's yes: a push, a new GitHub repo, a text. The agent drafts; Atrium stores the draft on an approval card in **Needs you**; pressing Send or Approve is the only path to the action. Standing rules can pre-approve some results, and every rule decision is logged and can be undone.

## Investing and money

The `markets` space holds holdings, watchlists, lists, alerts, research notes and imported bank files. Market data comes through a provider layer (Finnhub, Yahoo for TSX, optional Alpha Vantage and Tiingo, or a Demo provider with made-up prices). Money imports are parsed and masked on the Mac. Only compact facts go to Claude when you ask a question.

## The dashboard

A React app (`src/dashboard`) served by the engine on the same port and kept live by a WebSocket. It includes the Get started wizard, Settings and every space view.

## The terminal app

`atrium` with no arguments starts an Ink app (`src/tui`) that talks to the engine over the same HTTP API as the dashboard.

## The Mac app

`atrium app install` builds `Atrium.app` with `swiftc` from `mac/`: a small native window around the dashboard, plus notifications for things that need you. It points at the engine's port.
