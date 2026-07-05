# Live Preview Runtime-Error Sensing Design

## Goal

The live artifact preview should sense its own runtime failures, tell the user, and let the Agent fix them. Today the preview is a bare sandboxed `<iframe>` (`renderPreviewFrame` in `WorkspaceScreen`) with no error detection: if the generated page throws on load, blanks to a white screen, or breaks when the user interacts with it, Dezin shows nothing and the user is left staring at a dead frame.

This feature adds a closed **sense → surface → fix** loop on the *live, user-facing* preview:

1. **Sense** — an injected in-page probe reports runtime errors and a first-paint heartbeat from inside the preview frame.
2. **Surface** — a two-tier UI: a full overlay when the page is broken/blank, a quiet corner badge for non-fatal console/request errors.
3. **Fix** — a one-click "let the Agent fix this" that feeds the captured error into the existing `runBrief` repair pipeline, plus an optional global auto-fix toggle for fatal errors.

This is the live complement to the existing headless Visual Review loop (`visual-qa.ts`), which only senses runtime errors during generation, in a headless browser, for the reviewer agent — never on the user's live preview.

## Post-launch revisions (v0.22.1)

Real-world use after the v0.22.0 launch surfaced three issues. The fixes below **supersede parts of the original design that follows** — read this section as the current shape of the feature.

1. **Blank detection is in-frame, not a parent watchdog.** The original parent-side no-heartbeat watchdog false-fired "did not render" on slow-but-fine Standard previews: a warm preview's one-shot heartbeat arrived *before* the watchdog armed on `setupPhase`, then the freshly-armed timer had nothing to cancel it. The heartbeat and the parent watchdog are **removed**. Instead the **probe** self-detects a blank after the DOM is ready using its own `hasContent()` (authoritative — no cross-frame guessing, no arming race) and posts a `blank` fatal error only when the page genuinely renders nothing (12 s grace, so a slow render never false-fires).
2. **Surface is a single non-masking corner bubble, not a two-tier overlay + badge.** The full-cover fatal overlay hid working content and read only "did not render." `PreviewRuntimeErrorOverlay` is now one dismissible bubble pinned bottom-right (fatal + non-fatal together); its wrapper is `pointer-events-none` so the preview stays fully visible and interactive behind it.
3. **The probe is injected into `<head>`, not before `</body>`,** so its hooks install before the page's own scripts and parse-time errors are caught. (The picker bridge stays at body-end — it manipulates the DOM.)
4. **Repairs bypass Research.** "Fix with Agent" is a targeted code fix, not a new design exploration, so the repair run passes `research: false`; the daemon treats `research: false` as a hard opt-out over `settings.researchEnabled`, so a repair no longer dead-ends at the Research direction gate.

The `sense → surface → fix` shape, the fatal/non-fatal classification, the `runBrief` repair pipeline, the global `autoFixLiveRuntimeErrors` toggle, and the deliberately-deferred CDP layer are all unchanged.

## Scope

In scope:

- An injected runtime-error **probe** script (sibling to the existing picker bridge) for both build modes: Prototype (served HTML) and Standard (Vite dev server).
- In-frame classification of **fatal** (page broken/blank) vs **non-fatal** (page still renders) errors, sourced from uncaught errors, unhandled rejections, `console.error`, resource-load failures, and failed requests (a read-only `fetch`/`XHR` wrapper).
- A parent-side **error model** hook that validates, dedupes, resets, and runs a white-screen watchdog.
- A **fatal overlay** and a **non-fatal badge** rendered over the main workspace preview.
- A **repair bridge**: build a repair prompt from captured errors and dispatch through the existing `runBrief`.
- A **global** `autoFixLiveRuntimeErrors` setting (global + per-run snapshot, matching the existing `visualQaEnabled` pattern) that auto-repairs fatal errors, with loop guards.
- Works identically in the web app and the Electron desktop app (same iframe path).
- Tests for classification, dedup, prompt building, the error-model reducer, message validation, overlay/badge rendering, fix dispatch, the watchdog, and generation-time suppression.

