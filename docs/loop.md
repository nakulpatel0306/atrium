# The loop

Every coding task in Atrium runs the same loop: **brief → write → verify → review → you.** A result reaches you once Atrium's own checks and a fresh reviewer have been at it, with what each found attached. When the checks couldn't prove anything, or the review didn't happen, it still reaches you, labelled as such. Everything here works with only the Claude CLI installed; Codex and Gemini only widen the choice of reviewer.

Why this shape: in studies of agent failures, about 44% come from the task spec (agents ignoring it, repeating steps, not knowing when they're done) and about 24% from weak or missing verification. When maintainers reviewed agent pull requests that had passed a benchmark's tests, roughly half were still not mergeable. A clean-context reviewer finds real problems that the agent which wrote the code stopped seeing. So the levers are a better brief, a check the agent can't fake, and an independent read for mergeability, not more agents.

## The brief

**Enter** in the ask bar starts the task at once. Its first stage, which runs on battery too since it's a short read-only call, drafts the brief: a small, fast Claude model (through the CLI, read-only on the repo, a few turns at most) turns the one-liner into

- **Goal**: one sentence.
- **Acceptance criteria**: what has to be true when it's done. General spaces call these "done when".
- **Check with**: `auto` for the checks Atrium finds, or a command you chose.
- **Scope** and **not in scope**, **look at first** (files), and a **size** (small, medium, large) that sets the default budget.

The brief, its one-line gap hints ("No way to check this is done: add a test command or acceptance check") and any questions show on the task. The pre-pass asks at most two questions, and only when the ask could reasonably mean two different things. When it does, the task waits in **Needs you** for one-tap answers (or a few words), which travel with the brief; **Start** sends what's answered. The terminal app answers them too: `a` on the card, a number for each listed answer. Every needs-you count (the dashboard, the terminal app, the Mac app's badge, `atrium status`) includes these tasks, from one definition in `src/engine/needs.ts`. Otherwise the writer starts as soon as the brief is ready.

**⌘↩** is "brief first": the draft appears under the ask to edit before anything runs. Esc cancels a draft still on its way, or discards the card; ⌘↩ in the card runs it.

The pre-pass never picks the check command. It reads a repo that may be written to mislead it, so a command it suggests shows as "Use `…` as the check", and only your click (or your edit in the brief-first card, or the space's settings) sets it.

The brief reaches the writer as sections of its prompt, including the commands that will check it, and the reviewer as the thing to judge against. General spaces get the light version (goal and done when) and no checks or review.

## Checks

Atrium finds a repo's checks from the commit the task started on:

- `package.json` scripts (typecheck, lint, test), run as their text from that commit; `tsc --noEmit` when the project uses TypeScript without a typecheck script; `bun test` for bun projects with test files.
- Commands named in `CLAUDE.md` or `AGENTS.md`.
- `Makefile` targets (typecheck or check, lint, test), run from base copies of the Makefile and the makefiles it includes.
- `pyproject.toml` (mypy, ruff, pytest, through `uv run` or `poetry run` when locked that way), `Cargo.toml` (check, clippy, test) and `go.mod` (vet, test).

A space's own commands (Settings in the space header, one per line, the last being the full test run) replace detection, and a check command you set in the brief replaces the test run. Detection is cached per commit. The writer's prompt lists the commands and says it may run them itself, inside its own sandbox, only exactly as written and one per call (its tools refuse pipes, redirects, `&&` and `;`), and that Atrium runs them either way.

After every writer turn that changed files, the engine runs the checks itself, in a checkout of the branch head of their own that's deleted afterwards. Your dependency folders are linked in read-only. When the change touched the manifest or lockfile, they're private copies instead (APFS clones), and the engine installs the change's lockfile into those before the checks, so nothing installed outlives the run or reaches your checkout. A copy that fails leaves the result unverified rather than installing into half of one. Then fast checks (typecheck, lint), then the full test run; every check runs whatever the others said. Each command has a time limit and its output is capped. A failing turn goes back to the writer with the end of the failing output. The agent's own "tests pass" is never taken as a result.

What the results mean:

- **passed**: at least one real check ran and passed, and none failed or couldn't run. The install never counts as a passing check.
- **failed**: a check failed. Any non-zero exit is a failure, 127 included: whether a tool is installed is asked with `command -v` before anything from the repo runs.
- **unverified** (`none`): no checks were found, or a check couldn't run (the tool is missing, it timed out, or the install it needed didn't happen). Checks that couldn't run also add an attention note. A registry that needs your login makes the install unverified rather than failed, since checks never get your credentials.
- **already failing**: when a check fails, Atrium also runs the checks on the commit the task started from (once per commit, cached; a Stop ends it and caches nothing). A check that failed there too and still fails proves nothing about the change: the result is "Unverified: X was already failing before this task", with an attention note. It's never "passed". It doesn't count as the writer's failure or toward loop detection, and the work can still reach you labelled unverified. The writer's prompt and the reviewer's both list these checks, with the end of their output from before the task, so the writer doesn't wander off to fix them and the reviewer can judge whether the change made them worse. A check that passed there and fails now is a real failure; one that failed there and passes now is simply passed.

