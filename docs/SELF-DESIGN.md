# Dezin's UI follows Dezin's rules

Dezin generates designs and lints them against an anti-AI-slop craft kernel. The
app's own interface is held to the same bar — it should be the product's best
example, not an exception. The web app (`apps/web`) is built on a small primitive
system (`src/components/ui/`) and an expressive-but-restrained theme
(`src/styles/globals.css`) that follow these rules:

- **One accent.** A single cobalt accent (`--accent`), used sparingly — for the
  primary action, focus rings, and active state. No second accent, no gradients,
  no purple/blue "trust" hero treatments.
- **Borders over shadows.** Surfaces are defined by 1px hairline borders
  (`--border`). Elevation (`--shadow-pop`) is reserved for overlays — dialogs,
  the command palette, the fullscreen preview — never flat cards.
- **Type does the work.** An expressive type scale (`text-display`, `text-title`)
  carries hierarchy via scale + weight + spacing, not color or ornament.
- **Restrained motion.** Transitions are short and ease-out; the only entrance is
  a subtle fade (`dz-animate-in`). A global `prefers-reduced-motion` guard
  neutralizes motion for users who ask for it. No bounce/elastic easing.
- **State coverage.** Every data surface has calm loading (`Loading`/`Skeleton`),
  empty, and error states — not just the populated one.
- **Accessibility.** Native controls, visible `:focus-visible` rings, an
  aria-label on every icon button, one `<h1>` per screen, real `role`s on tabs
  and dialogs.

If a screen here would trip Dezin's own linter, that's a bug.