Out of scope (explicitly not planned — see "Deliberately deferred"):

- CDP / `webContents.debugger` / `WebContentsView` capture. The desktop preview stays an `<iframe>`.
- Browser-emitted-only signals that in-page JS cannot observe: CORS, CSP, mixed-content, deprecation, and the browser's own network console lines. These are an accepted limitation.
- Runtime-error sensing in secondary preview surfaces: `PreviewModal`, `VersionCompare`.
- A DevTools panel or an integrated terminal.
- Suppressing or replacing Vite's own compile-error overlay.

## Background — current state

- **Preview** is `renderPreviewFrame` in `apps/web/src/screens/WorkspaceScreen.tsx`: a bare `<iframe src={previewSrc} sandbox=…>` with no `onError`, no load watchdog, no overlay.
- **The preview bridge** (`PreviewBridgeMessage` + `isPreviewBridgeMessage` + the `onMessage` effect in `WorkspaceScreen`) only carries the element **picker** protocol (`selected` / `cancel` / `scroll`). It does not forward runtime errors.
- **The injected bridge** is `SELECT_BRIDGE` in `apps/daemon/src/serve-static.ts` (`injectSelectBridge`, injected server-side for Prototype HTML) and its twin `PICKER_BRIDGE` in `content/templates/react-vite-gsap/vite.config.js` (injected via Vite HTML transform for Standard). Neither hooks `window.onerror`, `unhandledrejection`, or `console`.
- **The only place runtime signals are captured** is `apps/daemon/src/visual-qa.ts`: a headless `puppeteer-core` pass during a generation/repair round captures `console` / `pageerror` / `requestfailed` / `response`, feeds the reviewer agent, and can file a P0 defect that triggers an auto-repair round. It is headless, load-time-only, batch, and gated on `visualQaEnabled` — not the live preview.
- **`StandardDoctor`** surfaces the Standard dev-server *process* logs and a `SetupPhase` (`scaffolding | installing | ready | error`) — build/setup errors, not in-page runtime errors.

The gap this feature fills: nothing watches the live iframe while the user looks at or interacts with a finished design.

## Architecture

Six isolated units, each with one purpose and a well-defined interface:

```
preview frame ──①probe hooks──▶ postMessage ──②protocol/validate──▶ ③error model (classify/dedupe/watchdog/reset)
                                                                        │
                                                      ┌── fatal ────────┤
                                                      ▼                 ▼ nonFatal[]
                                                 ④fatal overlay     ④non-fatal badge
                                                      │                 │
                                                      └── user "Fix with Agent" / ⑤auto-fix ──▶ ⑥repair bridge → runBrief (existing)
                                                                                                        │
                                                                            preview re-renders → heartbeat → error model reset
```

Classification lives **in the probe**, not the parent: the parent cannot read a cross-origin/sandboxed iframe's DOM, but the probe can read its own. So the probe decides fatal vs non-fatal by checking whether the page still has painted content, and the parent trusts that label (plus a no-heartbeat watchdog for the "probe never ran" case).

## Component: Runtime probe (sense)

A self-contained IIFE injected as a **separate sibling** to the picker bridge (kept separate so it cannot regress the picker/markup features). Idempotency guard: `window.__dezinRuntimeProbe`.

Hooks:

- `window.onerror` and `window.addEventListener('error', h, true)` — the capture-phase listener also catches resource load failures (`<img>`/`<script>`/`<link>`), identified by `event.target` being an element with no `message`.
- `window.addEventListener('unhandledrejection', …)` — `event.reason`.
- A `console.error` monkey-patch that forwards arguments and always calls through to the original.
- A lightweight, read-only wrapper around `fetch` and `XMLHttpRequest` that observes network failures and HTTP status ≥ 400. It never alters request behavior, arguments, or return values; on any internal error it falls back to the original transparently. (This is the only way to surface "failed request" signals now that CDP is out of scope.)

