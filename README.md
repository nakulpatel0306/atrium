# Atrium

A personal command center for macOS. A local engine runs AI agents on your
projects and life admin, and a Linear-style dashboard shows what they did and
what needs your yes.

![Home](docs/plans/plan-1-record/shots/13-home-attention.png)

## How it works

- **Spaces** are areas of work: a repo, school, a job search. You create one by
  describing it in the command bar, and a setup agent fills in the details and
  suggests starter tasks.
- **Tasks** run through Claude Code on your subscription. Code tasks work on
  their own `atrium/<task>` branch and never touch your checkout or push.
- **Review** gates everything: nothing counts as done until you approve it.
- The engine sleeps when idle, runs heavy work only on AC power, waits out
  usage limits, and caps stored transcripts at 200 MB.

## Use it

```sh
bun install
bun link            # puts `atrium` on your PATH
atrium install      # start at login (launchd)
atrium open         # http://127.0.0.1:7420
atrium status
atrium uninstall
```

Data lives in `~/Library/Application Support/Atrium`.

## Develop

```sh
bun test
bunx tsc --noEmit
ATRIUM_DEV=1 bun src/main.ts
```

Design: [`docs/2026-11-03-atrium-design.md`](docs/2026-11-03-atrium-design.md).
Plans and build records live in [`docs/plans`](docs/plans).
