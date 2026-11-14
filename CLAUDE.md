# Atrium

Local bun/TypeScript engine that runs AI agents for one user on macOS, focused on agentic coding: code spaces with live diff, steer and pull request, plus general spaces for the work around it.

## Global Constraints

- Project root: the repo root (wherever you cloned it). bun is the only runtime and package manager.
- The engine binds `127.0.0.1` only, port `7420` (`ATRIUM_PORT` overrides it). It never listens on other interfaces.
- Data dir: `~/Library/Application Support/Atrium`, overridable with env `ATRIUM_HOME` (every test sets it to a temp dir).
- Projects folder: a Settings value (`projects.root`), else `~/Developer` if it exists, else `~/Projects`. `ATRIUM_PROJECTS_ROOT` overrides both. Read it with `config().projectsRoot`, never hard-code a folder.
- Claude runs through the subscription CLI (`claude`), never an API key. The binary path comes from config so tests can substitute a fake.
- Agents never read `.env` files, keys, or tokens. Claude runs inside Claude Code's sandbox with Atrium's pinned `--settings` (src/engine/agents/claude.ts), with only the built-in tools Atrium allows that run (`--tools`), so no Agent, worktree or scheduling tools, and with no settings file loaded (`--setting-sources ''`, hooks disabled), so a repo's `.claude/settings.json` can't run hooks or an apiKeyHelper or set the CLI's env; Codex and Gemini run inside Atrium's sandbox-exec profile (src/engine/agents/seatbelt.ts). Both block credentials, loopback (so agents can't call Atrium's API), writes to `node_modules` and `.venv`, Apple Events, `open` and Shortcuts.
- Agents work on branches named `atrium/<taskId>`. Atrium never checks out over uncommitted user changes. Anything that leaves the Mac (a push, a new GitHub repo) is done by the engine, never an agent, and only after the user's yes.
- Idle engine does no polling loops. The runner wakes on events (task queued, approval resolved, power change) plus one power check every 60s.
- Heavy tasks run only on AC power unless the task has `allowOnBattery`. Light tasks run anytime.
- Transcript storage cap: 200 MB total, oldest deleted first. Each transcript is capped at 5 MB (truncated with a marker line).
- Commits use your own configured git identity. No `Co-Authored-By` trailers, no "Generated with" footers.
- Coding tasks run the loop (docs/loop.md): brief → write → verify → review → you. The engine runs checks itself, never trusting an agent's word, under the check profile in `src/engine/checks/sandbox.ts`, which agents never run under. Checks run in a checkout of their own, with command definitions from the task's base commit; known ways a change can alter what the checks mean are closed or become attention notes that no rule may approve past, and docs/loop.md lists the ones that stay open. Keep to the gate threat model there: close a tampering route or flag it, nothing more.
- One writer is the default shape. Anything a model produces (the pre-pass's shape, scouts' answers, the best-of-N judge's scores) is a proposal: it never widens what runs, raises a budget or sets a command the gate trusts, and untrusted text reaches a prompt fenced with a per-run marker. A split or best-of-N runs only on the user's click, each part or attempt on its own branch, never two writers on one. Claude keeps a writer's session between turns (Claude Code's own session files) except in private spaces.
- UI principle: **user-friendly but detailed.** Every list row shows a one-line summary, and clicking it opens the full detail (transcript, diff summary, timestamps). Errors are written in plain language with what to do next.

## Tests

Run in groups: `bun test ./tests/engine`, `./tests/server`, `./tests/dashboard`, `./tests/e2e`, `./tests/tui`, `./tests/mac`, `./tests/copy`, `./tests/cli.test.ts`, `./tests/main.test.ts`. Then `bunx tsc --noEmit`. Migrations only add: an existing database must keep working, and a migration gets a test against a database shaped like an older install. Tables of removed features (markets, money, mail, texting) stay in old databases, unread, until the user chooses Remove old data, which drops them; `src/engine/legacy.ts` is the one place that knows their names.

## Public repo

This repo is public and its owner also uses it daily. Anything added must be safe for everyone by default.

- Nothing personal goes in code, tests, fixtures or docs: no real names, accounts, paths or messages.
- Test data is always made up: `example.com` addresses and invented names.
- Every per-user value lives in the user's SQLite database, the macOS Keychain or `~/Atrium`, never in source. Source holds neutral defaults only.
- A new feature must work on a fresh install with no data. When that's relevant, add a test that boots an empty `ATRIUM_HOME`.
- Plans, review records and real screenshots live outside the repo, in a private notes folder. They never go in `docs/`.
- Before sharing a branch, run `bun run leak-check`. Add your own private terms with `--denylist <file>` or `ATRIUM_LEAK_DENYLIST`; keep that file outside the repo.
