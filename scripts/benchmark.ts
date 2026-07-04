/**
 * End-to-end quality benchmark. Runs real generations (the actual agent CLI)
 * against a fixture set, scores each artifact with the same anti-slop lint kernel
 * the product uses, and prints per-case + aggregate results. This is how we tell
 * whether "the output is actually good" rather than trusting the pipeline blindly.
 *
 *   node --experimental-strip-types --experimental-sqlite --no-warnings scripts/benchmark.ts
 *
 * Env: DEZIN_AGENT (default "claude"), DEZIN_MODEL, BENCH_N (limit cases),
 *      BENCH_ROUNDS (max repair rounds, default 2).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSystemPrompt } from "../packages/prompt/src/index.ts";
import { generateArtifact, ClaudeCodeRunner } from "../packages/agent/src/index.ts";
import { defaultRegistry } from "../packages/design/src/index.ts";
import { lintScore } from "../packages/quality/src/index.ts";
import { loadCraftSections } from "../packages/craft/src/index.ts";
import { loadSkills, findSkill, defaultSkillsDir } from "../packages/skills/src/index.ts";

interface Case {
  brief: string;
  ds: string;
  skill?: string;
}

const CASES: Case[] = [
  { brief: "A SaaS pricing page with three plans, the middle one recommended, monthly/annual toggle.", ds: "stripe", skill: "pricing-page" },
  { brief: "A developer-tool landing page: hero with a code sample, a feature grid, and one CTA.", ds: "vercel", skill: "landing" },
  { brief: "An analytics dashboard with four KPI cards, a line chart, and a recent-activity table.", ds: "linear", skill: "dashboard" },
  { brief: "A clean blog article page: title, byline, body with pull-quote, and a footer.", ds: "editorial", skill: "blog-post" },
  {
    brief:
      "An immersive product launch landing for 'Helios', a creative studio's new motion-design tool — make it feel alive.",
    ds: "framer",
    skill: "motion-landing",
  },
];

const allSkills = loadSkills();

const ONLY = process.env.BENCH_ONLY;
const selected = (ONLY ? CASES.filter((c) => `${c.skill ?? ""} ${c.ds} ${c.brief}`.includes(ONLY)) : CASES).slice(
  0,
  Number(process.env.BENCH_N ?? CASES.length),
);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 2);
const registry = defaultRegistry();
const runner = new ClaudeCodeRunner({
  command: process.env.DEZIN_AGENT || "claude",
  model: process.env.DEZIN_MODEL || undefined,
});

interface Row {
  ds: string;
  brief: string;
  score: number;
  passed: boolean;
  rounds: number;
  bytes: number;
  ms: number;
  error?: string;
}

console.log(`Dezin quality benchmark — ${selected.length} case(s), agent="${runner.command}", maxRounds=${ROUNDS}\n`);

const rows: Row[] = [];
for (const c of selected) {
  const ds = registry.get(c.ds) ?? registry.default();
  const skill = c.skill ? findSkill(allSkills, c.skill) : null;
  const craftSlugs = Array.from(new Set([...(skill?.craft ?? []), ...(ds.craft?.applies ?? [])]));
  const craft = loadCraftSections(craftSlugs);
  const systemPrompt = composeSystemPrompt({
    designSystem: ds,
    // Full catalog with the case's skill pinned — the agent reads it on demand.
    skills: allSkills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      mode: s.mode,
      libraries: s.libraries,
      pinned: c.skill ? s.id === c.skill : false,
    })),
    skillsDir: defaultSkillsDir(),
    craft: craft || undefined,
  });
  const dir = mkdtempSync(join(tmpdir(), "dezin-bench-"));
  process.stdout.write(`▶ ${(c.skill ?? c.ds).padEnd(14)} ${c.brief.slice(0, 52)}… `);
  const t0 = Date.now();
  try {
    const r = await generateArtifact({ runner, systemPrompt, brief: c.brief, projectDir: dir, lint: { maxRounds: ROUNDS } });
    const score = lintScore(r.findings);
    const row: Row = { ds: c.ds, brief: c.brief, score, passed: r.passed, rounds: r.rounds, bytes: r.html.length, ms: Date.now() - t0 };
    rows.push(row);
    console.log(`${row.passed ? "✓" : "✗"} score=${score} rounds=${r.rounds} ${(row.ms / 1000).toFixed(1)}s`);
  } catch (err) {
    rows.push({ ds: c.ds, brief: c.brief, score: 0, passed: false, rounds: 0, bytes: 0, ms: Date.now() - t0, error: String(err) });
    console.log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  }
}

const ok = rows.filter((r) => !r.error);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`\n── Summary ──`);
console.log(`cases:       ${rows.length}`);
console.log(`passed gate: ${rows.filter((r) => r.passed).length}/${rows.length}`);
console.log(`avg score:   ${avg(ok.map((r) => r.score)).toFixed(1)}/100`);
console.log(`avg rounds:  ${avg(ok.map((r) => r.rounds)).toFixed(2)}`);
console.log(`avg time:    ${(avg(ok.map((r) => r.ms)) / 1000).toFixed(1)}s`);

const failed = rows.filter((r) => r.error || !r.passed);
if (failed.length) {
  console.log(`\nNeeds attention:`);
  for (const r of failed) console.log(`  ${r.ds}: ${r.error ? `error — ${r.error}` : `score ${r.score}, did not pass`}`);
}

// Non-zero exit if anything failed the gate, so CI can catch regressions.
process.exit(rows.some((r) => !r.passed) ? 1 : 0);
