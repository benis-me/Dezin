# Sharingan — Clone-from-URL Design

## Goal

Give Dezin a mode that reconstructs an existing website from its URL. The user drops in a URL; Dezin opens the site in a controllable browser, captures it (screenshots + DOM + computed-style tokens + assets), lets the coding Agent probe a few key pages, and then builds a high-fidelity Standard (Vite/React) project that reconstructs the site's structure, design language, and layouts. If a page needs a login, Dezin pauses and asks the user to sign in — it never bypasses auth.

Sharingan is a **high-fidelity reconstruction**, not a byte-for-byte rip: it rebuilds structure and design tokens as a real, editable Dezin project, and treats brand assets (logos, photography, exact marketing copy) as swappable placeholders/references rather than redistributing them. It is for sites the user is authorized to reproduce.

## Scope

In scope:

- **Entry**: double-click "Start a design" on the Home composer enters Sharingan mode — the Design Research toggle is hidden, the input becomes a URL, output is forced to Standard, and the run skips Research (`research: false`, the existing opt-out). A one-time **authorized-use affirmation** gates the first run.
- **Desktop-only (product gate)**: Sharingan ships on the desktop build. The daemon owns the headful browser and the daemon is local in either build, so this is a scoping/simplicity choice — not a hard technical requirement; the web/dev build disables the entry with a "requires the desktop app" note. (Enabling it on the dev web surface later is just removing the gate.)
- **Capture scope (MVP)**: the entry page is captured deterministically; the Agent then autonomously discovers and probes a **bounded** set of key pages — a configurable **page budget**, default **6**.
- **Hybrid capture**: a deterministic first pass owned by the daemon, plus Agent-driven follow-up probing through daemon HTTP endpoints.
- **Login handling**: detect a login wall / 401·403 / auth redirect → pause → prompt the user to sign in in the visible browser → resume with the authenticated session. User-driven only.
- **Sharingan tab**: a live CDP screencast mirror of the browser + an action-log stream + a login-prompt banner + a phase indicator.
- **Build**: the capture bundle becomes a high-fidelity reference brief; the Agent builds a Standard project, reusing the existing recreate-from-reference + build pipeline. Visual Review / auto-improve run as usual.
- **Guardrails**: authorized-use affirmation; brand assets treated as placeholders (inventoried, not redistributed); no auth bypass.
- Tests for capture, login detection, the browser-control endpoints, the entry/mode wiring, the tab, and the run-handler capture-before-build integration — all against local fixture sites with headless puppeteer (no real external site, no Electron needed).

Out of scope (see "Deliberately deferred"):

- Full-site crawl (unbounded multi-page). MVP is entry + a bounded set of Agent-chosen pages.
- A web/headless-only Sharingan (no auth) — desktop is the only surface.
- Interactive screencast (forwarding clicks/keys into the tab). MVP logs in via the visible browser window; the tab mirrors it read-only.
- Pixel-perfect byte cloning / lifting the target's HTML/CSS/JS or assets verbatim. Sharingan reconstructs; it does not rip.
- Capturing behind CAPTCHAs / anti-bot challenges beyond a normal user login.

## Background — what exists to reuse