Classification (in-frame), evaluated on every captured signal:

- `hasContent()` mirrors the `visual-qa` heuristic: `document.body && body.scrollHeight > 40 && (body.innerText || '').trim().length > 20`.
- `kind = 'fatal'` when an uncaught `error` or `unhandledrejection` fires **and** `hasContent()` is false (e.g. a React render throw that unmounts the tree → blank). The never-painted case is caught by the parent watchdog instead.
- `kind = 'nonfatal'` for everything that occurs while `hasContent()` is still true: `console.error`, resource 404s, failed requests, and handler-level throws that leave the page standing.

Heartbeat:

- After first paint (probe init confirms `hasContent()`, retried briefly), emit `preview-heartbeat { phase: 'first-paint' }` once. This is the signal the parent watchdog waits for.
- v1 does not emit periodic liveness beats; a page that silently blanks *without* any error or console output is a rare, accepted gap. The common interaction-crash path (throw → unmount → blank) is covered because it comes with an uncaught error + `hasContent() === false`.

Dedupe / throttle:

- Signature = `errorType | message | src:line`.
- Maintain a signature→count map; repeats within a ~1s window coalesce and re-emit at most once per window with an updated `count`. Cap the number of retained distinct signatures (e.g. 50) to bound memory during an error storm.
- `message` and `stack` are truncated (e.g. 2 KB each) to bound postMessage size.

Message schema (posted to the parent):

```ts
type RuntimeErrorMessage = {
  source: 'dezin';
  type: 'runtime-error';
  kind: 'fatal' | 'nonfatal';
  errorType: 'error' | 'unhandledrejection' | 'console' | 'resource' | 'request';
  message: string;    // truncated
  stack?: string;     // truncated
  src?: string;       // file or request URL
  line?: number;
  col?: number;
  count: number;
  at: number;         // in-frame timestamp
};

type PreviewHeartbeatMessage = {
  source: 'dezin';
  type: 'preview-heartbeat';
  phase: 'first-paint';
  at: number;
};
```

Injection sites (mirroring the picker bridge exactly):

- **Prototype**: a new `RUNTIME_PROBE` constant + `injectRuntimeProbe(html)` in `apps/daemon/src/serve-static.ts`, called in `serveFileFromBase` alongside `injectSelectBridge` for `text/html` responses.
- **Standard**: a sibling injected script in `content/templates/react-vite-gsap/vite.config.js`, injected by the same HTML transform that injects `PICKER_BRIDGE`.

The probe source is duplicated across those two sites, exactly as `SELECT_BRIDGE` / `PICKER_BRIDGE` already are (the template `vite.config.js` must be standalone because it is copied into generated projects and cannot import from the monorepo). A drift test asserting the two probe copies stay byte-identical is recommended, consistent with Dezin's "one source of truth + drift test" ethos.

## Component: Protocol + validation

- Extend the `PreviewBridgeMessage` handling in `WorkspaceScreen` to recognize `runtime-error` and `preview-heartbeat`. `isPreviewBridgeMessage` already enforces `source === 'dezin'`, `event.source === iframe.contentWindow`, and `event.origin === previewBridgeOriginForSrc(previewSrc)` — reuse it unchanged; only the payload-type discrimination is added.
- Isolated-sandbox Prototype frames post from origin `"null"`, which `previewBridgeOriginForSrc` already returns — so validation works in both modes with no change.

## Component: Preview error model (state)

A hook, `usePreviewRuntimeErrors(previewIframeRef, previewSrc, { runActive, setupPhase })`, living in `apps/web/src/lib/preview-runtime-errors.ts` with pure, testable helpers.

State: `{ fatal: FatalError | null, nonFatal: NonFatalError[], dismissedFatal: boolean }`.

Behavior:

