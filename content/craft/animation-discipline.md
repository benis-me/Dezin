# Animation discipline

Motion earns its place only for spatial, temporal, or state reorientation. Don't
animate to teach, decorate, signal "premium", or fill silence.

## Budget

| Purpose | Duration |
|---|---|
| Instant feedback (press, hover) | 50–100ms |
| State confirmation (toggle, check) | ~150ms |
| Any non-cross-screen transition | < 500ms |

- Use an **ease-out** curve for opacity/color; a spring for position/scale/gesture. Never `ease-in` for UI (feels sluggish).
- **`prefers-reduced-motion: reduce` is mandatory** — drop non-essential motion to opacity-only or none.
- **Fail-safe visibility (load animations)**: any on-load reveal that starts content at
  `opacity:0` / off-screen MUST recover if the animation never runs (a tab loaded in the
  background pauses `requestAnimationFrame`, a CDN/library fails, a JS error throws).
  Keep the pre-animation state legible, or add a hard fallback that force-reveals after
  ~1s (a `setTimeout` that sets the end state, or CSS that shows content once a `loaded`
  class is present). Never ship a hero whose legibility depends on a frame firing.

## Don't

- Decorative motion in the working canvas of a productivity tool.
- Entrance animations on content the user is waiting to read.
- Parallax, auto-playing carousels, bouncy easing on functional UI.
