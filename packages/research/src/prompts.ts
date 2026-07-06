/**
 * Phase prompts for intake and research. These are the instructions handed to the
 * agent CLI for the pre-design phases. They are pure string builders (no I/O) so
 * they can be unit-tested and composed by the daemon.
 */

import {
  ASSETS_DIRNAME,
  BRIEF_FILE,
  DIRECTIONS_DIRNAME,
  REPORT_FILE,
  RESEARCH_DIRNAME,
  SOURCES_FILE,
  VISUAL_DIRNAME,
  VISUAL_REPORT_FILE,
} from "./convention.ts";

export interface IntakeInput {
  /** The raw user brief. */
  brief: string;
  /** Candidate skills the agent may select from (id + name + description). */
  skills?: Array<{ id: string; name: string; description: string }>;
}

export interface ResearchInput {
  /** The distilled brief (or the raw brief if intake was skipped). */
  brief: string;
  /** The selected skill, with its research angles if the skill provides them. */
  skill?: { id: string; name: string; researchAngles?: string[] };
  /** Active design system name, if any (research should respect the brand). */
  designSystemName?: string;
  /** Whether the user already attached reference material (moodboard/files). */
  hasUserReferences?: boolean;
}

const NEVER_INVENT =
  "Never invent sources, statistics, quotes, or facts. Every claim traces to a real source in " +
  `${RESEARCH_DIRNAME}/${SOURCES_FILE}. When something is genuinely unknown, label it as an ` +
  "assumption — do not fabricate.";

/**
 * Intake prompt — turn a raw brief into research/brief.md and select the fitting
 * skill. Asks at most one blocking question via the ask-user marker.
 */
export function buildIntakePrompt(input: IntakeInput): string {
  const catalog =
    input.skills && input.skills.length
      ? `\n\n## Skill catalog — pick the ONE that best fits (or none if truly none fit)\n\n${input.skills
          .map((s) => `- \`${s.id}\` — ${s.name}: ${s.description}`)
          .join("\n")}`
      : "";
  return `# Phase: Intake

You are a senior product designer starting a new engagement. Do NOT design or write any
artifact yet. Your job is to define the problem crisply and pick the right kind of design.

Read the user's brief below. Distill it into a design brief and write it to
\`${RESEARCH_DIRNAME}/${BRIEF_FILE}\` with this exact frontmatter, then a short prose expansion
in the user's language:

\`\`\`
---
what: <one line — the thing to design>
audience: <who it is for>
goals: [<primary outcome>, <secondary>]
tone: [<adjective>, <adjective>]
mustHave: [<non-negotiable>]
mustAvoid: [<explicit anti-goal>]
references: [<any local paths or urls the user supplied>]
skill: <the id you selected from the catalog>
---
\`\`\`

Rules:
- Infer as much as you responsibly can from the brief; keep it faithful to the user's intent and language.
- If exactly one fact is missing that would block a good design and cannot be inferred, ask a single question with the \`<dezin-ask-user-question>\` marker, then stop. Otherwise do not ask.
- Select the skill whose purpose matches the deliverable. The agent chooses — the user did not pre-pick one.${catalog}

## User brief

${input.brief.trim()}`;
}

/**
 * Research prompt — a real designer's discovery pass, image + text, grounded in the
 * live web. Writes the research/ directory per the Dezin convention.
 */
