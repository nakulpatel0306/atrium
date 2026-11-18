// The clickable demo on the landing page: a self-contained copy of the Mac app, with sample data and no network.
// It announces what happens in it as "atrium:demo" events, which the page's Plum reacts to.
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const app = (() => {
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const I = {
      home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      tray: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
      activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
      bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
      shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
      plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
      chev: '<path d="m9 18 6-6-6-6"/>',
      lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
      ready: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
      run: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
      queued: '<circle cx="12" cy="12" r="10" stroke-dasharray="3 3.3"/>',
      done: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
      file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
      branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    };
    const ic = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`;
    // Space colours are the site's tokens, so the demo follows the theme like the real dashboard.
    const C = { blue: "var(--blue)", pink: "var(--pink)", green: "var(--green)", yellow: "var(--yellow)", aqua: "var(--teal)", accent: "var(--accent)" };
    const AG = { claude: ["C", "Claude"], codex: ["X", "Codex"], gemini: ["G", "Gemini"], auto: ["A", "Atrium"] };
    const av = (a, live) => `<span class="av ${a}${live ? " live" : ""}" title="${AG[a][1]}">${AG[a][0]}</span>`;
    const hash = (s) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
    const today = new Date();
    const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
    // Task ids look like the real ones, because each task's branch is named after its id.
    const tid = () => `tsk_${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
    // A diff is [file, added, removed, log line it appears at]; the last one drives the live diff.
    const filesLine = (diff) => diff.map(([f, a, d]) => `${esc(f)} <span class="add">+${a}</span>${d ? ` <span class="del">−${d}</span>` : ""}`).join(" · ");

    // Sample spaces. Every task's output is written the way the real agents write theirs.
    const spaces = [
      { id: "api", name: "lumen-api", kind: "repo", path: "~/Developer/lumen-api", color: C.blue, private: false, last: "1m ago", goal: "The API for Lumen, a made-up photo app. Small fixes, one branch per task.", agents: ["claude", "codex"], tasks: [
        { id: "tsk_7f3a", title: "Fix the off-by-one in pagination", peek: "The last page dropped a row. Fixed, with a test.", agent: "claude", review: "codex", status: "ready", outcome: "done", when: "9:12 AM", branch: "atrium/tsk_7f3a",
          diff: [["src/paginate.ts", 4, 2], ["tests/paginate.test.ts", 19, 0]], made: (t) => `
          <p>When the total was a multiple of the page size, the last page came back one row short. <code>paginate</code> used <code>&lt;</code> where it needed <code>&lt;=</code>.</p>
          <ul><li>Fixed the bound and added a test for an exact multiple.</li><li>Ran <code>bun test tests/paginate.test.ts</code>: 9 of 9 pass.</li></ul>
          <p class="m-mono">${filesLine(t.diff)}</p>` },
        { id: "tsk_5d10p", title: "Push atrium/tsk_5d10 and open a pull request?", peek: "Return 404 for unknown project ids", agent: "claude", status: "ready", when: "8:40 AM",
          push: { kind: "pr", branch: "atrium/tsk_5d10", diff: [["src/routes/projects.ts", 11, 3], ["tests/projects.test.ts", 24, 0]] } },
        { id: "tsk_81c2", title: "Add rate limiting to /v1/search", agent: "claude", review: "codex", status: "run", outcome: "done", when: "Running", branch: "atrium/tsk_81c2", finishIn: 26000,
          log: ["brief: 30 requests a minute per key; done when a test covers the 429", "reading src/routes/search.ts", "no limiter yet, requests go straight to the index", "editing src/middleware/rate-limit.ts", "  token bucket, 30 requests a minute per key", "editing src/routes/search.ts", "committed to atrium/tsk_81c2", "Atrium ran the checks: typecheck ✓ tests ✓ (14 of 14)", "Codex reviewed the diff against the brief: approve"],
          diff: [["src/middleware/rate-limit.ts", 38, 0, 4], ["src/routes/search.ts", 6, 1, 6], ["tests/search.test.ts", 22, 0, 6]], made: (t) => `
          <p>Added a token-bucket limiter, 30 requests a minute per API key, and put it in front of <code>/v1/search</code>. Over the limit, it returns 429 with a <code>Retry-After</code> header.</p>
          <p class="m-mono">${filesLine(t.diff)}</p>` },
        { id: "tsk_9b04", title: "Switch logging to the structured logger", agent: "claude", status: "queued", when: "Queued" },
        { id: "tsk_3e77", title: "Bump dependencies", agent: "codex", status: "done", outcome: "done", when: "Yesterday", branch: "atrium/tsk_3e77", made: () => `<p>Updated 6 packages. Tests pass. Pull request #41 opened after your yes.</p>` },
      ] },
      { id: "web", name: "lumen-web", kind: "repo", path: "example/lumen-web", color: C.green, private: false, last: "8m ago", goal: "Lumen's web app, cloned from GitHub. Fix what users notice first.", agents: ["claude", "codex", "gemini"], tasks: [
        { id: "tsk_c418", title: "Stop the dark mode flash on first load", peek: "Fixed in Chrome and Safari. Firefox still flashes.", agent: "claude", review: "gemini", status: "ready", outcome: "partial", when: "7:55 AM", branch: "atrium/tsk_c418",
          diff: [["index.html", 9, 0], ["src/theme.ts", 3, 12]], made: (t) => `
          <p>Moved the theme check into a small inline script in <code>index.html</code>, so the page knows the theme before it paints.</p>
          <ul><li>Fixed in Chrome and Safari.</li><li>Firefox still flashes once. I couldn't find why, so this is partial.</li></ul>
          <p class="m-mono">${filesLine(t.diff)}</p>` },
        { id: "tsk_aa21", title: "Review feature/upload-queue", agent: "codex", status: "done", outcome: "done", when: "Yesterday", made: () => `
          <p>Read the branch diff against main. One thing to fix before merging:</p>
          <ul><li>A failed upload is retried forever. Cap the retries and show the error.</li><li>Smaller: <code>q</code> and <code>qq</code> could use clearer names.</li></ul>` },
        { id: "tsk_e902", title: "Add an empty state to the gallery", agent: "claude", status: "queued", when: "Queued" },
      ] },
      { id: "notes", name: "Notes", kind: "general", color: C.yellow, private: true, last: "1h ago", goal: "Release notes, design docs and the other writing around Lumen.", agents: ["claude"], files: ["v0.8-release-notes.md", "auth-redesign.md"], tasks: [
        { id: "tsk_61f0", title: "Draft the v0.9 release notes", peek: "From the merge list you attached.", agent: "claude", status: "ready", outcome: "done", when: "8:05 AM", made: () => `
          <p>Grouped the <b>12 merges</b> in the list you attached into Fixes, API changes and Internal.</p>
          <ul><li>Called out the new 429 on <code>/v1/search</code> under API changes.</li><li>Left out two dependency bumps.</li></ul>
          <p>Saved as <code>v0.9-release-notes.md</code>.</p>` },
        { id: "tsk_2b9c", title: "Summarize the auth redesign thread", agent: "claude", status: "done", outcome: "done", when: "Monday", made: () => `<p>Three options and one recommendation: short-lived tokens with refresh. Saved as <code>auth-redesign.md</code>.</p>` },
      ] },
    ];

    const rules = [
      { id: "branch", name: "Code changes stay on their own branch", note: "Built in. Each task gets atrium/<taskId>. Your checkout is never touched.", on: true, locked: true },
      { id: "ask", name: "Pushes always ask", note: "Built in. So do merging to main, deploys, deletes, spending, secrets, new repos and removing a clone.", on: true, locked: true },
      { id: "priv", name: "Private spaces only use Claude", note: "Built in. Codex and Gemini never see them.", on: true, locked: true },
      { id: "deps", name: "Approve dependency bumps in lumen-api", note: "You approved the last 4 without changes. Pushing still asks.", on: false },
      { id: "battery", name: "Heavy work waits when on battery", note: "Long runs start when you plug in.", on: true },
      { id: "night", name: "Run queued work overnight", note: "Keeps the Mac awake while plugged in and work is queued.", on: false },
    ];
    let activity = [
      { when: "9:12 AM", sp: "api", who: "Claude", text: "Fix the off-by-one in pagination · ran, waiting for review", dot: "y" },
      { when: "8:40 AM", sp: "api", who: "You", text: "Return 404 for unknown project ids · approved", dot: "" },
      { when: "8:05 AM", sp: "notes", who: "Claude", text: "Draft the v0.9 release notes · ran, waiting for review", dot: "y" },
      { when: "7:55 AM", sp: "web", who: "Gemini", text: "Stop the dark mode flash on first load · partial, waiting for review", dot: "y" },
      { when: "Yesterday", sp: "api", who: "Atrium", text: "Pushed atrium/tsk_3e77 and opened pull request #41", dot: "" },
      { when: "Yesterday", sp: "web", who: "Codex", text: "Review feature/upload-queue · approved", dot: "" },
    ];

    const S = { view: "home", open: null, stab: "tasks", tokens: 18.2, pr: 42 };
    const space = (id) => spaces.find((s) => s.id === id);
    const all = () => spaces.flatMap((s) => s.tasks.map((t) => ({ s, t })));
    const ready = () => all().filter(({ t }) => t.status === "ready");
    const running = () => all().filter(({ t }) => t.status === "run");
    const findTask = (id) => all().find(({ t }) => t.id === id);
    let toastTimer;
    function toast(text) {
      const el = $("m-toast");
      el.textContent = text;
      el.classList.add("on");
      dispatchEvent(new CustomEvent("atrium:demo", { detail: text }));
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove("on"), 2800);
    }
    function log(sp, who, text, dot = "") {
      activity.unshift({ when: "Just now", sp, who, text, dot, fresh: true });
      activity = activity.slice(0, 14);
    }

    const ST = { ready: ["ready", "Ready for review", "ready"], run: ["run", "Running", "run"], queued: ["queued", "Queued", ""], done: ["done", "Done", ""] };
    const st = (status) => `<span class="st ${ST[status][0]}" title="${ST[status][1]}">${ic(status)}</span>`;

    // Sidebar and top bar
    function side() {
      const nav = [["home", "home", "Home"], ["needs", "tray", "Needs you", ready().length, true], ["activity", "activity", "Activity"], ["agents", "bot", "Agents", running().length], ["rules", "shield", "Rules"]];
      $("m-nav").innerHTML = nav.map(([id, icon, label, n, hot]) => `<button class="m-nav${S.view === id ? " on" : ""}${id === "agents" || id === "rules" ? " hide-sm" : ""}" type="button" data-go="${id}">${ic(icon)}<span class="label">${label}</span><span class="ct${hot && n ? " hot" : ""}">${n || ""}</span></button>`).join("");
      $("m-spaces").innerHTML = spaces.map((s) => {
        const n = s.tasks.filter((t) => t.status === "ready").length;
        return `<button class="m-nav${S.view === s.id ? " on" : ""}${s.fresh ? " fresh" : ""}" type="button" data-go="${s.id}"><span class="m-sd" style="background:${s.color}"></span><span class="label">${esc(s.name)}</span><span class="ct">${n || ""}</span></button>`;
      }).join("");
      spaces.forEach((s) => (s.fresh = false));
      $("m-tokens").textContent = `${S.tokens.toFixed(1)}k tokens`;
    }
    function top() {
      const s = space(S.view);
      const titles = { home: "Home", needs: "Needs you", activity: "Activity", agents: "Agents", rules: "Rules" };
      const crumbs = s
        ? `<button class="crumb" type="button" data-go="home">Home</button><span class="sep">${ic("chev")}</span><b>${esc(s.name)}</b>`
        : `<b>${titles[S.view]}</b>${S.view === "home" ? ` <span>· ${today.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</span>` : ""}`;
      $("m-top").innerHTML = `${crumbs}<span class="k">⌘K</span>`;
      $("m-ask").placeholder = s ? `Give ${s.name} a task…` : `Describe something new, like “start a new project called pocket-cli”`;
    }

    // The yes and no for anything waiting on you. Pushes and new repos are always-ask: only Atrium does them, after this yes.
    function decide(t) {
      if (t.push) return `<button class="m-btn" type="button" data-act="nopush" data-t="${t.id}">Not now</button><button class="m-btn p" type="button" data-act="push" data-t="${t.id}">${t.push.kind === "repo" ? "Create repo" : "Push and open PR"}</button>`;
      return `<button class="m-btn" type="button" data-act="back" data-t="${t.id}">Send back</button><button class="m-btn p" type="button" data-act="approve" data-t="${t.id}">${t.outcome === "done" || !t.outcome ? "Approve" : "Accept"}</button>`;
    }
    // Rows shared by Home and Needs you
    function needRow({ s, t }) {
      const acts = `${t.push ? "" : `<button class="m-btn" type="button" data-open="${s.id}:${t.id}">View</button>`}${decide(t)}`;
      return `<div class="m-item click need" data-open="${s.id}:${t.id}"><span class="who"><span class="m-sd" style="background:${s.color}"></span><span>${esc(s.name)}</span></span><span class="t">${esc(t.title)}${!verdict(t) && t.peek ? `<span>${esc(t.peek)}</span>` : ""}</span>${verdict(t) ? `<span class="m-chips">${verdict(t)}</span>` : ""}<span class="acts">${acts}</span></div>`;
    }
    function needsList() {
      const r = ready();
      return r.length ? `<div class="m-list">${r.map(needRow).join("")}</div>` : `<div class="m-list"><div class="m-empty">Nothing needs you. Finished work will show up here.</div></div>`;
    }
    function activityList(n) {
      const rows = activity.slice(0, n);
      const today_ = rows.filter((a) => a.when !== "Yesterday"), yest = rows.filter((a) => a.when === "Yesterday");
      const row = (a) => `<div class="m-item click${a.fresh ? " newrow" : ""}" data-go="${a.sp}"><span class="when">${a.when}</span><span class="dot ${a.dot}"></span><span class="t">${esc(space(a.sp)?.name ?? "")} · ${esc(a.who)} · ${esc(a.text)}</span></div>`;
      activity.forEach((a) => (a.fresh = false));
      return `<div class="m-list m-act">${today_.length ? `<div class="day">Today</div>${today_.map(row).join("")}` : ""}${yest.length ? `<div class="day">Yesterday</div>${yest.map(row).join("")}` : ""}</div>`;
    }

    function home() {
      const r = ready().length, run = running().length;
      const h = new Date().getHours();
      const greet = h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
      const cards = spaces.map((s) => {
        const n = s.tasks.filter((t) => t.status === "ready").length;
        const live = s.tasks.find((t) => t.status === "run");
        const line = n ? `${n} ready for your review` : live ? `Running · ${live.title}` : `Idle · last activity ${s.last}`;
        const shown = s.tasks.filter((t) => t.status !== "done").slice(0, 2);
        const tags = `${s.private ? `<span class="m-tag">Private</span>` : ""}<span class="m-tag">${s.kind}</span>`;
        const avs = [...new Set(s.tasks.filter((t) => t.status !== "done").map((t) => t.agent).concat(s.agents))].slice(0, 3);
        return `<button class="m-space" type="button" data-go="${s.id}"><span class="n"><span class="m-sd" style="background:${s.color}"></span><span class="name">${esc(s.name)}</span><span class="tags">${tags}</span></span><span class="s">${esc(line)}</span>${shown.length ? `<span class="tl">${shown.map((t) => `<span class="li">${st(t.status)}<span>${esc(t.title)}</span></span>`).join("")}</span>` : ""}<span class="m-avs">${avs.map((a) => av(a, s.tasks.some((t) => t.status === "run" && t.agent === a))).join("")}</span></button>`;
      }).join("");
      return `
        <h1>${greet}</h1>
        <p class="m-brief">${run ? `${run} running now.` : "Nothing is running."} ${r ? `${r} thing${r > 1 ? "s" : ""} need${r > 1 ? "" : "s"} you.` : "Nothing needs you."}</p>
        <h2>${ic("tray")}Needs you · ${r}</h2>${needsList()}
        <h2>Spaces</h2>
        <div class="m-grid">${cards}<button class="m-new" type="button" data-new><b>${ic("plus")}New space</b><span>Describe it in a sentence and Atrium sets it up.</span></button></div>
        <h2>Activity</h2>${activityList(6)}`;
    }

    function agentsView() {
      const rows = [["claude", "Ready", "Your Claude subscription, inside Claude Code's sandbox"], ["codex", "Ready", "Code tasks, inside Atrium's sandbox-exec profile"], ["gemini", "Ready", "Code tasks, inside Atrium's sandbox-exec profile"]].map(([a, state, note]) => {
        const r = running().filter(({ t }) => t.agent === a);
        return `<div class="m-item">${av(a, r.length)}<span class="t">${AG[a][1]}<span>${r.length ? `Working on “${esc(r[0].t.title)}”` : note}</span></span><span class="m-tag${r.length ? " run" : ""}">${r.length ? "Running" : state}</span></div>`;
      }).join("");
      return `<h1>Agents</h1><p class="m-brief">Atrium routes each task to one of these. None of them can read your keys or .env files, reach Atrium's API, or drive your other apps.</p><h2>On this Mac</h2><div class="m-list">${rows}</div>`;
    }
    function rulesView() {
      return `<h1>Rules</h1><p class="m-brief">What agents may do without asking. The built-in ones can't be turned off, and no rule can approve an always-ask action.</p><h2>Rules</h2><div class="m-list">${rules.map((r) => `
        <div class="m-item"><span class="t">${esc(r.name)}<span>${esc(r.note)}</span></span>${r.locked ? `<span class="m-tag">Built in</span>` : `<button class="m-toggle" type="button" role="switch" aria-checked="${r.on}" data-rule="${r.id}" aria-label="${esc(r.name)}"><span class="m-switch"></span></button>`}</div>`).join("")}</div>`;
    }

    // Space view
    function head(s) {
      const tags = `<span class="m-tag">${s.kind}</span>${s.path ? `<span class="m-tag mono">${esc(s.path)}</span>` : ""}`;
      const hint = s.private ? `<span class="hint">Only Claude works in this space.</span>` : "";
      return `<div class="m-title"><span class="m-sd" style="background:${s.color}"></span><h1>${esc(s.name)}</h1>${tags}
        <div class="m-head-acts"><button class="m-toggle" type="button" role="switch" aria-checked="${!!s.private}" data-priv="${s.id}"><span class="m-switch"></span>${ic("lock")}Private</button>${hint}<button class="m-btn" type="button" data-toast="Archived spaces keep their files. (Not in the demo.)">Archive</button></div></div>
        <p class="m-brief">${esc(s.goal)}</p>`;
    }
    function made(s, t) {
      if (t.push && t.status === "ready") {
        const p = t.push;
        const what = p.kind === "repo"
          ? `<p>Creates a GitHub repo named <b>${esc(p.name)}</b> and pushes the first commit.</p>`
          : `<p>Pushes <code>${esc(p.branch)}</code> to GitHub and opens a pull request against <b>main</b>.</p><p class="m-mono">${filesLine(p.diff)}</p>`;
        return `<div class="m-made"><span class="lbl">What leaves your Mac</span>${what}<p class="m-small">Atrium does this itself, never the agent. No rule can approve it for you.</p></div>`;
      }
      if (t.status === "run") return `<div class="m-made"><span class="lbl">Working</span><p>${AG[t.agent][1]} is on it. You can close this and do other things.</p></div>`;
      if (t.status === "queued") return `<div class="m-made"><span class="lbl">Queued</span><p>It starts when ${AG[t.agent][1]} is free, or now if you want.</p></div>`;
      if (!t.made) return `<div class="m-made"><p>${t.skipped ? "Not now. Nothing left your Mac." : "Finished and kept."}</p></div>`;
      return `<div class="m-made"><span class="lbl">What it made${t.revised ? " · revised after your note" : ""}</span>${t.made(t)}</div>`;
    }
    // Where a coding task is in the loop, from its log: the brief, writing, Atrium's checks, the review, then you.
    const STAGES = ["Brief", "Writing", "Checks", "Reviewer", "Ready"];
    function stageOf(t) {
      if (t.status === "ready" || t.status === "done") return 4;
      const lines = (t.log || []).slice(0, t.shown || 1).join("\n");
      return /reviewed/.test(lines) ? 3 : /ran the checks/.test(lines) ? 3 : /committed/.test(lines) ? 2 : /editing|reading/.test(lines) ? 1 : 0;
    }
    function loopStrip(t) {
      const at = stageOf(t);
      return `<ol class="m-stages" aria-label="Where this task is">${STAGES.map((n, i) => `<li class="${i < at ? "past" : i === at ? "on" : ""}">${n}</li>`).join("")}</ol>`;
    }
    // What the checks said and what the reviewer said, as the app's two chips.
    const verdict = (t) => (t.review ? `<span class="m-tag run">Checks passed</span> <span class="m-tag run">Approved by ${AG[t.review][1]}</span>` : "");
    function entry(s, t) {
      const open = S.open === t.id;
      let acts = "";
      if (t.status === "ready") acts = decide(t);
      if (t.status === "queued") acts = `<button class="m-btn" type="button" data-act="start" data-t="${t.id}">Start now</button>`;
      const tag = t.status === "ready" ? (t.push ? `<span class="m-tag warn">Always asks</span>` : "") : t.status === "run" ? `<span class="m-tag run">Running</span>` : `<span class="m-tag">${t.when}</span>`;
      const said = t.outcome && t.status !== "run" && t.status !== "queued" ? `<span class="m-tag ${t.outcome === "done" ? "run" : "warn"}">Agent says: ${t.outcome}</span>` : "";
      return `<div class="m-entry${t.status === "done" ? " done" : ""}"><div class="m-item click${t.push && t.status === "ready" ? " tall" : ""}" data-row="${t.id}" aria-expanded="${open}">${st(t.status)}<span class="t">${esc(t.title)}</span>${tag}<span class="acts">${acts}</span></div>
        ${open ? `<div class="m-detail">${t.branch && !t.push ? loopStrip(t) : ""}<div class="m-meta">${av(t.agent)}<span>${AG[t.agent][1]}</span><span>${esc(t.when)}</span>${t.branch ? `<span class="m-mono">Branch ${esc(t.branch)}</span>` : ""}${said}</div>${t.status === "ready" && verdict(t) ? `<p class="m-verdict m-chips">${verdict(t)}</p>` : ""}${made(s, t)}</div>` : ""}</div>`;
    }
    function livePanel(s) {
      const r = s.tasks.find((t) => t.status === "run");
      if (!r) return `<div class="m-live"><div class="hd">Live<span class="s">Idle</span></div><p class="m-idle">No agent is working in ${esc(s.name)} right now. Give it a task in the bar below.</p></div>`;
      return `<div class="m-live"><div class="hd">${av(r.agent, true)}${AG[r.agent][1]}<span class="s">${esc(r.branch ?? r.title)}</span></div><pre class="m-term" id="m-term">${termText(r)}</pre>${r.diff ? `<div class="m-diff" id="m-diff">${diffText(r)}</div>` : ""}
        <form class="m-steer" data-steer="${r.id}"><input id="m-steer" type="text" placeholder="Steer ${AG[r.agent][1]} with a note" aria-label="Steer the running task"><button class="m-btn" type="submit">Send</button></form></div>`;
    }
    const IDLE_LOG = ["reading the space's files", "thinking it through", "writing it up"];
    function termText(t) {
      const lines = (t.log || IDLE_LOG).slice(0, t.shown || 1);
      return lines.map((l) => (l.startsWith("$") ? `<span class="c">${esc(l)}</span>` : l.startsWith("you →") ? `<span class="you">${esc(l)}</span>` : l.includes("✓") || l.startsWith("committed") ? `<span class="ok">${esc(l)}</span>` : esc(l))).join("\n");
    }
    // The live diff grows as the agent's output reaches each file.
    function diffText(t) {
      const files = t.diff.filter(([, , , at = 0]) => at < (t.shown || 1));
      return `<span class="lbl">Live diff</span>${files.length ? `<span>${filesLine(files)}</span>` : "<span>No changes yet.</span>"}`;
    }
    function spaceView(s) {
      const kinds = s.kind === "repo" ? ["tasks", "branches"] : ["tasks", "files"];
      const tabs = `<div class="m-tabs" role="tablist">${kinds.map((k) => `<button type="button" role="tab" aria-selected="${S.stab === k}" class="${S.stab === k ? "on" : ""}" data-stab="${k}">${sentence(k)}</button>`).join("")}</div>`;
      const branches = s.tasks.filter((t) => t.branch);
      const list = S.stab === "tasks"
        ? `<div class="m-list">${s.tasks.length ? s.tasks.map((t) => entry(s, t)).join("") : `<div class="m-empty">No tasks yet. Give ${esc(s.name)} one in the bar below.</div>`}</div>`
        : S.stab === "branches"
          ? `<div class="m-list m-files">${branches.length ? branches.map((t) => `<div class="m-item">${ic("branch")}<span class="t"><span class="m-mono" style="color:var(--m-text);margin:0">${esc(t.branch)}</span><span>${esc(t.title)}</span></span></div>`).join("") : `<div class="m-empty">No branches yet. Each task gets its own atrium/ branch.</div>`}</div>`
          : `<div class="m-list m-files">${s.files.length ? s.files.map((f) => `<div class="m-item">${ic("file")}<span class="t m-mono">${esc(f)}</span><span class="sz">~/Atrium/${slug(s.name)}</span></div>`).join("") : `<div class="m-empty">Nothing saved yet. Approved work lands here.</div>`}</div>`;
      return `${head(s)}${tabs}<div class="m-cols"><div>${list}</div>${livePanel(s)}</div>`;
    }

    function view() {
      const s = space(S.view);
      if (!s) return { home, needs: () => `<h1>Needs you</h1><p class="m-brief">Finished work waits here until you decide. Nothing is kept or pushed without a yes.</p><h2>${ic("tray")}Needs you · ${ready().length}</h2>${needsList()}`, activity: () => `<h1>Activity</h1><p class="m-brief">Everything that ran, and what you decided.</p><h2>Recent</h2>${activityList(14)}`, agents: agentsView, rules: rulesView }[S.view]();
      return spaceView(s);
    }
    function render(keep) {
      const scroller = $("m-scroll"), y = scroller.scrollTop;
      const focus = document.activeElement?.closest?.("#m-view") ? { id: document.activeElement.id, a: document.activeElement.selectionStart, b: document.activeElement.selectionEnd } : null;
      side(); top();
      const v = $("m-view");
      v.innerHTML = view();
      if (keep) { v.style.animation = "none"; scroller.scrollTop = y; }
      else { v.style.animation = "none"; void v.offsetWidth; v.style.animation = ""; scroller.scrollTop = 0; }
      if (focus?.id && $(focus.id)) { const f = $(focus.id); f.focus(); try { f.setSelectionRange(focus.a, focus.b); } catch {} }
    }
    function go(id, task) {
      S.view = id; S.stab = "tasks";
      const s = space(id);
      S.open = task ?? (s ? (s.tasks.find((t) => t.status === "ready") || s.tasks.find((t) => t.status === "run"))?.id ?? null : null);
      render(false);
    }

    function finish(t, ms) {
      setTimeout(() => {
        if (t.status !== "run") return;
        t.status = "ready"; t.when = "Just now"; t.shown = 99; t.outcome = t.outcome || "done";
        const s = spaces.find((x) => x.tasks.includes(t));
        S.tokens += 1.1 + (hash(t.id) % 10) / 10;
        log(s.id, AG[t.agent][1], `${t.title} · ran, waiting for review`, "y");
        render(true);
        toast(`Ready for review: ${t.title}`);
      }, ms);
    }
    // Live output and diff for anything running in the open space.
    setInterval(() => {
      running().forEach(({ t }) => { const max = (t.log || IDLE_LOG).length; if ((t.shown || 1) < max) t.shown = (t.shown || 1) + 1; });
      const s = space(S.view), r = s?.tasks.find((t) => t.status === "run");
      if (!r) return;
      if ($("m-term")) $("m-term").innerHTML = termText(r);
      if ($("m-diff")) $("m-diff").innerHTML = diffText(r);
    }, 900);

    function act(kind, t) {
      const { s } = findTask(t) || {};
      const task = s?.tasks.find((x) => x.id === t);
      if (!task) return;
      if (kind === "approve") {
        task.status = "done";
        log(s.id, "You", `${task.title} · approved`);
        if (s.kind === "repo" && task.branch) {
          s.tasks.unshift({ id: `${task.id}p`, title: `Push ${task.branch} and open a pull request?`, peek: task.title, agent: task.agent, status: "ready", when: "Just now", push: { kind: "pr", branch: task.branch, diff: task.diff ?? [] } });
          toast(`Kept on ${task.branch}. Pushing it still asks you.`);
        } else {
          s.files.unshift(`${slug(task.title)}.md`);
          toast(`Kept. Saved to ~/Atrium/${slug(s.name)}`);
        }
      }
      if (kind === "back") {
        task.status = "run"; task.revised = true; task.when = "Running"; task.shown = 1;
        log(s.id, "You", `${task.title} · sent back with a note`);
        toast(`Sent back to ${AG[task.agent][1]} with your note`);
        finish(task, 4500);
      }
      if (kind === "push") {
        const p = task.push, n = S.pr++;
        task.status = "done"; task.when = "Just now";
        if (p.kind === "repo") {
          task.title = `Created the GitHub repo ${p.name}`;
          task.made = () => `<p>Created <b>${esc(p.name)}</b> on GitHub and pushed the first commit.</p>`;
          log(s.id, "Atrium", `Created the GitHub repo ${p.name}`);
          toast(`Pushed the first commit to the new repo ${p.name}`);
        } else {
          task.title = `Pushed ${p.branch} · pull request #${n}`;
          task.made = () => `<p>Pushed <code>${esc(p.branch)}</code> and opened pull request <b>#${n}</b> against main.</p>`;
          log(s.id, "Atrium", `Pushed ${p.branch} and opened pull request #${n}`);
          toast(`Pushed ${p.branch}. Pull request #${n} is open.`);
        }
      }
      if (kind === "nopush") { task.status = "done"; task.skipped = true; log(s.id, "You", `${task.title} · not now`); toast("Not pushed. Nothing left your Mac."); }
      if (kind === "start") {
        task.status = "run"; task.when = "Running"; task.shown = 1;
        if (s.kind === "repo") task.branch = `atrium/${task.id}`;
        task.made = task.made || (() => `<p>Here's a first pass at <b>${esc(task.title.toLowerCase())}</b>, ready for you to look over.</p>`);
        toast(`${AG[task.agent][1]} started “${task.title}”`);
        finish(task, 5000);
      }
      render(true);
    }

    // A plain-words ask becomes a new space with starter tasks, the way the real setup agent does it.
    const TEMPLATES = {
      project: { test: /new project|start (?:a )?project|new repo|scaffold/i, kind: "repo", color: C.pink, example: "Start a new project called pocket-cli", name: (t) => slug(t.match(/called ([\w-]+)/i)?.[1] ?? "new-project"), tasks: (n) => [
        ["Scaffold the project", (t) => `<p>Set up <b>${esc(n)}</b> with bun and TypeScript: a CLI entry point, one test and a README.</p><p class="m-mono">${filesLine(t.diff)}</p>`, { diff: [["package.json", 14, 0], ["src/cli.ts", 32, 0], ["tests/cli.test.ts", 18, 0], ["README.md", 21, 0]] }],
        [`Create the GitHub repo ${n}?`, null, { push: { kind: "repo", name: n } }],
        ["Add a CI workflow", null]] },
      docs: { test: /notes|docs?\b|release|changelog|write.?up|readme/i, kind: "general", color: C.yellow, example: "Keep the docs for my CLI up to date", name: () => "Docs", tasks: () => [
        ["Draft a README from the code", () => `<p>A first README: what it does, how to install it, three examples and every flag. Saved as <code>readme-draft.md</code> in this space.</p>`],
        ["Write up the config options", null], ["Turn this week's merges into a changelog", null]] },
      learn: { test: /learn|study|understand|get better at|course/i, kind: "general", color: C.aqua, example: "Help me learn Rust by porting a small tool", name: (t) => sentence(core(t)), tasks: () => [
        ["Make a four-week plan", () => `<ul><li><b>Week 1</b> · Ownership and borrowing, with small exercises</li><li><b>Week 2</b> · Port the argument parsing</li><li><b>Week 3</b> · Errors and tests</li><li><b>Week 4</b> · Finish the port and compare the two</li></ul><p>Notes and exercises go in this space's folder.</p>`],
        ["Pick a first exercise", null], ["Explain the borrow checker with my own code", null]] },
    };
    function core(text) {
      const c = text.replace(/^(please |can you |could you |help me (to )?|i want to |i'd like to |set up (a )?space (to|for) |keep |plan |start |track )/i, "");
      const words = c.split(/\s+/).filter((w) => !/^(my|a|an|the|for|to|in|of|me|organized|on|better|more|please|going|by)$/i.test(w)).slice(0, 3);
      return words.join(" ") || "New space";
    }
    function newSpace(text, key) {
      const tpl = key ? TEMPLATES[key] : Object.values(TEMPLATES).find((x) => x.test.test(text));
      const clean = (key ? tpl.example : text).trim().replace(/[.?!]+$/, "");
      if (!clean) return;
      const name = (tpl ? tpl.name(clean) : sentence(core(clean))).slice(0, 28);
      const existing = spaces.find((s) => s.name === name);
      if (existing) return go(existing.id);
      const id = `n${spaces.length}${Date.now() % 1000}`, kind = tpl?.kind ?? "general";
      const starter = tpl ? tpl.tasks(name) : [["Draft a plan to start", () => `<p>Here's a plan for <b>${esc(clean.toLowerCase())}</b>:</p><ol><li>Where things stand now, and the goal</li><li>The first three things to do</li><li>What to check before calling it done</li></ol><p>Approve it and I'll save it in this space's folder.</p>`], ["Gather what you already have", null], ["List the open questions", null]];
      const tasks = starter.map(([title, made, extra = {}], i) => ({ id: tid(), title, agent: "claude", status: extra.push ? "ready" : i ? "queued" : "run", when: extra.push ? "Just now" : i ? "Queued" : "Running", made, shown: 1, ...extra }));
      if (kind === "repo") tasks[0].branch = `atrium/${tasks[0].id}`;
      const s = { id, name, kind, path: kind === "repo" ? `~/Developer/${name}` : undefined, color: tpl?.color ?? C.accent, last: "Just now", goal: sentence(clean) + ".", agents: ["claude"], files: [], fresh: true, tasks };
      spaces.push(s);
      log(id, "Atrium", `Set up ${name} with ${tasks.length} starter tasks`);
      toast(`Set up “${name}” with ${tasks.length} starter tasks`);
      go(id, tasks[0].id);
      finish(tasks[0], 4000);
    }
    function addTask(s, text) {
      const title = sentence(text.trim().replace(/[.]+$/, ""));
      if (!title) return;
      // Routing in miniature: Claude writes, and in a space other agents may see, Codex reviews.
      const agent = "claude", id = tid();
      const t = { id, title: title.slice(0, 70), agent, status: "run", when: "Running", shown: 1 };
      if (s.kind === "repo") {
        const reviewer = s.private ? "claude" : "codex";
        Object.assign(t, { review: reviewer, branch: `atrium/${id}`, log: ["brief: the goal, done when, the files to read first", "reading the repo", "editing src/index.ts", "editing tests/index.test.ts", `committed to atrium/${id}`, "Atrium ran the checks: typecheck ✓ tests ✓", `${AG[reviewer][1]} reviewed the diff against the brief: approve`], diff: [["src/index.ts", 31, 6, 2], ["tests/index.test.ts", 15, 0, 3]] });
        t.made = () => `<p>Done on its own branch. Atrium's own checks passed and a fresh reviewer approved it.</p><p class="m-mono">${filesLine(t.diff)}</p>`;
      } else t.made = () => `<p>Here's a first pass at <b>${esc(title.toLowerCase())}</b>, ready for you to look over.</p>`;
      s.tasks.unshift(t);
      S.open = id; S.stab = "tasks";
      toast(`${AG[agent][1]} started “${t.title}”`);
      render(true);
      finish(t, 5000);
    }

    const root = $("mac");
    root.addEventListener("click", (e) => {
      const el = e.target.closest("[data-go],[data-open],[data-act],[data-row],[data-new],[data-toast],[data-priv],[data-stab],[data-rule]");
      if (!el || el.disabled) return;
      const d = el.dataset;
      if (d.act) return act(d.act, d.t);
      if (d.open) { const [sid, tid_] = d.open.split(":"); return go(sid, tid_); }
      if (d.go) return go(d.go);
      if (d.row) { S.open = S.open === d.row ? null : d.row; return render(true); }
      if ("new" in d) { const a = $("m-ask"); go("home"); a.value = TEMPLATES.project.example; a.focus(); a.select(); return toast("Press Enter, or describe your own"); }
      if (d.toast) return toast(d.toast);
      if (d.stab) { S.stab = d.stab; return render(true); }
      if (d.rule) { const r = rules.find((x) => x.id === d.rule); r.on = !r.on; toast(`${r.name}: ${r.on ? "on" : "off"}`); return render(true); }
      if (d.priv) { const s = space(d.priv); s.private = !s.private; toast(s.private ? `${s.name} is private. Only Claude works in it.` : `${s.name} is no longer private.`); return render(true); }
    });
    // Steering: a note joins the running task's output, and the agent picks it up from there.
    root.addEventListener("submit", (e) => {
      const id = e.target.dataset?.steer;
      if (!id) return;
      e.preventDefault();
      const input = $("m-steer"), note = input.value.trim(), { t } = findTask(id) || {};
      if (!note || t?.status !== "run") return;
      t.log = t.log || [...IDLE_LOG];
      t.log.splice(t.shown || 1, 0, `you → ${note}`);
      t.shown = (t.shown || 1) + 1;
      input.value = "";
      $("m-term").innerHTML = termText(t);
      toast(`Note sent to ${AG[t.agent][1]}`);
    });
    $("m-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const a = $("m-ask"), s = space(S.view);
      if (s) addTask(s, a.value); else newSpace(a.value);
      a.value = "";
    });
    spaces.flatMap((s) => s.tasks).filter((t) => t.finishIn).forEach((t) => finish(t, t.finishIn));
    render(false);
    return { go, template: (key) => newSpace("", key) };
  })();

  // What it's for: arrow keys move between tabs, and each panel's button opens the matching space or task in the demo.
  const whoTabs = [...document.querySelectorAll(".who-tabs [role=tab]")];
  function pick(tab, focus) {
    whoTabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", on);
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    });
    if (focus) tab.focus();
  }
  whoTabs.forEach((t, i) => {
    t.addEventListener("click", () => pick(t));
    t.addEventListener("keydown", (e) => {
      const k = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!k) return;
      e.preventDefault();
      pick(whoTabs[(i + k + whoTabs.length) % whoTabs.length], true);
    });
  });
  document.querySelectorAll(".who-panel").forEach((panel) => panel.querySelector(".btn").addEventListener("click", () => {
    const [kind, a, b] = panel.dataset.demo.split(":");
    if (kind === "go") app.go(a, b); else app.template(a);
    document.getElementById("try").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  }));
})();
