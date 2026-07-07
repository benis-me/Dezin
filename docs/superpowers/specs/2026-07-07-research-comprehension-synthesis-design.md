# Research comprehension + synthesis: make the build actually consume the visual research

Status: approved (brainstorm) — ready for an implementation plan
Date: 2026-07-07

## Problem

Dual-track Research now collects real design-site imagery (a live run gathered 12
WebGL-portfolio screenshots: Bruno Simon, Active Theory, 10× Awwwards), writes a
strong `visual.md`, and feeds both reports into the build brief. Yet the build
ignored the visual references and produced a generic text-scroll page almost
unrelated to them. Investigation of that run found the research and the feeding
seams are correct — the gap is entirely downstream, from two causes:

1. **The build agent never actually SEES the reference images.** It receives image
   *paths* plus a passive "study these" line; a coding agent doesn't open the PNGs,
   so the visual influence is text-only.
2. **Candidate directions are produced by the product-research agent alone**, in
   parallel with — and blind to — the visual track and the images. The chosen
   direction (`scroll-narrative`) framed the build as a text narrative, diluting the
   visual references' "canvas-is-hero" essence.

(The scaffold is NOT a cause: `compose.ts:91` already tells the build agent to
`npm install <pkg>` what the design needs, naming `three`. The agent stayed
conservative because the visual direction never landed hard enough — a consequence
of the two causes above.)

## Decisions (from brainstorming)

- **Directions come from a new synthesis step, not the product track.** After both
  parallel tracks finish, a dedicated synthesis agent reads the product report + the
  visual report + the brief and produces the candidate directions grounded in the
  *comprehensive* understanding — so a 3D brief yields 3D-forward directions and a
  non-3D brief does not. The product track stops producing directions.
- **Image understanding is 100% agent-driven.** No provider image-analysis model, no
  daemon vision pass. The AGENT doing the work opens and understands the images
  itself. If the configured agent/model cannot read images, the understanding
  degrades — that is a model-selection consequence, deliberately NOT worked around
  with a side model.
- **The images are opened TWICE, by design:** once by the **visual track** (to turn
  seeing into `visual.md`), and once by the **build** (to execute against the real
  pixels). The **synthesis step does NOT re-open the images** — it relies on
  `visual.md`, whose job is to be a self-sufficient "understanding transfer." Visual
  nuance still reaches the final output through the build's second look.
