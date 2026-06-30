/**
 * composeSystemPrompt — Dezin's lean 5-layer prompt composer.
 *
 * A disciplined precedence order (injection-resistance first, anti-roleplay last)
 * collapsed to five load-bearing layers:
 *
 *   0. injection resistance (pinned first)
 *   1. identity charter
 *   2. anti-slop contract (generated from the linter's rule lists)
 *   3. active design system — DESIGN.md authoritative + tokens.css verbatim
 *   4. active skill workflow (optional)  + user instructions (optional)
 *   —. anti-roleplay (pinned last)
 */

import type { DesignSystem } from "../../design/src/index.ts";
import { INJECTION_RESISTANCE, IDENTITY_CHARTER, SELF_CRITIQUE, ANTI_ROLEPLAY } from "./charter.ts";
import { renderAntiSlopContract } from "./anti-slop.ts";
import { renderDirectionBlock, type Direction } from "./directions.ts";
import { DECK_FRAMEWORK } from "./deck.ts";

export interface ComposeInput {
  /** The active brand. Injected as authoritative tokens. */
  designSystem?: DesignSystem;
  /** The active skill (artifact shape): its SKILL.md body is the workflow. */
  skill?: { name: string; body: string; mode?: string; libraries?: string[] };
  /** Free-form project/user instructions. */
  userInstructions?: string;
  /** Pre-rendered craft references (from @dezin/craft loadCraftSections). */
  craft?: string;
  /** A visual direction to follow when no design system is active. */
  direction?: Direction;
  /** When true, the agent may request generated imagery via data-gen-prompt. */
  imageGen?: boolean;
  /** Build mode — "prototype" (single index.html) or "standard" (real Vite project). */
  mode?: "prototype" | "standard";
}

const FONTS = `## Fonts — load them, never assume them

The design system names specific typefaces. LOAD them as real web fonts so the
design renders as intended on any machine — never rely on a font merely being
installed. Use Fontsource (self-hosted, reliable):
- Prototype (single HTML): add a Fontsource CDN stylesheet in <head>, e.g.
  \`<link rel="stylesheet" href="https://cdn.jsdelivr.net/fontsource/css/inter@latest/index.css">\`
  (swap "inter" for the brand face; or a Google Fonts <link>). Then use the family
  via var(--font-display)/var(--font-body).
- Standard (project): \`npm install @fontsource-variable/<font>\` and import it in
  src/main.jsx (e.g. \`import "@fontsource-variable/inter"\`).
Match the brand's display + body faces. If a named face has no free web source, pick
the closest free Fontsource family rather than falling back to a bare system stack.`;

const PROTOTYPE_BUILD = `## Output — one self-contained file

Build a single \`index.html\` with inline <style> and <script>. No build step. This is
a fast, shareable prototype.

Add \`data-dezin-id\` to every top-level section or screen region so critique and
markup tools can target the artifact precisely.`;

const STANDARD_BUILD = `## Output — a real Vite + React project

You are working inside a scaffolded Vite + React + GSAP project (not a single HTML
file). Build it the way a production frontend is built:
- Edit \`src/App.jsx\` and compose the design from focused components in
  \`src/components/\`. Keep components small and named for what they are.
- Put the design system's :root tokens in \`src/index.css\` and reference them with
  var() everywhere. Global resets/base styles live there too.
- Add dependencies as the design needs them — run \`npm install <pkg>\` yourself
  (GSAP is already present; add e.g. \`@fontsource-variable/...\`, \`lenis\`, \`ogl\`,
  \`three\` when they genuinely earn their place). Keep the dependency set lean.
- Do NOT create an \`index.html\` artifact in the root for the design — the project's
  index.html + main.jsx already bootstrap React. Don't eject from the toolchain.
- The dev server (\`npm run dev\`) renders your work live; write code that runs.
- Add \`data-dezin-id\` to every top-level section or screen region so critique and
  markup tools can target the artifact precisely.`;

const IMAGE_GEN = `## Generated imagery

You may request real generated images. Where a photo/illustration genuinely helps,
emit \`<img src="" data-gen-prompt="a precise description of the image" alt="...">\`
(include width/height or CSS sizing). Dezin generates each one and rewrites the src
after you finish. Use sparingly and purposefully — never decorative filler, never
more than the layout needs. For icons/logos prefer inline SVG, not generated images.`;

const ASSET_SOURCING = `## Material sourcing

User material can arrive through attachments, saved references, paths, folders, URLs,
or ordinary brief text. Inspect and use any relevant material the user provides; do
not assume there are only upload and generated-image paths.

When the brief genuinely needs photos, video, product imagery, venue imagery, or
other real-world media and no usable material is available, search the web for
relevant free-to-use assets and save local copies into the project (for example
\`assets/\`, \`public/assets/\`, or \`src/assets/\`). Keep source/license notes when an
asset requires attribution.

Do not fake photographs, videos, product shots, venue shots, or human imagery with
SVG, DOM, CSS gradients, or vector doodles. If no suitable real media can be found
or used, use a minimal neutral placeholder instead of pretending it is real media.`;

const ASK_USER_QUESTION = `## AskUserQuestion

If one missing fact blocks a good artifact and cannot be inferred responsibly from
the current conversation, ask exactly one concise question with this control marker:

\`\`\`
<dezin-ask-user-question>
Your question here
</dezin-ask-user-question>
\`\`\`

Use AskUserQuestion only for blocking product/content choices, required credentials,
or missing local material the user explicitly referenced. Do not use it for ordinary
style taste, layout preference, or low-risk assumptions. Stop after the closing marker.`;

