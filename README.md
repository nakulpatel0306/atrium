# Atrium

A calm command center for your AI agents, on your Mac.

You tell Atrium what you want in plain words. It hands the work to an AI agent,
shows you what came back, and waits for your yes before anything counts. It
covers code, life admin, texts, investing and money, all in one place.

![Atrium's home screen](docs/screenshots/home.png)

## What you can do with it

Type any of these into the bar at the bottom of the screen.

**Everyday life**
- "Plan my groceries for the week, under $80, high protein"
- "Make a packing list for four days in Montreal in December"
- "Here's my week, what should I focus on?"

**Texts**
- "Text mom happy birthday"
- "Text Alex I'm running 10 minutes late"

Atrium writes the text and finds the number in your Contacts. It then shows
you exactly who it's going to and what it says. Nothing is sent until you
press **Send**.

**Work, school and side projects**
- "Keep my job search organized" sets up a space with starter tasks
- "Turn my notes into a study guide"
- "Draft a follow-up email to the recruiter" gives you a draft to copy.
  Atrium doesn't send email yet.

**Code**
- "Fix the mobile menu overlap in my portfolio site"
- "Start a new project called habit-tracker". Atrium asks before it creates
  the GitHub repo.
- "Review my last changes for bugs"

Agents work on their own branch, never on your checkout. You review the
changes before anything is kept.

**Investing**

![Portfolio](docs/screenshots/portfolio.png)

- See your portfolio in Canadian dollars with today's change. US stocks are
  live, and TSX stocks update during market hours.
- Open any stock or ETF for its chart, company info, earnings date and news.
- Keep watchlists, see who reports earnings soon, and set alerts like "tell
  me if TSLA drops below $340".
- Ask "Why is RKLB up today?" or "How much of my portfolio is tech?" Claude
  answers using your real holdings. It's analysis, not advice.

**Money**

![Money](docs/screenshots/money.png)

- Import a bank or card CSV and see spending by category, recurring charges,
  and anything unusual.
- Ask "What did I spend most on last month?" or "What subscriptions am I
  paying for?"

## How it works

- **Spaces** are areas of your life or work: a repo, school, investing, a
  trip. Describe one in a sentence and Atrium sets it up.
- **Tasks** are the jobs inside a space. Each one goes to an agent: Claude
  (on your Claude subscription), or Codex and Gemini for some code work.
- **Needs you** is your inbox. Finished work, texts ready to send and
  questions all wait here for you. If an agent couldn't do something, it
  says so instead of pretending it's done.
- **Activity** is a short, day-by-day history of what happened. Click a line
  for the full detail.
- **What it made:** every task shows the files it produced. They also live in
  a normal folder, `~/Atrium/<space>`, so you can open them in Finder.

You can use Atrium three ways: the **Mac app**, the **terminal app** (type
`atrium`), or in **your browser** (`atrium open`).

## Privacy and safety

- Everything runs on your Mac. Your data stays in
  `~/Library/Application Support/Atrium` and `~/Atrium`.
- Agents run in a sandbox. They can't read your passwords, keys or `.env`
  files. They can't control your other apps, and they can't change
  Atrium's own settings.
- Only Atrium sends texts or creates repos, and only after you approve.
- Private spaces, like Investing and Money, only ever use Claude.
- Market data services only see ticker symbols, never how much you own.
  Claude sees card numbers as the last four digits only.
- It's light on your Mac. It sleeps when idle, saves heavy work for when
  you're plugged in, and keeps its storage small.

## Tidying up

- **Archive** a space to hide it. You can undo this for a few seconds, and
  restore it any time from **Settings → Archived spaces**.
- **Delete** a space or a task for good. You type the space's name to
  confirm. Its folder goes to the Trash, and your real code repos and GitHub
  are never touched.

## Setting it up

You need a Mac, [bun](https://bun.sh), and the Claude Code CLI signed in to
your Claude account.

```sh
bun install
bun link             # puts `atrium` on your PATH
atrium install       # starts Atrium now and at every login
atrium app install   # adds Atrium.app to ~/Applications
```

For investing, add free keys in **Settings → Market data**:
- **Finnhub** is needed for US prices, earnings and search.
- **Alpha Vantage** is optional and gives official TSX closing prices.

Then import your Wealthsimple holdings report from **Investing → Portfolio**.

Other commands: `atrium status`, `atrium open`, `atrium uninstall`.

## For developers

```sh
bun test ./tests/engine   # run the suite in groups: engine, server, dashboard,
bun test ./tests/server   # e2e, tui, mac, copy, cli.test.ts, main.test.ts
bunx tsc --noEmit
ATRIUM_DEV=1 bun src/main.ts
```

See [`docs/`](docs/README.md) for the design and the build history.
