# Dezin Capture (Chrome extension)

Capture cover art and design shots from **Pinterest, Behance, and Dribbble** straight
into Dezin's home composer as a reference, then build a faithful recreation.

## How it works

1. Hover any large image (or video) on a supported site → a **✦ Capture** button appears.
2. Click it → a panel previews the capture.
   - **Images** are grabbed at full resolution (the background worker fetches them, so
     cross-origin CDNs don't taint a canvas).
   - **Videos** are sampled into a few frames (best-effort; falls back to the poster if
     the video is cross-origin protected). Toggle which frames to keep.
3. Add an optional note, then **Import to Dezin →**. The references are POSTed to the
   Dezin daemon (`/api/capture`) and Dezin opens with them already in the composer —
   hit Build to recreate.

## Install (unpacked)

1. Run Dezin (`npm run dev`, or the desktop app).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select this `apps/extension` folder.
3. Click the extension icon and set **Dezin URL**:
   - Dev server: `http://localhost:5173`
   - Installed app / desktop: `http://127.0.0.1:7457`

The handoff uses a one-shot endpoint on the daemon: the extension `POST`s the images to
`/api/capture`; Dezin's home reads and clears them on load. Vite proxies `/api`, so the
same URL works for both the dev server and the bundled daemon.

## Not included

- No packaging/signing (load unpacked only).
- The deep "recreation plan" is produced by Dezin's agent after import — the panel just
  prepares and previews the references.
