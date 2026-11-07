# Atrium

Local bun/TypeScript engine that runs AI agents for one user on macOS.

## Global Constraints

- Project root: `~/dev-workspace/projects/atrium`. bun is the only runtime and package manager.
- The engine binds `127.0.0.1` only, port `7420`. It never listens on other interfaces.
- Data dir: `~/Library/Application Support/Atrium`, overridable with env `ATRIUM_HOME` (every test sets it to a temp dir).
- Claude runs through the subscription CLI (`claude`), never an API key. The binary path comes from config so tests can substitute a fake.
- Agents never read `.env` files, keys, or tokens. Claude runs inside Claude Code's sandbox with Atrium's pinned `--settings` (src/engine/agents/claude.ts); Codex and Gemini run inside Atrium's sandbox-exec profile (src/engine/agents/seatbelt.ts). Both block credentials, loopback (so agents can't call Atrium's API), Apple Events, `open` and Shortcuts.
- Agents work on branches named `atrium/<taskId>`. Atrium never checks out over uncommitted user changes. Anything that leaves the Mac (a push, a new GitHub repo, a text) is done by the engine, never an agent, and only after Nakul's yes.
- Idle engine does no polling loops. The runner wakes on events (task queued, approval resolved, power change) plus one power check every 60s.
- Heavy tasks run only on AC power unless the task has `allowOnBattery`. Light tasks run anytime.
- Transcript storage cap: 200 MB total, oldest deleted first. Each transcript is capped at 5 MB (truncated with a marker line).
- Commits use Nakul's configured git identity (SSH-signed). No `Co-Authored-By` trailers, no "Generated with" footers. Commit steps run only after Nakul has approved executing this plan.
- UI principle: **user-friendly but detailed.** Every list row shows a one-line summary, and clicking it opens the full detail (transcript, diff summary, timestamps). Errors are written in plain language with what to do next.