- **Headless Chrome via puppeteer-core**: `apps/daemon/src/visual-qa.ts` already launches Chrome (`findChrome` from `capture-cover.ts`), sets viewports, screenshots, and runs `page.evaluate(getComputedStyle(node))`. Sharingan reuses this — headful, CDP-driven, persistent profile.
- **Computed-style extraction**: `packages/quality/src/computed.ts` already turns a rendered DOM into design signals (colors, type scale, spacing, borders/shadows, component tells). Sharingan reuses its extraction to build style tokens.
- **Agent "tools" pattern**: Dezin gives Agents capabilities by injecting a prompt block that tells them to call local daemon HTTP endpoints with the `x-dezin-daemon-token` header — see the Effects lookup in `apps/daemon/src/project-effect-context.ts`. Sharingan's Agent browser-control uses this exact pattern (no MCP).
- **Research opt-out**: `run-handler.ts` honors `body.research === false` as a hard opt-out over `settings.researchEnabled` (added in v0.22.1). Sharingan runs pass it.
- **Conditional tabs**: `WorkspaceScreen` `TABS` already filters (Research only shows when it exists). The Sharingan tab mirrors that (shows only for Sharingan projects).
- **Reference-to-build plumbing**: the composer already supports "recreate from a screenshot" and prepends reference context to the build brief (`buildResearchContext`-style). The capture bundle feeds through the same path.
- **Electron already captures pages**: `apps/desktop/main.js` spins up a `BrowserWindow` and calls `webContents.capturePage` (cover capture) — confirms browser+capture primitives are already in the app; Sharingan instead uses the daemon's puppeteer so control lives in one process and avoids the WebContentsView-floats-above-DOM problem.

## Architecture

Four phases, each an isolated unit with a well-defined interface:

```
Home (double-click) → Sharingan mode → create project {sharingan, standard, sourceUrl, research:false}
   │
   ▼  (workspace opens, auto-selects the Sharingan tab)
① Browser session (daemon-owned headful puppeteer + CDP)  ──screencast──▶ Sharingan tab (live mirror + log)
   │
② Deterministic first-pass capture (entry page): viewports, DOM, style tokens, assets, links
   │   └─ login wall? → pause → tab prompts → user signs in → resume
   ▼
③ Agent probe (hybrid): build Agent calls browser-control HTTP endpoints to discover + capture ≤N key pages
   │
   ▼  (.sharingan/ bundle written: screenshots, dom, styles.json, assets.json, pages.json)
④ Build: capture bundle → reference brief → Agent builds a Standard project → Preview/Quality as normal
```

Control and the browser both live in the **daemon** (one process): the daemon drives the deterministic pass AND exposes the same browser-control surface as HTTP endpoints the Agent calls. The desktop app renders the tab (screencast + log) and the login prompt.

## Component: Entry & mode (Home)

`HomeScreen` gains a `sharingan` mode toggled by **double-clicking the "Start a design" heading / composer**. In Sharingan mode:

- The Design Research toggle is hidden; the mode selector is forced to Standard (and shown as fixed); the textarea placeholder becomes "Paste a URL to clone…" and input is validated as an http(s) URL.
- A compact "Sharingan" indicator marks the mode; double-clicking again (or an ✕) exits back to normal.
- On submit, `onNewProject(url, skillId, "modern-minimal", "standard")` is extended to carry a `sharingan: true` flag and the `sourceUrl`. The project is created with `sharingan = true`, `mode = "standard"`, `sourceUrl = <url>`.
- **Authorized-use affirmation**: the first time a user starts a Sharingan run, a short confirm requires them to affirm they have the right to reproduce the target site. Persisted (a settings flag) so it's asked once, not every run.
- Desktop-only: on the web build the entry is disabled with a tooltip; `native?.isDesktop` (or the existing desktop bridge) gates it.

## Component: Browser session (daemon)

