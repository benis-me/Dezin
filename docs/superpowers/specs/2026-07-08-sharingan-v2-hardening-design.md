# Sharingan v2 — Hardening Design

## Why

Real-world test on `https://app.tapnow.ai/home` failed hard, and forensics on the generated project (`.dezin/data/projects/0028be6a-…`) showed **all three reported symptoms trace to one root cause: login walls that are neither detected nor passable.**

- The capture landed on a **Google-OAuth login page** (`dom.json` = "登录或注册 / 使用Google继续 / 使用手机号继续", `links: []`), because `detectLoginWall` misses OAuth/social walls (no `<input type=password>`, no `/login` URL change, HTTP 200).
- The controlled Chrome can't pass Google/Cloudflare anyway — puppeteer launches with `--enable-automation` + `navigator.webdriver`, which they detect and block.
- So the "capture" succeeded on the login page → the session closed on `"captured"` (looks like "Chrome exits itself") → the Agent reconstructed a **hallucinated** product page from a login screenshot ("还原度奇差").
- Even on a valid capture the reference is lossy: DOM capped at 400 nodes, styles are a top-N token summary (not layout), **no image inventory**, no free-placeholder instruction ("该有图的地方没有占位图").
- **Visual Review is fidelity-blind:** the critic (`agentReviewPrompt`) receives only the rendered screenshot, never the source — so it can only make generic tweaks ("审了半天只改了些无关紧要的颜色").

## Scope (P0 → P2)

Seven changes, daemon-side, all on `feat/sharingan-v2`.

### P0 — Login (the root cause; nothing downstream works without it)

1. **Stealth browser launch** — `SharinganSession.open` removes the automation tells so the user can complete Google/Cloudflare login in the visible window. Manual flags, **no new dependency**:
   - `ignoreDefaultArgs: ["--enable-automation"]`
   - `args += ["--disable-blink-features=AutomationControlled"]`
   - a realistic desktop Chrome `User-Agent` (via `page.setUserAgent`) — never `HeadlessChrome`
   - `page.evaluateOnNewDocument` to make `navigator.webdriver` `undefined`
   - (puppeteer-extra-plugin-stealth is the escalation if Google still blocks; not v2.)
   - **This does NOT bypass auth** — the user still clicks "Continue with Google" and signs in themselves. It only stops the browser from being flagged as a bot.

2. **OAuth / social-login detection** — `detectLoginWall` gains a content heuristic so SPA/OAuth walls pause-and-prompt instead of being captured. A pure `looksLikeLoginWall(dom, text)` check: the visible content is dominated by login/register keywords (multilingual: `login|sign in|log in|signin|sign up|register|登录|注册|登入|ログイン`) and/or prominent OAuth-provider buttons ("continue with google/apple/github/…", "使用 … 继续/登录") with little other content. `capturePage` already reads the DOM — pass it in; `detectLoginWall` returns true if any existing heuristic OR the new content heuristic fires.

### P1 — Fidelity & images (on a *valid* capture)

3. **Asset inventory** — `SharinganSession.assets()` collects `<img>` `src`/`srcset`/`alt`, `<source>`/`<video>` URLs, and CSS `background-image` URLs (with the owning element's role/box). `captureCurrentPage` writes `assets.json` into the page bundle and adds `assets` to `CapturedPage` + `pages.json`.

4. **Richer structural capture** — `readDom` raises the node cap (400 → 1500) and includes a small set of key computed styles per node (`display, position, flexDirection, justifyContent, alignItems, gap, fontSize, fontWeight, color, backgroundColor, padding, margin`), so the Agent reconstructs from a real layout blueprint, not a screenshot guess. Still a **reconstruction reference**, not a byte-rip of the source HTML/CSS.

5. **Free placeholder images** — `buildSharinganContext` instructs the Agent to fill image slots with **free placeholders** (`https://picsum.photos/seed/<id>/<w>/<h>`, `https://placehold.co/<w>x<h>`, or an Unsplash source URL keyed to the content) sized/positioned per `assets.json`, with sensible `alt` — instead of omitting images or hotlinking the source's brand assets.

6. **Sharingan-aware Visual Review** — the critic gets the captured source screenshot as a **fidelity reference**:
   - `VisualQaInput` gains `sharinganReference?: { screenshotPath: string; assetsSummary?: string }`.
   - `agentReviewPrompt` gains a "Fidelity vs. source" section when the reference is present: embed the source desktop screenshot, and instruct the critic to flag divergence in **layout structure, component hierarchy, image-slot placement, type scale, and color palette** — not just generic quality.
   - `run-handler` passes the reference (the entry page's `.sharingan/<page>/shot-desktop.png` + a short assets summary) when `project.sharingan`. Fidelity findings feed the existing repair/ceiling loop.

### P2 — Session lifecycle

7. **Less Chrome churn** — raise `SHARINGAN_PROBE_IDLE_MS` (120s → 300s), and during a `sharingan` build keep the entry-capture session **open** for the Agent to reuse for probing (defer the `startCapture` close for the build path; the idle timer releases it), so Chrome doesn't open/close repeatedly and the just-authenticated session persists into probing.

## Non-goals / preserved guardrails

- **Auth is still user-driven** — stealth only makes the visible window non-bot-flagged; the user signs in. No credential handling, no auto-solving CAPTCHAs.
- **Reconstruction, not rip** — richer capture adds computed-layout *reference*, not the source's verbatim HTML/CSS/JS or re-hosted assets. Brand images become free placeholders.
- No puppeteer-extra dependency (manual stealth flags). If Google still blocks after this, the stealth plugin is a follow-up, not v2.

## Testing

- Stealth: assert the launch options (`ignoreDefaultArgs`, the flag, UA, webdriver spoof) — a unit/DI check, no external site.
- Login detection: `looksLikeLoginWall`/`detectLoginWall` unit tests over the ACTUAL captured `dom.json`-shaped fixture (the tapnow login DOM) → true; a normal content page → false.
- Asset inventory + richer DOM: Chrome-gated capture of a local fixture with images → assert `assets.json` + per-node styles.
- Context: the prompt contains the placeholder-image + match-source instructions.
- Visual Review: `agentReviewPrompt` with a `sharinganReference` contains the fidelity section + the source screenshot path; without it, unchanged.
- Lifecycle: DI test that the entry session is reused (not re-opened) across a probe in a build path; idle release still works.
- All against local fixtures / DI — never a real external site.
