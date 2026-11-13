# Atrium

Local bun/TypeScript engine that runs AI agents for one user on macOS.

## Global Constraints

- Project root: the repo root (wherever you cloned it). bun is the only runtime and package manager.
- The engine binds `127.0.0.1` only, port `7420` (`ATRIUM_PORT` overrides it). It never listens on other interfaces.
- Data dir: `~/Library/Application Support/Atrium`, overridable with env `ATRIUM_HOME` (every test sets it to a temp dir).
- Projects folder: a Settings value (`projects.root`), else `~/Developer` if it exists, else `~/Projects`. `ATRIUM_PROJECTS_ROOT` overrides both. Read it with `config().projectsRoot`, never hard-code a folder.
- Claude runs through the subscription CLI (`claude`), never an API key. The binary path comes from config so tests can substitute a fake.
- Agents never read `.env` files, keys, or tokens. Claude runs inside Claude Code's sandbox with Atrium's pinned `--settings` (src/engine/agents/claude.ts); Codex and Gemini run inside Atrium's sandbox-exec profile (src/engine/agents/seatbelt.ts). Both block credentials, loopback (so agents can't call Atrium's API), Apple Events, `open` and Shortcuts.
- Agents work on branches named `atrium/<taskId>`. Atrium never checks out over uncommitted user changes. Anything that leaves the Mac (a push, a new GitHub repo, a text) is done by the engine, never an agent, and only after the user's yes.
- Idle engine does no polling loops. The runner wakes on events (task queued, approval resolved, power change) plus one power check every 60s.
- Heavy tasks run only on AC power unless the task has `allowOnBattery`. Light tasks run anytime.
- Transcript storage cap: 200 MB total, oldest deleted first. Each transcript is capped at 5 MB (truncated with a marker line).
- Commits use your own configured git identity. No `Co-Authored-By` trailers, no "Generated with" footers.
- UI principle: **user-friendly but detailed.** Every list row shows a one-line summary, and clicking it opens the full detail (transcript, diff summary, timestamps). Errors are written in plain language with what to do next.

## Tests

Run in groups: `bun test ./tests/engine`, `./tests/server`, `./tests/dashboard`, `./tests/e2e`, `./tests/tui`, `./tests/mac`, `./tests/copy`, `./tests/cli.test.ts`, `./tests/main.test.ts`. Then `bunx tsc --noEmit`. Migrations only add: an existing database must keep working, and a migration gets a test against a database shaped like an older install.

## Public repo

This repo is public and its owner also uses it daily. Anything added must be safe for everyone by default.

- Nothing personal goes in code, tests, fixtures or docs: no real names, holdings, amounts, accounts, phone numbers, paths or messages.
- Test data is always made up: 555 phone numbers, `example.com` addresses, invented names and tickers used as plain test data.
- Every per-user value lives in the user's SQLite database, the macOS Keychain or `~/Atrium`, never in source. Source holds neutral defaults only.
- A new feature must work on a fresh install with no data. When that's relevant, add a test that boots an empty `ATRIUM_HOME`.
- Plans, review records and real screenshots live outside the repo, in a private notes folder. They never go in `docs/`.
- Before sharing a branch, run `bun run leak-check`. Add your own private terms with `--denylist <file>` or `ATRIUM_LEAK_DENYLIST`; keep that file outside the repo.
