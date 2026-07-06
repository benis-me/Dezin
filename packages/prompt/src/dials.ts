/**
 * Design dials — a small parameter abstraction distilled from leonxlnx/taste-skill.
 *
 * Instead of letting the model "choose whatever feels premium", the brief is mapped
 * to three explicit 1–10 dials that cascade to every downstream decision. Injected
 * into the system prompt as the TARGET (not a suggestion), they remove the model's
 * freedom to reach for a generic default. Pure + heuristic — no model call.
 */

export interface Dials {
  /** 1 = symmetric grids / restraint … 10 = asymmetric, expressive, unexpected. */
  variance: number;
  /** 1 = near-static … 10 = choreographed, cinematic (always behind reduced-motion). */
  motion: number;
  /** 1 = gallery-airy whitespace … 10 = information-first, compact, data-dense. */
  density: number;
}

const clamp = (n: number): number => Math.max(1, Math.min(10, Math.round(n)));

const RE = {
  minimal: /\b(minimal|minimalist|calm|clean|editorial|refined|elegant|understated|quiet|serene|spare)\b/,
  playful: /\b(playful|fun|experimental|awwwards|bold|vibrant|expressive|creative|whimsical|maximal|maximalist|daring)\b/,
  dense: /\b(dashboard|admin|analytics|console|data|metrics|table|report|reporting|monitoring|dense|terminal|trading)\b/,
  trust: /\b(trust|regulated|enterprise|bank|banking|finance|financial|fintech|government|gov|medical|health|clinical|legal|insurance|security|compliance|governmental)\b/,
};

/** Infer the three dials from the brief text. Later, more-specific rules override earlier ones. */
export function inferDials(brief: string): Dials {
  const t = (brief ?? "").toLowerCase();
  let variance = 5;
  let motion = 4;
  let density = 5;

  if (RE.minimal.test(t)) {
    variance = 5;
    motion = 3;
    density = 3;
  }
  if (RE.playful.test(t)) {
    variance = 9;
    motion = 8;
    density = 4;
  }
  // A data surface is dense regardless of the aesthetic vibe, and calmer in motion.
  if (RE.dense.test(t)) {
    density = 9;
    motion = Math.min(motion, 4);
  }
  // Trust/regulated caps expressiveness — it wins over "playful" when both appear.
  if (RE.trust.test(t)) {
    variance = Math.min(variance, 4);
    motion = Math.min(motion, 3);
    density = Math.max(density, 5);
  }

  return { variance: clamp(variance), motion: clamp(motion), density: clamp(density) };
}

function band(n: number, low: string, mid: string, high: string): string {
  return n <= 3 ? low : n >= 7 ? high : mid;
}

/** Render the dials as a prompt block: explicit values + how each cascades. */
export function renderDialsBlock(d: Dials): string {
  const variance = band(
    d.variance,
    "symmetric grids, aligned rhythm, restraint — no decorative asymmetry",
    "a mostly regular grid with one or two intentional breaks",
    "asymmetry earns its place — offset grids, overlap, unexpected scale jumps",
  );
  const motion = band(
    d.motion,
    "near-static; at most a single deliberate transition",
    "purposeful entrance/hover motion, nothing gratuitous",
    "choreographed motion — sequenced reveals, scroll interplay — as meaning, not decoration",
  );
  const density = band(
    d.density,
    "generous whitespace; one idea per view; gallery-airy",
    "balanced spacing; grouped, scannable sections",
    "information-first; compact, tabular, data-dense; every pixel works",
  );

  return `## Design dials (inferred from the brief)

Three global settings drive every downstream decision. They were inferred from the brief — treat them as the TARGET you are hitting, not a loose suggestion.

- **Visual variance ${d.variance}/10** — ${variance}.
- **Motion intensity ${d.motion}/10** — ${motion}.
- **Visual density ${d.density}/10** — ${density}.

Let them cascade consistently across the whole artifact. Keep all motion behind \`prefers-reduced-motion\`, and never let a high dial become an excuse for slop — a bold variance is still composed, a dense layout is still legible.`;
}
