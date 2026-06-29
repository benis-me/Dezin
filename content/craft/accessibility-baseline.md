# Accessibility baseline

The legal/usability floor. Target **WCAG 2.2 AA**.

- **Contrast:** body text 4.5:1, large text (≥24px or ≥19px bold) and UI affordances 3:1.
- **Touch / click targets:** ≥ **24×24 CSS px** (AA). 44×44 is AAA / native-mobile comfort.
- **Focus is always visible.** Removing the focus outline without a replacement is a triple failure — keep a clear `:focus-visible` ring.
- **Semantics first:** native `<button>`/`<a>`/`<label>`/`<input>` over div-with-onClick. Exactly one `<h1>`; don't skip heading levels. No positive `tabindex`.
- Every input has a programmatic label; every meaningful image has `alt` (decorative → `alt=""`).
- Don't reach for ARIA when a native element exists — most ARIA in the wild reduces accessibility.
