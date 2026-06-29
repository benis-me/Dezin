# Dezin Capture (Chrome extension)

Capture cover art and design shots from **Pinterest, Behance, and Dribbble** straight
into the Dezin app's composer as a reference plus a recreation brief, then build a
faithful recreation.

## How it works

1. Hover any large image (or video) on a supported site → a **✦ Capture** button appears.
2. Click it → a panel opens with a preview and an **✦ Analyze** button.
3. Hit **Analyze** (shows a loading state):
   - **Images** become a single design reference.
   - **Videos** are sampled into frames at a fixed cadence (best-effort; falls back to the
     poster if the video is cross-origin protected).
   - The captured image is sent to the Dezin daemon, which runs **your configured agent's
     fast model** over it (`POST /api/analyze-image`) and returns a real, design-specific
     recreation brief — not a template. If the daemon/agent is unavailable, a plain brief
     is used so the flow still works.
4. The panel shows the captured reference(s) — toggle which to keep — and the generated,
   editable **recreation brief**.
5. Hit **Import to Dezin →**. The references (fetched to base64 by the background worker, so
   cross-origin CDNs don't taint a canvas) and the brief are POSTed to the Dezin daemon's
   `/api/capture`. **No browser tab is opened** — switch to the running Dezin app and the
   reference + brief are waiting in the home composer. Hit Build to recreate.

## Install (unpacked)

1. Run Dezin — the desktop app, or `pnpm dev` for the web dev server.
2. Run **`pnpm ext`** from the repo root: it prints the extension's absolute path and copies
   it to your clipboard.
3. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**. Chrome's
   dialog has no path field, but you can press **Cmd+Shift+G** (Go to Folder), paste the
   path, Enter, then open the `apps/extension` folder.
4. Click the extension icon and confirm the **Dezin daemon URL**:
   - Desktop app: `http://127.0.0.1:7457` (default — the desktop pins this port)
   - Dev server: `http://localhost:5173`

The handoff is one-shot: the extension `POST`s to `/api/capture`; the Dezin home explicitly
consumes it on load **and whenever the window regains focus**, so an already-open app picks
up an Import without a reload while passive reads cannot clear it.

## Not included

- No packaging/signing (load unpacked only).
- "Analyze" prepares the reference frames and a recreation brief; the actual design
  recreation is produced by Dezin's agent after you Build.