- Subscribes to `window` `message`, validates via `isPreviewBridgeMessage`, routes `runtime-error` (by `kind`) and `preview-heartbeat`.
- **White-screen watchdog**: on iframe `load` (or `previewSrc` change), start a timer (default ~8s). If no `first-paint` heartbeat and no fatal error arrive before it fires, set `fatal = { reason: 'blank', message: 'The preview did not render.' }`. Cancel on the first-paint heartbeat. For Standard, only arm the watchdog once `setupPhase === 'ready'` so the initial Vite compile is not mistaken for a blank.
- **Reset** clears all state on: `previewSrc` change, manual reload, version/branch/conversation switch, and a fresh first-paint heartbeat after a fix.
- **Generation-time suppression**: while `runActive` is true (a run is streaming / `preview-update` in flight), buffer incoming signals but do not surface a fatal overlay; re-evaluate when `runActive` goes false. Transient mid-generation errors never flash an overlay.
- Returns actions: `dismissFatal()`, `dismissNonFatal(id)`, `clearAll()`, `reloadPreview()`.

## Component: Surface (UI)

Both are ordinary renderer DOM stacked above the iframe inside the `renderPreviewFrame` container — which works precisely because v1 keeps the preview an `<iframe>`. Styling follows Dezin's house aesthetic (neutral, borders over shadows, restrained; destructive accent used sparingly).

- **`PreviewRuntimeErrorOverlay`** (fatal): a full cover over the preview with a centered card — title ("This preview crashed" / "The preview is blank"), the error `message`, a collapsible `stack` / `src`, and actions: **`Fix with Agent`** (primary) · `Reload` · `Copy details` · `Dismiss`.
- **`PreviewRuntimeErrorBadge`** (non-fatal): a small corner pill, `Errors · N`, that opens a compact panel listing entries (`message`, `src`, `count`), each copyable; the panel has a `Fix with Agent` action and per-entry / all dismissal. Never interrupts.

## Component: Repair bridge + auto-fix (fix)

- `buildRuntimeErrorRepairPrompt(errors, { mode, projectPath, inspectedTarget? })` composes a repair brief (same spirit as `buildProjectAnalysisPrompt`): states that these are runtime errors observed in the live preview, includes `message` / `stack` / `src` / build mode, and asks the Agent to find the root cause in the project source, fix it, and confirm the preview renders. Fatal fixes send the fatal error; the badge's fix sends all currently-listed non-fatal entries (no per-entry fix selection in v1; dismissal may still be per-entry).
- `fixRuntimeError(errors)` dispatches the prompt through the existing `runBrief` as a new turn in the current conversation — reusing composer/run plumbing with no backend change.
- **Auto-fix**: a new **global** setting `autoFixLiveRuntimeErrors` (default off; global + per-run snapshot, matching `visualQaEnabled`). A controller fires `fixRuntimeError` when: the setting is on **and** a `fatal` error is present **and** `runActive` is false **and** the fatal signature has not already been auto-attempted this conversation **and** no fix is in flight. Guards — one in-flight, dedupe by signature, and a per-conversation cap — prevent an error→fix→error loop. Auto-fix never triggers on non-fatal errors.

## Data flow (end to end)

1. Generated page throws / blanks / logs an error (on load or on user interaction).
2. Probe hook fires, classifies `kind` via `hasContent()`, dedupes, `postMessage`s to the parent.
3. `WorkspaceScreen` `message` handler validates and routes into `usePreviewRuntimeErrors`.
4. Model updates `fatal` / `nonFatal` (respecting `runActive` suppression and the watchdog).
5. Overlay or badge renders over the preview.
6. User clicks `Fix with Agent` (or the auto-fix controller fires) → `buildRuntimeErrorRepairPrompt` → `runBrief`.
7. The repair run rewrites the artifact; the preview reloads; a fresh `first-paint` heartbeat resets the model and clears the overlay.

## Error handling / edge cases

