# Changelog

What changed in each version of Atrium, in plain words. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [semantic versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **Deleting a code space now removes its hidden folder in Atrium's data** (where files from its scratch runs were kept) instead of leaving it behind. Your repo is never touched.

## [0.1.0] - 2026-11-19

The first version for people other than its author. Atrium is early: it works every day on one Mac, and this release is about finding out what gets in the way on yours.

### What Atrium does

- **Runs on your Claude subscription.** Coding tasks go through the Claude Code CLI on your Mac. There's no API key, and nothing runs on a server of Atrium's.
- **Runs every coding task through the same steps:** brief, write, verify, review, you. A one-line ask becomes a short brief with acceptance criteria. The agent works on its own `atrium/<task>` branch. Atrium then runs your repo's own typecheck, lint and test commands itself, in a sandboxed checkout, rather than trusting the agent's word. A fresh reviewer reads the diff against the brief. Results that couldn't be proven are labelled that way.
- **Keeps one queue of what needs you:** approvals, questions, pauses and proposals, longest-waiting first. Each opens to one screen with its walkthrough, diff, checks and review findings, and every action has a key.
- **Pushes only after you approve.** Atrium never checks out over your uncommitted changes, and only the engine pushes a branch or creates a GitHub repo, after your yes.
- **Uses one writer by default.** Read-only scouts, a split into parts, or best-of-N attempts run only when you click. Every task shows its tokens and an estimate at list prices.
- **Explains the work if you want it to:** a walkthrough on every result, "explain this hunk", a short retro built only from what Atrium measured, and proposed lines for your repo's CLAUDE.md that you accept or ignore. None of it is a step you have to take.
- **Sandboxes agents.** They can't read your keys, `.env` files or passwords, can't reach Atrium's own API, and can't drive other apps.
- **Has three views of the same state:** the dashboard in your browser, a small Mac app, and a terminal app (`atrium`).
- **Checks your setup.** Get started checks Claude and git, picks your projects folder, and offers a one-minute sample task on a bundled demo repo. `atrium doctor` runs the same checks in a terminal, and `atrium --version` prints the version.
- **Works with optional extras:** Codex or Gemini as writers or a second reviewer, and the GitHub CLI for pull requests.

### Known limits

- macOS on Apple silicon only.
- Checks are evidence, not proof. [docs/loop.md](docs/loop.md) lists what they can't catch.
- See the README's [Known limits](README.md#known-limits) for the rest.

[0.1.0]: https://github.com/nakulpatel0306/atrium/releases/tag/v0.1.0
