# Typography

Brand-agnostic typographic craft. The brand's DESIGN.md picks the fonts; these
rules govern how to set them.

## Letter-spacing (the rule that makes or breaks craft — no exceptions)

| Context | Tracking |
|---|---|
| ALL CAPS / small caps | **0.06em–0.1em (required)** |
| Headings 32px+ | −0.01 to −0.02em |
| Display 48px+ | −0.02 to −0.03em |
| UI labels / eyebrows | 0.02em (0.08em if uppercase) |
| Body | 0 |

ALL-CAPS without ≥0.06em tracking is the single most common amateur tell.

## Scale & weight

- Max **2 typefaces** (a display/body pair + an optional mono). Never set a heading in bare `system-ui` when the brand binds a real display face.
- A **3-weight system**: Read (400/450), Emphasize (510/550), Announce (590/600). Weights above 700 are rarely needed; prefer scale + space for emphasis.
- Type scale on a 1.2–1.25 ratio, 6–8 sizes max.

## Measure & rhythm

- Line length **50–75 characters** (`max-width: 65ch` for prose). Line-height 1.5–1.65 for body, tighter (1.1–1.25) for display.
- **Never `text-align: justify`** on the web — it creates rivers.
- Tabular numerics (`font-variant-numeric: tabular-nums`) for any aligned figures, tables, or prices.