- **Standard/Vite compile errors**: Vite shows its own red compile-error overlay; a compile error also prevents mount → no heartbeat → our watchdog raises a fatal overlay too (with the added `Fix with Agent` action). v1 lets both coexist and does not touch Vite's overlay.
- **Error storms**: bounded by signature dedupe + `count` + a retained-signature cap.
- **Probe never runs / hard crash**: the parent no-heartbeat watchdog still raises the blank overlay.
- **Sandbox origin**: isolated Prototype frames post from `"null"`; already handled by `previewBridgeOriginForSrc`.
- **Message size**: `message` / `stack` truncated in-frame.
- **Auto-fix loops**: prevented by signature de-dup, one-in-flight, and a per-conversation cap.
- **State bleed across previews**: reset on `previewSrc` / version / branch / conversation change.

## Testing strategy

Following existing patterns in `apps/web/src/screens/workspace.test.tsx` and `apps/web/src/components/preview-isolation.test.tsx`:

- **Unit** (`preview-runtime-errors.test.ts`): classification (`hasContent` → fatal/non-fatal), dedupe/throttle + `count`, watchdog timing, `buildRuntimeErrorRepairPrompt` output, the model reducer, and `runtime-error` message validation.
- **Integration**: dispatch synthetic `postMessage` runtime-error events (fatal and non-fatal) → assert overlay / badge render; click `Fix with Agent` → assert `runBrief` receives the expected prompt; change `previewSrc` → assert reset; withhold the heartbeat → assert the blank overlay; set `runActive` → assert suppression; toggle `autoFixLiveRuntimeErrors` → assert one auto-dispatch on fatal and none on non-fatal.

## File change map

- `apps/daemon/src/serve-static.ts` — add `RUNTIME_PROBE` + `injectRuntimeProbe`; call it in `serveFileFromBase` beside `injectSelectBridge`.
- `content/templates/react-vite-gsap/vite.config.js` — add the sibling probe script to the HTML transform.
- `apps/web/src/lib/preview-runtime-errors.ts` (new) — protocol types, pure classification/dedupe/prompt helpers, and the `usePreviewRuntimeErrors` hook.
- `apps/web/src/components/PreviewRuntimeErrorOverlay.tsx` (new) — fatal overlay and non-fatal badge/panel.
- `apps/web/src/screens/WorkspaceScreen.tsx` — extend `PreviewBridgeMessage` handling; mount `usePreviewRuntimeErrors`; render the overlay/badge inside `renderPreviewFrame`; wire `Fix with Agent` → `runBrief`; add the auto-fix controller.
- Settings (daemon settings model + web settings UI) — add `autoFixLiveRuntimeErrors`, following the `visualQaEnabled` global + per-run-snapshot pattern.
- Tests — `preview-runtime-errors.test.ts` (new); extend `workspace.test.tsx` / `preview-isolation.test.tsx`; optional probe drift test.

## Relationship to existing systems

- **Visual Review (`visual-qa.ts`)**: complementary, not overlapping. That loop is headless, generation-time, and reviewer-facing; this one is live and user-facing. Both share the "runtime error → repair" idea and reuse `runBrief`, but trigger at different times through different entry points.
- **Standard Doctor / `SetupPhase`**: process/build-level dev-server diagnostics; unrelated to in-page runtime errors. The error model reads `setupPhase` only to arm the watchdog correctly.
- **Picker bridge (`SELECT_BRIDGE` / `PICKER_BRIDGE`)**: the probe is a separate sibling script using the same injection points and the same validated postMessage channel; the picker/markup features are untouched.

## Deliberately deferred (not planned for v1)

A desktop-only CDP layer (preview moved into its own `WebContentsView`, `webContents.debugger` attached for full `Runtime` / `Console` / `Log` / `Network`) would add the browser-emitted-only signals (CORS/CSP/network) and crash-proof capture. It was considered and dropped: `WebContentsView` is not part of the DOM and floats above the renderer, so it would *prevent* the overlay/badge/picker/markup from sitting over the preview and risk regressing shipped features — a poor trade for signals that all fall in the non-fatal tier. The in-page probe already covers the fatal tier (the part that matters) on both platforms. If richer non-fatal signals are ever wanted, that layer can be built later as an isolated desktop effort.