- **The build agent is forcefully instructed to open + study each reference image**
  before designing (mirroring the visual-QA critic's "use the screenshot as primary
  evidence" pattern), replacing today's passive "study these".

## Non-goals / YAGNI

- No provider image-analysis model / no daemon `analyzeVisualAssets` vision pass.
- No scaffold dependency predefinition — the agent self-installs (already the case).
- No re-opening of images in the synthesis step.
- No change to the direction-gate UI or the `.research/directions/<slug>/` format —
  the synthesis step writes the SAME structure the product agent used to.
- No new moodboard captions — the seen-it understanding lives in `visual.md`.

## Architecture

### Data flow

```
brief
 ├─[parallel] PRODUCT track → research.md + sources.json          (NO directions)
 └─[parallel] VISUAL  track → download real imagery
                             → AGENT opens + studies EACH image
                             → visual.md (concrete per-image observations, grounded
                               in the pixels) + sources.json + assets/
        ↓ (after BOTH tracks settle)
   SYNTHESIS step (new, sequential): one agent reads research.md + visual.md + brief
                             → directions/<slug>/  (does NOT re-open the images)
        ↓
   [direction gate — user picks a direction]
        ↓
   BUILD: buildResearchContext prepends BOTH reports and FORCEFULLY instructs the
          build agent to open + study each reference image as primary visual
          evidence before designing
        ↓
   build agent (opens the images itself; npm-installs libs as the design needs) → builds
```

### The three tracks + synthesis (`apps/daemon/src/research-phase.ts`)

`runResearchPhase` keeps the parallel `Promise.all([product, visual])`, then runs a
**third, sequential** synthesis spawn:

- **Product track** (`buildResearchPrompt`, hardened): product/competitive/audience
  discovery → `research.md` + `sources.json`. **Direction-generation removed.**
- **Visual track** (`buildVisualResearchPrompt`, strengthened): collect + download
  imagery, then **open and deeply study each downloaded image** and ground `visual.md`
  in concrete per-image observations (palette / type / layout / motion / texture) —
  `visual.md` must read as if written by someone who actually saw the images.
- **Synthesis step** (`buildSynthesisPrompt`, new): after both tracks, an agent reads
  `research.md` + `visual.md` + the brief and writes the candidate
  `directions/<slug>/` (same convention/format the product prompt used). It reasons
  over the *comprehensive* understanding — the direction set reflects the actual need.
  It does NOT re-open the images (relies on `visual.md`). Runs on whatever reports
  exist (product-only or visual-only projects both work — it uses what is present).
  **Idempotent + soft:** skipped when `directions/` already has candidates (re-run
  guard, parallel to the tracks' `researchExists`/`visualResearchExists` guards);
  retry-once on empty; a failed synthesis simply leaves no directions and the build
  proceeds from the reports.

`ResearchPhaseResult` is unchanged in shape (`produced`/`visualProduced`/`error`);
directions still land in `directions/` and are read by the unchanged
`listDirections`, so the direction gate + `buildResearchContext(chosenDirection)`
keep working untouched.

### Build brief force-opens the images (`packages/research/src/io.ts`)

`buildResearchContext`'s visual-imagery line changes from the passive
"Visual reference imagery is available locally: … Study these real screenshots as
source material." to a forceful instruction: **open and study each reference image
(list the paths) as PRIMARY visual evidence before you design — do not design from
the text alone.** Mirrors `visual-qa.ts`'s screenshot-as-primary-evidence framing.

## Component boundaries (each testable in isolation)

| Unit | File | Pure? | Test |
|------|------|-------|------|
| visual prompt: open+study each image | `prompts.ts` `buildVisualResearchPrompt` | yes | node:test (asserts open-each-image + per-image observation language) |
| product prompt: no directions | `prompts.ts` `buildResearchPrompt` | yes | node:test (no longer instructs writing `directions/`) |
| synthesis prompt | `prompts.ts` `buildSynthesisPrompt` (new) | yes | node:test (reads both reports + brief, writes `directions/<slug>/`, does NOT re-open images) |
| build brief force-open | `io.ts` `buildResearchContext` | yes | node:test (asserts the strong open-images instruction) |
| synthesis spawn wiring | `research-phase.ts` | glue | daemon test w/ fake spawner: product+visual write reports (no directions), synthesis writes directions/ |

## Implementation slices (order)

1. **Prompts (pure, TDD).** `buildVisualResearchPrompt` (open+study each image →
   grounded `visual.md`); `buildResearchPrompt` (remove direction-generation);
   `buildSynthesisPrompt` (new synthesis→directions prompt); `buildResearchContext`
   force-open instruction. Export the new prompt.
2. **Synthesis spawn (daemon).** `runResearchPhase`: after `Promise.all`, add the
   sequential synthesis spawn (retry-once, soft-fail) that produces `directions/`;
   the product track no longer produces directions. Fake-spawner daemon test.
3. **Verify against a real run** (`npm run dev`, a vision-capable agent, research on):
   confirm the visual track's `visual.md` reads as seen-it, the synthesis directions
   reflect the brief's actual need, and a 3D brief now drives a visual-forward build
   that opens the images. Cannot be exercised headless.

Each slice: red→green→refactor, `bash scripts/test-all.sh` + `cd apps/web && npm test`
+ `bash scripts/typecheck.sh` green, one commit, version bump (per project convention).

## Risks

- **Agent vision capability.** The whole chain depends on the configured agent/model
  being able to open + read images (visual track + build). A non-vision agent yields
  weak understanding — by design this is a model-selection consequence, not something
  we compensate for with a provider model.
- **Latency/cost.** +1 sequential synthesis agent turn after the parallel tracks.
  Research is opt-in.
- **Directions format fidelity.** The synthesis prompt must reproduce the exact
  `directions/<slug>/` convention the product prompt used, or the gate +
  `buildResearchContext(chosenDirection)` break. Covered by keeping the convention
  and by the daemon test asserting directions land where `listDirections` reads them.
- **Backward compatibility.** Existing projects whose directions were product-written
  are read identically by `listDirections`; no migration needed.