export function buildResearchPrompt(input: ResearchInput): string {
  const angles =
    input.skill?.researchAngles && input.skill.researchAngles.length
      ? `\n\n## Research angles for a ${input.skill.name}\n\n${input.skill.researchAngles.map((a) => `- ${a}`).join("\n")}`
      : "";
  const brandLine = input.designSystemName
    ? `\n- The active brand is **${input.designSystemName}** — research within its spirit; gather references that fit, not fight, the brand.`
    : "";
  const userRefs = input.hasUserReferences
    ? "\n- The user attached their own references. Treat them as primary signal — study them first, then widen."
    : "";

  return `# Phase: Research

You are a senior product designer AND a user researcher doing discovery BEFORE any design.
Do NOT write HTML, CSS, or any artifact in this phase. Produce a real, thorough research
report — the kind you would present to a client — grounded in the live web.

Use web search and page reads freely (you have web access). Study real products, real
users, and the real domain. Design research is **image + text**: collect real reference
imagery, not just prose.

## Cover the full discovery scope

1. **Competitive & comparative** — FIRST name the artifact's SHAPE the brief asks for (a
   standalone chat surface? a landing page? a dashboard?), then study the products that
   share that shape — those are your direct competitors. Adjacent categories (e.g. a full
   IDE when the ask is a simple chat app) are secondary CONTEXT at most: label them as such
   and never let them drag the design toward the wrong shape. Note what each does well and
   what to avoid. Capture screenshots of the ACTUAL product UI, not marketing pages.
2. **Audience & user research** — who the audience is, their jobs-to-be-done, contexts,
   needs, objections, and the actual language they use. Ground it in real sources
   (reviews, forums, docs, communities), not assumptions.
3. **Domain & content** — real facts, terminology, numbers, and vocabulary for this
   domain so the eventual copy is real, never invented filler.
4. **Visual & aesthetic references** — the moodboard: real product-UI screenshots plus
   color, type, texture, layout, and motion references. Every image must earn its place by
   informing the design — see the asset rule below.
5. **Patterns & conventions** — established patterns for this deliverable, and the one
   convention worth breaking to give it soul.${angles}

## Write these files (exact paths)

- \`${RESEARCH_DIRNAME}/${REPORT_FILE}\` — the synthesized report, image + text. Use the
  sections above as headings. Embed reference images with **relative** markdown paths
  (\`![caption](${ASSETS_DIRNAME}/name.png)\`). End with **Synthesis → 2–3 candidate
  directions**, each with a concept, an information architecture (the sections/screens in
  order), and the ONE distinctive move that would give it soul.
- \`${RESEARCH_DIRNAME}/${ASSETS_DIRNAME}/\` — reference images DOWNLOADED locally (never
  hotlink), kebab-case filenames. Each asset MUST be an actual product-UI screenshot or a
  genuine style/type/color reference that directly informs the design. Do NOT save
  marketing hero shots, \`og:image\` banners, stock photos, people/portraits, bare logos, or
  decorative graphics. After downloading, verify each image truly shows UI (or a real style
  reference) and DELETE anything that does not — few and on-point beats many-and-noisy.
- \`${RESEARCH_DIRNAME}/${SOURCES_FILE}\` — a JSON array; one entry per source:
  \`{ "id", "kind": "competitor|inspiration|article|data|asset", "title", "url",
  "takeaways": [..], "assets": ["${ASSETS_DIRNAME}/name.png"] }\`.
- \`${RESEARCH_DIRNAME}/${DIRECTIONS_DIRNAME}/<slug>/direction.md\` — one file per candidate
  direction: its concept, its information architecture, and its distinctive move.

## Rules

- **Do all of this work, and write every file below, WITHIN this turn — finish only after the
  files exist on disk.** Do NOT delegate the work to background processes or long-running
  sub-agents that keep running after you return: if you parallelise, WAIT for the results and
  synthesise them into the files yourself. A turn that ends before \`${REPORT_FILE}\` and the
  direction files exist has failed, even if searches were dispatched.
- ${NEVER_INVENT}
- **Authority.** Prefer PRIMARY / authoritative sources: official docs, the actual product, first-party data, reputable publications. Distrust SEO content farms, AI-generated listicles, and unsourced statistics — do not cite them. Tag each source in \`${SOURCES_FILE}\` with \`"authority": "primary" | "secondary"\`.
- **Cite everything.** Every factual claim in the report must trace to a source id in \`${SOURCES_FILE}\`. State genuinely-unknown things as an explicit ASSUMPTION — never as fact.
- Download every referenced image into \`${ASSETS_DIRNAME}/\`; the report must render offline.
- Be thorough but decisive — enough to design confidently, not an encyclopedia.${brandLine}${userRefs}
- Write in the user's language.
- This phase ends when the files above exist. The design build is a later phase.

## Brief

${input.brief.trim()}`;
}

const VISUAL_PLATFORMS = ["dribbble", "behance", "awwwards", "mobbin", "pinterest"];

export function buildVisualResearchPrompt(input: {
  brief: string;
  designSystemName?: string;
  platforms?: string[];
}): string {
  const platforms = (input.platforms?.length ? input.platforms : VISUAL_PLATFORMS).join(", ");
  const brand = input.designSystemName
    ? `\n- Active brand: **${input.designSystemName}** — collect references that fit its spirit.`
    : "";
  return `# Phase: Visual Research

You are a design researcher collecting VISUAL inspiration for this build — running IN PARALLEL with a separate product-research agent. Do NOT write the product report; focus only on visual direction.

Use web search + page reads freely. Target professional design sites — ${platforms} — where reachable. Some (e.g. Mobbin, much of Pinterest) are login-walled or block bots: where a site is unreachable, FALL BACK to general web/image search for comparable REAL product UI. Prefer real product interfaces and design-system references over marketing pages, hero shots, stock, portraits, or logos.

## Collect (write these under \`${RESEARCH_DIRNAME}/${VISUAL_DIRNAME}/\`)

- \`${RESEARCH_DIRNAME}/${VISUAL_DIRNAME}/${ASSETS_DIRNAME}/\` — 8–12 DOWNLOADED images (never hotlink), kebab-case names. Each MUST be a real UI screenshot or a genuine style/type/color reference. After downloading, verify each truly shows UI/design and DELETE anything that does not.
- \`${RESEARCH_DIRNAME}/${VISUAL_DIRNAME}/${SOURCES_FILE}\` — a JSON array; one entry per image: \`{ "id", "platform": "dribbble|behance|awwwards|mobbin|pinterest|other", "url", "designer": "<if known>", "reached": true, "takeaways": ["what this teaches: palette / type / layout / motion"], "assets": ["${ASSETS_DIRNAME}/name.png"] }\`. For a site you could NOT reach but still want to cite, add an entry with \`"reached": false\` and no asset.
- \`${RESEARCH_DIRNAME}/${VISUAL_DIRNAME}/${VISUAL_REPORT_FILE}\` — a short curated read distilling the collected imagery into concrete direction: palette, type system, layout, motion, texture. Embed the images with relative markdown paths (\`![caption](${ASSETS_DIRNAME}/name.png)\`). END with a one-line "Reached vs. blocked" note listing which sites you actually got imagery from.

## Rules
- Finish WITHIN this turn — the files above must exist on disk before you return.
- Never invent a source or a designer; only attribute what you can verify.${brand}
- Write in the user's language.

## Brief

${input.brief.trim()}`;
}
