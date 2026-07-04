# Design process — the staged generation path

Status: **implemented** on branch `feature/design-process`, validated end-to-end on a
real CodeBuddy + Hunyuan run. This document is the blueprint for moving Dezin from a
single silent turn to a staged path that mirrors how a real designer works: research
before design, converge on a direction before high-fidelity, critique against intent.

### Implemented

- Skills as runtime progressive disclosure: the composer exposes a *catalog* (each
  skill's name + description + "use when" + an on-demand path to its playbook); the agent
  judges which skill(s) the brief calls for and reads each `SKILL.md` itself, mid-run — no
  single skill body is force-injected. An explicit `skillId` pins a preferred skill without
  locking the agent to it.
- Research phase → the `research/` directory (report + local assets + provenance +
  candidate directions), opt-in via the **Design research** setting (or `body.research`).
- Direction gate: research emits 2–3 directions; the run pauses, the user picks one in the
  workspace, and the build grounds in only that direction.
- Phase-bearing rewrites of all 21 built-in skills.
- Attribution: `model` / `agent` / `skill` recorded on every run.
- Learning loop (local, no upload): 👍/👎 + gap-tag feedback on the result card;
  exemplar retrieval (a build references the user's previously-kept designs — same-project
  and cross-project by skill); and preference distillation (a local agent reflects over the
  feedback and proposes preference lines to add to instructions — human-approved, nothing
  auto-written).

### Follow-ups

The staged pipeline is complete. Natural next iterations: parallel direction generation
(the roadmap's "fan out N approaches at once"), a Studio/Fast mode toggle in the composer,
and richer intent judging in the critique phase.

Two notes specific to the skill catalog: (1) it hands the agent **absolute** playbook
paths, which the local BYOK agents read with `bypassPermissions` — a packaged desktop
build must keep `content/skills/` readable on disk (not sealed inside an asar), or copy
the playbooks to a readable location per run. (2) Attribution records the deterministic
best-guess skill, not the one the agent actually read on demand — parsing the agent's file
reads (which `SKILL.md` it opened) would make skill attribution exact.

## Why

Today a run collapses the whole craft into one turn: `brief → generate artifact`,
with quality enforced *after* (`lint → repair`). The model does research, synthesis,
information architecture, direction, high-fidelity execution, and self-critique in a
single silent shot, and the user only reacts once a full artifact exists. The
deterministic linter (`@dezin/quality`) measures the **floor** (absence of AI slop);
it is structurally blind to the **ceiling** (did this match what I actually wanted).
Most "the output isn't what I want" is a ceiling/intent gap, caused by skipping the
cheap, early stages where a designer de-risks intent.

The fix is **progressive commitment**: split the one turn into phases, put approval
(human or judge) at the *cheap* early phases, so intent is locked before expensive
high-fidelity work — and so a failure becomes attributable to a phase instead of an
opaque blob.

## The phases

| Phase | Real-designer analogue | Output | Gate? |
|-------|------------------------|--------|-------|
| **intake** | Kickoff / define the ask | `research/brief.md` | ask-user when a blocking fact is missing |
| **research** | Discovery / user & market research | `research/` (report + assets) | — (auto) |
| **direction** | Present 2–3 directions, client picks | `research/directions/*` | pick-one (adaptive) |
| **structure** | Wireframe / IA of the chosen direction | `research/directions/<chosen>/structure.md` | optional |
| **build** | High-fidelity composition | the artifact (today's `generateArtifact`) | — |
| **critique** | Self + peer critique vs. brief and craft | findings → repair turns | — |
| **polish** | States, responsive, a11y, QA | geometry + visual QA (today) | — |

Each phase is one agent turn (or a gate). A phase reads prior phase outputs as
context and writes its own artifact. The existing single-shot path *is* the `build`
phase — so the staged path is additive, never a rewrite of the shipped flow.

### Fast vs Studio (adaptive depth)

- **Fast** (today's behavior, maps to `prototype` intent): skip straight to `build`.
- **Studio** (maps to `standard`/deliberate intent): run the full staged path with gates.
- Depth is **adaptive**: a trivial ask ("change the button color") never triggers
  research or a direction gate; gates only fire when scope/ambiguity is high. Studio
  is the ceiling, not a fixed toll.

## Skills as runtime progressive disclosure

Skills are not force-selected in the composer, and no single skill's body is injected
upfront. The system prompt carries a **catalog** — every skill's `name`, `description`,
`triggers` (shown as "use when"), and the absolute path to its full playbook. During the
run the agent judges which skill(s) the brief calls for and **reads the `SKILL.md` on
demand** (it may combine several, or none) — exactly how Claude Code / Agent Skills
surface skills: a cheap catalog in context, the playbook fetched only when relevant. A
deterministic trigger/description score still runs, but only to seed craft selection,
research angles, and attribution — it never biases what the agent sees (the catalog is
ordered plainly, pinned-first). `project.skillId`, if set, is surfaced first and flagged
as *pinned* — preferred, never a lock. This removes upfront config burden (Q3), keeps
every skill one read away, and lets one brief route itself.

Skills themselves are being deep-rewritten from thin taste-bullet lists into
**phase-bearing playbooks**: per-artifact-type research angles, section/IA guidance,
the "one distinctive move" heuristic, and gate conditions — with anti-slop duplication
removed (anti-slop already lives in the craft layer / linter, the single source of
truth).

## The `.research/` directory convention

Research for design is **image + text**. It lives on disk under the project root (as a
dotfolder, so it stays out of the way of the shipped artifact) so it can hold many
resource types and be versioned/inspected like any other artifact:

```
<project>/.research/
  brief.md            # the distilled design brief (intake output)
  research.md         # the synthesized research report — the main deliverable
  sources.json        # machine-readable provenance for every source & asset
  assets/             # all collected images, downloaded LOCALLY (never hotlinked)
    <kebab-name>.<ext>
  directions/         # candidate directions produced after research
    <slug>/
      direction.md    # concept + IA/structure + the one distinctive move + rationale
      preview.<ext>   # optional lo-fi visual / style tile
```

Rules:

- **Everything local.** Every referenced image is downloaded into `assets/` and
  referenced by a relative path (`./assets/foo.png`). Never hotlink a remote URL in
  `research.md` — research must survive offline and be self-contained.
- **Provenance is mandatory.** Every non-trivial claim and every collected asset has
  an entry in `sources.json` (title, url, kind, takeaways, asset filenames). No
  invented facts or fabricated sources — an unknown is labelled, not invented.
- **`research.md` is the human-readable report**; `sources.json` is its machine index.

### `brief.md`

Frontmatter + prose. The distilled intent, derived from the user's brief plus any
intake questions/answers:

```markdown
---
what: <one line — the thing to design>
audience: <who it's for>
goals: [<primary outcome>, ...]
tone: [<adjective>, ...]
mustHave: [<non-negotiable>, ...]
mustAvoid: [<explicit anti-goal>, ...]
references: [<local paths / urls the user supplied>]
skill: <selected skill id>
---

<prose expansion of the brief, in the user's language>
```

### `research.md` sections (designer-grade, not a summary)

A real research report, each section grounded in `sources.json` and illustrated from
`assets/`:

1. **Brief recap** — the problem, audience, success criteria (from `brief.md`).
2. **Competitive & comparative analysis** — direct competitors *and* analogous
   products; what they do, screenshots in `assets/`, what to borrow / avoid.
3. **Audience & user research** — who they are, jobs-to-be-done, contexts, needs,
   objections; the language they actually use.
4. **Domain & content** — real facts, terminology, and data for this domain so copy
   is real, not invented filler.
5. **Visual & aesthetic references** — the moodboard: reference imagery, color/type
   directions, textures, motion references — all as local `assets/` images with notes.
6. **Patterns & conventions** — established patterns for this artifact type, and the
   one convention worth breaking.
7. **Synthesis → directions** — opportunities, positioning, and 2–3 candidate design
   directions (each expanded under `directions/`).

### `sources.json`

```json
[
  {
    "id": "stripe-pricing",
    "kind": "competitor | inspiration | article | data | asset",
    "title": "Stripe — Pricing",
    "url": "https://stripe.com/pricing",
    "capturedAt": "<iso>",
    "takeaways": ["clear tier anchoring", "restrained accent use"],
    "assets": ["assets/stripe-pricing.png"]
  }
]
```

## Learning loop (local, no upload)

The model is frozen (BYOK CLIs) and nothing is uploaded — so "learning" means turning
feedback into edits of the local text corpus that is composed into every prompt, plus
a retrieval store of the user's own accepted outputs:

- **Attribution** — record `model / agent / skillId / promptVersion / mode` per run so
  quality can be attributed to a factor.
- **Feedback** — 👍/👎 + a `gap-tag` (layout / type / color / tone / structure / off-brief)
  on a version.
- **Exemplar retrieval** — keep 👍 outputs; inject the most relevant as few-shot
  ("match the caliber/structure of these"). Highest-ROI, fully local.
- **Preference distillation** — recurring 👍/👎 → a growing per-user preferences block
  (seed: `settings.customInstructions`).
- **Rule/skill promotion** — repeatable 👎 clusters → agent-*proposed*, human-*approved*
  edits to craft / skills / lint rules (the single source of truth).

## Attribution as a side benefit of staging

Because each phase writes an inspectable artifact, a bad result is attributable to a
phase — the brief was underspecified, the wrong direction was chosen, or execution
drifted — instead of being one opaque output. Staging is also observability.
