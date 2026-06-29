# Color

Use the active design system's tokens. These rules govern how much of each to use.

## The 4-layer pixel budget

| Layer | Share of pixels | Tokens |
|---|---|---|
| Neutrals | **70–90%** | `--bg`, `--surface`, `--fg`, `--muted`, `--border` |
| Accent | **5–10%** | a single `--accent` |
| Semantic | **0–5%** | `--success` / `--warn` / `--danger` |
| Effect | **<1%** | gradients, glows (avoid in product UI) |

- **One accent, used at most twice per visible screen.** Links, hover, focus rings, and the primary CTA all count as accent uses. A second accent hue is almost always wrong.
- Contrast gates: body text **4.5:1**, large text and UI affordances **3:1**.

## Discipline

- Name colors **semantically** (`--accent`, `--surface`) — never `--blue-500` in component CSS.
- Dark themes: never pure black/white. Use `#0f0f0f`-ish on `#fafafa`-ish; prefer `rgba(255,255,255,0.08)` hairline borders over solid grays.
- Tailwind indigo (`#6366f1`/`#4f46e5`/…) as an accent is the textbook AI tell — use the brand's `--accent`.