`apps/daemon/src/sharingan-browser.ts` owns a **single headful puppeteer Chrome** (via `findChrome`) with a **persistent user-data-dir** (a shared Sharingan profile under the data dir, so a user's logins persist across pages/projects). It exposes a small typed interface over CDP:

- `open(url)`, `navigate(url)`, `currentUrl()`
- `screenshot({ mode: "viewport" | "fullPage" | "element", selector?, viewport? })`
- `readDom({ maxNodes })` — a structural DOM snapshot (tag, classes, role, text, box, key attrs)
- `computedStyles({ selector? })` — reuse `quality/computed` extraction → style tokens
- `click(selector)`, `scroll({ to })`, `discoverLinks()` — same-origin, in-nav links
- `startScreencast(onFrame)` / `stopScreencast()` — CDP `Page.startScreencast` → throttled JPEG frames

The session is lazily created per active Sharingan capture and released on idle (mirroring `project-runtime`'s dev-server lifecycle). Only one capture runs at a time per project.

## Component: Deterministic first-pass capture

`apps/daemon/src/sharingan-capture.ts` orchestrates the entry-page capture: navigate → wait for paint (reuse the visual-qa content heuristic) → for each viewport (mobile + desktop): full-page + section screenshots; one DOM snapshot; one computed-style token set; an asset inventory (image/font/stylesheet URLs, deduped); `discoverLinks()` for the Agent to consider. It streams each step as an action-log event and writes into `.sharingan/`.

**Login-wall detection** (heuristics, any one triggers a pause): the main document responds 401/403; navigation redirects to a URL matching `/(login|signin|sign-in|auth|account)/i`; or the painted page is a near-empty shell containing a password field. On detection it emits `login-required { url }` and halts until `continue` is called.

## Component: Browser-control endpoints + Agent prompt block (hybrid probe)

`apps/daemon/src/sharingan-handler.ts` exposes the browser interface as HTTP (all `x-dezin-daemon-token`-gated):

- `POST /api/sharingan/:id/start { url }` — open + begin the deterministic pass
- `POST /api/sharingan/:id/navigate { url }`, `/screenshot`, `/read-dom`, `/computed-styles`, `/click`, `/scroll`, `/discover-links`
- `POST /api/sharingan/:id/continue` — resume after a login pause
- `GET /api/sharingan/:id/status` — phase + captured pages
- `GET /api/sharingan/:id/screencast` (SSE) — screencast frames
- `GET /api/sharingan/:id/events` (SSE) — action log + `login-required` + phase changes

`apps/daemon/src/sharingan-context.ts` (mirroring `project-effect-context.ts`) builds the Agent prompt block: how to call these endpoints to navigate/read/screenshot, the page budget (≤ 6 by default, configurable), the `.sharingan/` bundle layout, and the guardrail instructions (below). The deterministic pass calls the same browser interface internally; the Agent calls it over HTTP — same surface, two callers.

## Component: Login flow

On `login-required`, the tab shows a banner: the visible browser window is open on screen; the user signs in there; the persistent profile remembers the session; clicking **Continue** calls `/continue` and capture resumes from where it paused. No credentials pass through Dezin; nothing is bypassed. If the user cancels, the capture proceeds with whatever public content it has and notes the skipped page.

## Component: Capture bundle → build

Written under `<projectDir>/.sharingan/`:
- `pages.json` — the pages captured (url, title, viewport set, screenshot paths)
- `<page>/shot-<viewport>.png`, `<page>/dom.json`, `<page>/styles.json`
- `assets.json` — inventory (kind, url, role) — a manifest, **not** re-hosted assets

`run-handler.ts` extends: when `project.sharingan`, before the build turn it (a) ensures the capture phase has run (kicks `sharingan-capture` if not), (b) injects the `sharingan-context` prompt block + a bundle summary into the build brief, (c) runs the build with `research: false`. The Agent reconstructs a Standard project from the bundle. Visual Review / auto-improve run normally to tighten fidelity.

## Component: Sharingan tab (web)

`apps/web/src/screens/SharinganTab.tsx`, shown in `WorkspaceScreen` only for `sharingan` projects and auto-selected while capturing:
- **Screencast pane** — renders the `/screencast` SSE frames (a mirror of the live browser).
- **Action log** — the `/events` SSE stream (navigate/capture/probe steps).
- **Login banner** — on `login-required`, a prompt + **Continue** button (`POST /continue`).
- **Phase indicator** — capturing → probing → building → done.

`TABS` in `WorkspaceScreen` gains `"Sharingan"`, filtered to `project.sharingan`.

## Component: Skip Research

Sharingan runs pass `research: false`; the URL brief never enters Research/the direction gate. (The daemon opt-out already exists.)

## Guardrails (built in)

- **Authorized-use affirmation** on first run (persisted).
- **Brand assets as placeholders**: `assets.json` is an inventory only; the build prompt instructs the Agent to reconstruct structure + design language and to use placeholders for logos, brand photography, and verbatim marketing copy rather than re-hosting or reproducing them. Dezin's anti-slop ethos already pushes toward "tasteful reconstruction," not verbatim copy.
- **No auth bypass**: login is user-driven in the visible browser only.

## Error handling / edge cases

- **SPA / lazy content**: the deterministic pass scrolls to trigger lazy loads before capture; the Agent can `scroll`/`click` to reach more states.
- **Anti-bot / CAPTCHA**: treated like a login wall — pause and let the user handle it in the visible browser; if unresolved, proceed with public content and note the gap.
- **Timeouts / never-settling pages**: bounded waits (reuse visual-qa's `domcontentloaded` + content poll + hard ceilings); a stuck navigation records an error step, not a hang.
- **Browser crash / disconnect**: the session is recreated; the capture reports the failed step. The build can proceed with partial captures.
- **Page budget**: the Agent's probe is capped (default 6 pages); the cap is logged so "covered the whole site" is never implied when it wasn't.
- **Fidelity ceiling**: reconstruction is high-fidelity, not byte-identical; the spec and UI frame it as "rebuild," and Visual Review closes remaining gaps.

## Testing

Everything is tested against **local fixture sites** served from a temp dir with headless puppeteer (`findChrome`) — no real external site, no Electron:
- `sharingan-capture`: a multi-section fixture → assert screenshots per viewport, DOM/style extraction, asset inventory, link discovery.
- Login detection: fixtures that 401, that redirect to `/login`, and that render a password-only shell → assert `login-required`; a `continue` resumes.
- Endpoints (`sharingan-handler`): navigate/screenshot/read-dom/computed-styles/click/scroll against the fixture; token gating.
- `run-handler`: a `sharingan` project runs capture before build, injects the prompt block, and passes `research: false` (extend `runs.test.ts` with a fake capture + `FakeRunner`).
- Web: `SharinganTab` renders screencast frames + log + the login banner and Continue; the Home double-click toggles Sharingan mode and `onNewProject` carries the flag + URL.

## File change map

- `apps/daemon/src/sharingan-browser.ts` (new) — headful puppeteer session + CDP interface + screencast.
- `apps/daemon/src/sharingan-capture.ts` (new) — deterministic first-pass + login detection + `.sharingan/` writer.
- `apps/daemon/src/sharingan-handler.ts` (new) — HTTP endpoints + SSE.
- `apps/daemon/src/sharingan-context.ts` (new) — Agent prompt block (browser-control + guardrails).
- `apps/daemon/src/run-handler.ts` — capture-before-build for `sharingan` projects; inject context; `research:false`.
- `apps/daemon/src/app.ts` — route the `/api/sharingan/*` endpoints.
- `packages/core` (`types.ts`, `store.ts`) — `sharingan` + `sourceUrl` on the project (store migration, mirroring `autoFixLiveRuntimeErrors`).
- `apps/web/src/screens/HomeScreen.tsx` — Sharingan mode (double-click entry, URL input, forced Standard, affirmation), extend `onNewProject`.
- `apps/web/src/screens/SharinganTab.tsx` (new) + `WorkspaceScreen.tsx` — the tab, conditional + auto-select.
- `apps/web/src/lib/api.ts` — sharingan endpoints + SSE.
- Tests as above.

## Deliberately deferred

- Full-site crawl (unbounded).
- Web/headless no-auth Sharingan (desktop-only for now).
- Interactive screencast (forwarding input into the tab) — MVP logs in via the visible browser window.
- Any verbatim rip of the target's code/assets — Sharingan reconstructs, by design and for IP reasons.
