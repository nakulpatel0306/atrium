# Atrium

A calm command center for your AI agents, on your Mac.

You tell Atrium what you want in plain words. It hands the job to an AI agent, shows you what came back, and waits for your yes before anything counts. Code, and the everyday jobs around it, live in one place. Everything runs on your Mac.

Site: <https://nakulpatel0306.github.io/atrium/>

![Atrium's Home: finished work waiting for a yes, your spaces, and what happened today](docs/screenshots/home.jpg)

## What it does

- **Everyday life and work.** Ask for a grocery list, a packing plan or a study guide. You get a file you can open in Finder.
- **Code.** Point it at a repo and ask for a fix or a review. Agents work on their own branch, and you review every change. Starting a new project creates the GitHub repo too, after you say yes.

Work is organized into **spaces**. Each space has **tasks**, and each task goes to an agent: Claude on your Claude subscription, or Codex and Gemini for some code work. Anything that needs you waits in **Needs you**.

## Screenshots

All screenshots use made-up data.

| | |
|---|---|
| ![Get started: checking that Claude, Codex and Gemini are installed and signed in](docs/screenshots/setup.jpg) | |
| **Get started** checks your agents and walks you through setup. | |

## Requirements

- A Mac with Apple silicon, macOS 14 or later
- [bun](https://bun.sh)
- Xcode command line tools (`xcode-select --install`), needed to build the Mac app
- The [Claude Code](https://claude.com/claude-code) CLI, signed in to your Claude account (a subscription; no API key)
- Optional: `codex` (Codex CLI), `agy` (Antigravity, for Gemini) and `gh` (GitHub CLI, for code spaces)

## Install

```sh
git clone https://github.com/nakulpatel0306/atrium.git
cd atrium
bun install
bun link             # puts `atrium` on your PATH
atrium install       # starts Atrium now and at every login
atrium app install   # adds Atrium.app to ~/Applications
```

Don't move or delete the folder after `atrium install`: the login service points at it. To move it, run `atrium uninstall`, move it, and install again.

## First run

Open the app (or run `atrium open`). On a fresh install, **Get started** walks you through it: your agents (Claude Code is required, Codex and Gemini are optional), the GitHub CLI, and your name and projects folder. You can skip everything except Claude and come back from **Settings → Get started**.

From a terminal, `atrium doctor` shows the same checks, with the install and sign-in command for anything missing.

## Privacy and safety

- Your data stays on your Mac. The database, transcripts and space files are under your data folder (`atrium data` lists them with sizes). This repository contains no personal data.
- To remove all personal data, run `atrium uninstall`, quit Atrium, then delete `~/Library/Application Support/Atrium` and `~/Atrium`.
- Agents run in a sandbox: they can't read your passwords or keys, can't control other apps, and can't change Atrium itself.
- Only Atrium pushes code or creates repos, and only after you approve. Private spaces only use Claude.
- Archive a space to hide it, or delete it for good by typing its name. Deleted folders go to the Trash.

## Known limits

- macOS only.
- An older database keeps the tables of features that were removed (investing, money, mail and calendar, texting). Atrium no longer reads them; spaces of those kinds show as plain private spaces.

## For developers

```sh
bun test ./tests/engine   # run tests in groups: engine, server, dashboard,
bun test ./tests/server   # e2e, tui, mac, copy, cli.test.ts, main.test.ts
bunx tsc --noEmit
bun run leak-check
ATRIUM_DEV=1 ATRIUM_HOME=$(mktemp -d) ATRIUM_PORT=7421 bun src/main.ts
```

See [CONTRIBUTING notes in CLAUDE.md](CLAUDE.md) and the [docs](docs/README.md). Screenshots go in `docs/screenshots/`.

## License

[MIT](LICENSE)