const FINAL_SUMMARY_BOUNDARY = `## Final summary boundary

End:

\`\`\`
<dezin-final-summary>
Sum
</dezin-final-summary>
\`\`\`

Put only the final user-facing summary inside. Earlier text: process. No logs/code fences. Stop after marker`;

function renderLibraryRouting(libraries: string[], mode: ComposeInput["mode"]): string | null {
  const available = Array.from(new Set(libraries.map((l) => l.trim()).filter(Boolean)));
  if (available.length === 0) return null;
  const standard = mode === "standard";
  return `## Implementation library routing

This skill may use these libraries when the brief genuinely needs them: ${available.join(", ")}.
Choose the smallest tool that fits the job; do not stack libraries for the same motion.

- CSS transitions / Web Animations API: simple hover states, opacity/transform reveals,
  one-off loops, and low-risk prototype motion.
- Motion for React (\`motion\`, import from \`motion/react\`): React component transitions,
  layout animations, presence/exit states, gestures, and viewport entry motion.${
    standard ? " Install it only when those React-specific primitives are useful." : " In single-file prototype mode, prefer CSS/WAAPI unless the skill explicitly provides a CDN-safe path."
  }
- GSAP: sequenced timelines, ScrollTrigger, pinned/scrubbed scroll sections, SVG/path
  choreography, magnetic interactions, and complex orchestration. In Standard mode GSAP
  is already available in the scaffold.
- Remotion: only for a video/timeline deliverable that should render frames or MP4s from
  React compositions. Do not use Remotion for an ordinary interactive landing page.
- WebGL / Three / OGL: only when a shader or real 3D scene is the centerpiece, not as
  background decoration.

Always respect \`prefers-reduced-motion\`, keep the no-motion state fully readable, and
make load/reveal animations fail-safe so content cannot remain hidden if JS or a library fails.`;
}

const SEP = "\n\n---\n\n";

export function renderDesignSystemBlock(ds: DesignSystem): string {
  return `## Active design system — ${ds.name}

This brand is AUTHORITATIVE for color, typography, spacing, and component rules.
Do not invent tokens outside this palette. Do not write raw hex outside the :root
block below — reference everything with var().

${ds.designMd}

### Tokens — paste this :root block verbatim into the artifact's <style>, then use var() everywhere:

\`\`\`css
${ds.tokensCss}
\`\`\``;
}

/** Build the full system prompt string. */
export function composeSystemPrompt(input: ComposeInput = {}): string {
  const parts: string[] = [INJECTION_RESISTANCE, IDENTITY_CHARTER, renderAntiSlopContract()];

  parts.push(input.mode === "standard" ? STANDARD_BUILD : PROTOTYPE_BUILD);

  if (input.designSystem) {
    parts.push(renderDesignSystemBlock(input.designSystem));
  } else if (input.direction) {
    parts.push(renderDirectionBlock(input.direction));
  }

  parts.push(FONTS);
  parts.push(ASSET_SOURCING);
  parts.push(ASK_USER_QUESTION);
  parts.push(FINAL_SUMMARY_BOUNDARY);

  if (input.craft && input.craft.trim()) {
    parts.push(
      `## Active craft references\n\nUniversal craft rules a competent designer applies. On conflict with the brand` +
        ` above, the brand wins for token VALUES; these rules still apply to letter-spacing, accent caps, anti-slop` +
        ` patterns, and state coverage.\n\n${input.craft.trim()}`,
    );
  }

  if (input.userInstructions && input.userInstructions.trim()) {
    parts.push(`## Custom instructions\n\n${input.userInstructions.trim()}`);
  }

  const libraryRouting = renderLibraryRouting(input.skill?.libraries ?? [], input.mode);
  if (libraryRouting) parts.push(libraryRouting);

  if (input.skill && input.skill.body.trim()) {
    parts.push(
      `## Active skill — ${input.skill.name}\n\nFollow this skill's workflow exactly.\n\n${input.skill.body.trim()}`,
    );
  }

  if (input.skill?.mode === "deck") {
    parts.push(DECK_FRAMEWORK);
  }

  if (input.imageGen) {
    parts.push(IMAGE_GEN);
  }

  parts.push(renderPreflight(input));
  parts.push(SELF_CRITIQUE);
  parts.push(ANTI_ROLEPLAY);
  return parts.join(SEP);
}

/**
 * Preflight gate (derivePreflight) — forces the agent to ground itself in the
 * skill's required shape, the brand tokens, and one specific idea BEFORE it writes,
 * so it doesn't regress into a generic hero+features+CTA skeleton.
 */
function renderPreflight(input: ComposeInput): string {
  const shape = input.skill?.body.trim()
    ? "the active skill's required structure — its sections, components, and any seed/scaffold it specifies — not a generic hero + features + CTA skeleton"
    : "the artifact shape this brief actually needs — not a generic hero + features + CTA skeleton";
  return `## Preflight — ground yourself before writing

Before emitting any markup, silently work through this (do NOT print it as prose):
1. Shape. Name ${shape}.
2. Tokens. Name the brand's authoritative bg / fg / accent / font tokens you will bind with var(); never raw hex outside :root.
3. Slop traps. Name the two or three anti-slop traps most likely for this brief and how you'll avoid each.
4. The specific idea. Name the one concrete, non-generic detail that makes THIS artifact real — real copy, a real product fact, a real interaction — not template filler.

Only after all four are answered, write the artifact in a single pass. If you cannot name step 4, the brief is underspecified: pick the most likely intent and commit to a specific take rather than hedging into generic output.`;
}