The task carries `checks: pending | running | passed | failed | none`, shown as a badge on its row with the output one click away.

## Gate threat model

The writer and the checks share a codebase, so tampering can't be made impossible. The gate is built on this model, and every mechanism above follows from it; nothing goes beyond it.

- **The writer agent is semi-trusted.** It runs sandboxed and may be prompt-injected by what it reads. So may the brief's pre-pass, which is why it can't choose the check command.
- **Check results are evidence, not proof.** Check commands execute repo code the writer can change, and the tests themselves are writer-editable.
- **The gate guarantees:**
  1. **Checks can't reach secrets, Atrium's API or ports, or anything outside their own checkout.** They run under a sandbox profile of their own: the agent profile word for word (no credentials, `.env` files or Keychain; writes only in the check checkout and a private temp folder; none into `node_modules` or `.venv`), then loopback opened for tests that start their own server, with the internet, every port an Atrium engine listens on (the configured one and 7420–7439), SSH and local admin ports shut. Their environment is built from scratch, so no token reaches them. Agents never run under this profile; theirs keeps loopback shut. The install's profile writes only the dependency folders that are real copies inside the checkout and its temp cache, reaches the registry, and keeps loopback shut.
  2. **The command definitions come from the base commit.** Package scripts run as their text from that commit, not `npm run <name>`; a Makefile and every makefile it includes run from base copies. Only package-manager checks get `node_modules/.bin` on `PATH`, and no other checkout path is ever put ahead of the system's.
  3. **Every known route that changes what the checks mean is closed, or produces an attention note.**
     - Agents can't write the dependency folders. Only the engine's install writes them, into private copies, from the lockfile, with lifecycle scripts off, its own sandbox and a minimal environment. Whatever the commit put at a dependency folder's name (a link out of the checkout, say) is removed before the copy or link is made.
     - A change to install-time config (`.npmrc`, `.yarnrc*`, `.yarn/releases`, `.pnpmfile.cjs`, `pnpm-workspace.yaml`, `bunfig.toml`, `pip.conf`, `uv.toml`) is never installed. Its checks are marked "Unverified: this change edits how dependencies install".
     - These each add a note:
       - edits to check config, manifests and lockfiles, CI scripts and scripts a check or its Makefile recipe names, and config a tsconfig, ESLint or Jest JSON config pulls in through a relative `extends` chain;
       - fewer test files than the base;
       - newly skipped tests;
       - checker suppressions added in place (`@ts-nocheck`, `@ts-ignore`, `eslint-disable`, `# type: ignore`, `# noqa` and the like);
       - checks that couldn't run;
       - config the work leaves outside git in your checkout.
     - Classification folds case, as APFS does. Config outside git counts only when it's new or changed since the task started (by content hash, regular files only). A link, an oversized file, or a missing snapshot always counts. git doesn't list FIFOs or devices, so those aren't seen at all; checks never read your checkout, so they can't affect a result.
     - Files committed into a dependency folder add a note: the checks never use them, but the branch would carry them into your repo.
     - A note blocks automatic approval by any rule, is put to the reviewer to scrutinise, and is shown on the result. Checks that couldn't run or were already failing add notes of their own, so the same holds for them.
- **The reviewer and you are the final judges.**

### Known limits of the gate

