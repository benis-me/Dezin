# @dezin/quality

The anti-AI-slop **quality kernel** — Dezin's headline differentiator. A
deterministic linter tuned to Dezin's neutral-grayscale, borders-over-shadows
taste, plus the **closed loop** that feeds blocking findings back to the agent
until the artifact passes.

Zero runtime dependencies. Pure functions, no I/O — the closed loop takes a
callback so it stays transport-agnostic (real agent turn in the daemon, fake
function in tests).

## API

```ts
import { lintArtifact, renderFindingsForAgent, lintAndRepair } from "@dezin/quality";

// 1. Deterministic P0/P1/P2 checker
const findings = lintArtifact(html, { accentOveruseCap: 3 });

// 2. Format the <artifact-lint> self-correction block (or null if clean)
const block = renderFindingsForAgent(findings);

// 3. The closed loop: lint → if P0, feed the block back → re-lint, up to maxRounds
const result = await lintAndRepair(html, async (lintBlock) => {
  return await runAgentTurn(lintBlock); // your real agent turn
}, { maxRounds: 2, blockOn: ["P0"] });
// → { html, rounds, findings, passed, history }
```

## What it catches

- **P0 (cardinal sins):** AI-default indigo (with the `:root --accent` escape
  hatch + laundering detection), purple/violet & blue→cyan trust gradients,
  emoji feature-icons, sans-on-display, rounded card + left-border accent,
  invented metrics, filler copy, `scrollIntoView`, (decks) missing slide theme.
- **P1:** ALL-CAPS without ≥0.06em tracking (token-aware, resolved across
  themes), external image CDNs, >12 raw hex outside `:root`, accent overuse
  (cap **3**, a deliberately strict default).
- **P2:** `<section>` missing `data-dezin-id`.
- **Dezin extensions:** shadow-only cards (prefer borders), gradient-clipped
  text, oversized non-pill border-radius. Toggle with `disableDezinRules`.

The rule corpus (indigo/emoji/gradient/metric lists) lives in `src/slop-rules.ts`
as a **single source of truth** so the prompt-injected craft doc and the linter
can't drift.

## Test

```sh
node --experimental-strip-types --test 'test/*.test.ts'
```

The suite runs directly with Node ≥ 22.16 type-stripping. Use the repository-level
`pnpm test:coverage` command to run it with the enforced coverage floor.
