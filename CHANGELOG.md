# Changelog

What changed in each version of Atrium, in plain words. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [semantic versioning](https://semver.org/).

## [0.1.0] - 2026-11-19

The first version for people other than its author. Atrium is early: it works every day on one Mac, and this release is about finding out what gets in the way on yours.

### What Atrium does

- **Runs coding tasks on your own Claude subscription**, through the Claude Code CLI on your Mac. No API key, and nothing runs in a cloud of Atrium's.
- **Every task runs one loop: brief, write, verify, review, you.** A one-line ask becomes a short brief with acceptance criteria. The agent works on its own `atrium/<task>` branch. Atrium then runs your repo's own typecheck, lint and test commands itself, in a sandboxed checkout, rather than trusting the agent's word. A fresh reviewer reads the diff against the brief. Results that couldn't be proven are labelled that way.
- **One queue for everything that needs you**: approvals, questions, pauses and proposals, longest-waiting first, each with its walkthrough, diff, checks and review findings on one screen, and keyboard keys for all of it.
- **Pull requests only after your yes.** Atrium never checks out over your uncommitted changes, and only the engine pushes or creates a GitHub repo, after you approve.
- **The right shape for the job.** One writer by default; read-only scouts, a split into parts, or best-of-N attempts only when you click. Every task shows its tokens and an estimate at list prices.
- **Help getting better at it, never in the way**: a walkthrough on every result, "explain this hunk", a short retro built only from what Atrium measured, and proposed lines for your repo's CLAUDE.md that you accept or ignore.
- **Agents are sandboxed.** They can't read your keys, `.env` files or passwords, can't reach Atrium's own API, and can't drive other apps.
- **Three ways in, one live state**: the dashboard in your browser, a small Mac app, and a terminal app (`atrium`).
- **Get started** checks Claude and git, picks your projects folder, and offers a one-minute sample task on a bundled demo repo. `atrium doctor` shows the same checks in a terminal.
- **Optional extras**: Codex or Gemini as writers or a second reviewer, and the GitHub CLI for pull requests.

### Known limits

- macOS on Apple silicon only.
- Checks are evidence, not proof. [docs/loop.md](docs/loop.md) lists what they can't catch.
- See the README's [Known limits](README.md#known-limits) for the rest.

[0.1.0]: https://github.com/nakulpatel0306/atrium/releases/tag/v0.1.0