- **Editing the tests themselves.** A writer can weaken an assertion without dropping a file or adding a skip. The reviewer is told to judge against the brief, and you see the diff.
- **Repo code the checks call.** Tests, source and helpers are the writer's to change; only the command definitions are pinned. A script a Makefile recipe builds at run time, or names through a variable, isn't seen.
- **Commands from `CLAUDE.md`/`AGENTS.md` and space settings** are run as written, so a `make lint` named there runs the checkout's Makefile, not a base copy. Editing those notes is itself flagged.
- **Includes Atrium can't resolve** (a Makefile `include $(VAR).mk`) run from the checkout, and say so in a note.
- **`extends` into a package** (a shared ESLint or tsconfig from `node_modules`) isn't followed. A changed lockfile is flagged instead.
- **Nested dependency folders** in a monorepo (`packages/x/node_modules`) are protected from Claude's file tools everywhere, but from shell commands and Codex only at the repo root. Checks link and copy only the root ones.
- **Rust and Go checks** run under the same profile with their caches pointed at the temp folder; a toolchain that insists on writing to its home folder fails, which shows as a failing check, not a pass.
- **Python dependencies** are linked read-only (`.venv`) but never installed by the engine.
- **Private registries.** The engine's install never gets your login, so when a change touches the lockfile of a repo whose packages need one, its checks are unverified ("the registry needs your login") rather than run.
- **A new failure inside a check that was already failing** isn't caught: in a repo with type debt, one more type error leaves the typecheck failing as before, so the result is unverified, not failed. The reviewer is told which checks were already failing and sees the diff.
- **A flaky check** can fail on the branch after passing on the base commit, and then reads as a real failure. "The same failure twice" compares output with timings, clock times, sizes, colours and temp paths taken out, so a flaky check that fails the same way twice still pauses.

## The reviewer

Once the checks pass (or there are none), a fresh session reviews only the diff and the brief. It knows nothing of the writer's session. The space picks the reviewer:

- **Auto** (the default) uses Codex, then Gemini, when one is installed and allowed in that space, else a fresh Claude session. Private spaces (the default for new spaces) and repos with `.env` files are Claude only.
- Or pin one agent, or turn review off.

The reviewer judges mergeability, not style: unmet acceptance criteria, scope creep, code that doesn't match the patterns around it, missing edge cases, risky changes. Each finding comes back with a severity, `file:line` and a reason. When it asks for changes, the writer gets every finding and must fix it or explain why not against the brief, answering each one. At most two review rounds; then the work comes to you with the findings and how each was resolved. This replaced the earlier "review handoff with one fix round": there is one review mechanism, and separate fix tasks are gone (older ones end on upgrade, and the work they followed waits for you as before).

## Budgets and loop detection

Each task has a token and a time budget, with defaults by size (small 200k tokens and 20 minutes, medium 600k and 45, large 1.5M and 90). A space can set its own in Settings, and a task's can be changed from its detail. Budgets count Atrium's own work since you last stepped in: starting, retrying, a hint or a send-back starts them over.

Tokens are weighted the way the API prices them against fresh input: cache reads count 0.1×, cache writes 1.25×, fresh input and output 1×. Claude Code reads most of its context from the cache, so leaving cache reads out would barely count it. Codex counts cached input inside its input, and Atrium splits it out the same way. When an agent reports no tokens at all, the count is shown as a floor.

Atrium pauses a task with a one-line diagnosis when:

- the time budget runs out, mid-run included;
- another automatic turn would go over the token budget;
- the agent makes the same edit three times in a run, or the same tool call three times in a row (it's stopped mid-run);
- the same check fails the same way twice in a row, three turns pass without a check newly passing, or a turn changes nothing after the checks failed.

A paused task offers two ways on: **Give it a hint**, which carries on from the branch with your note, and **Explain the problem instead**, a read-only run (no edits, no commands; the branch's commits and diff are handed to it) that says what's going wrong rather than trying again.

## Where it lives

- `src/engine/brief.ts`, `brief-draft.ts`: the brief and its pre-pass.
- `src/engine/checks/`: detection (`detect.ts`), the sandboxed runs and what they prove (`run.ts`, `sandbox.ts`), the check checkout, base results and install (`gate.ts`), and the attention notes (`attention.ts`).
- `src/engine/loop.ts`: loop state, budgets and loop detection.
- `src/engine/handoff.ts`: the reviewer's prompt and rounds.
- `src/engine/runner.ts`: the brief stage, the turn, the gate and the hand-offs between stages.
