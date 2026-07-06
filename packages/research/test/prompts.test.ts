import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIntakePrompt, buildResearchPrompt } from "../src/prompts.ts";
import { buildVisualResearchPrompt } from "../src/index.ts";

test("intake prompt lists the skill catalog and forbids designing", () => {
  const prompt = buildIntakePrompt({
    brief: "a pricing page for my saas",
    skills: [
      { id: "pricing-page", name: "Pricing page", description: "A pricing page with real tiers." },
      { id: "landing", name: "Landing page", description: "A marketing landing." },
    ],
  });
  assert.match(prompt, /Phase: Intake/);
  assert.match(prompt, /`pricing-page` — Pricing page/);
  assert.match(prompt, /research\/brief\.md/);
  assert.match(prompt, /do NOT design/i);
  assert.match(prompt, /a pricing page for my saas/);
});

test("research prompt demands web research, local assets, provenance, and directions", () => {
  const prompt = buildResearchPrompt({
    brief: "a landing page for an open-source design tool",
    skill: { id: "landing", name: "Landing page", researchAngles: ["study developer-tool landings"] },
    designSystemName: "Cobalt",
  });
  assert.match(prompt, /Phase: Research/);
  assert.match(prompt, /web search/i);
  assert.match(prompt, /Competitive & comparative/);
  assert.match(prompt, /Audience & user research/);
  assert.match(prompt, /research\/assets\//);
  assert.match(prompt, /research\/sources\.json/);
  assert.match(prompt, /research\/directions\//);
  assert.match(prompt, /never\s+hotlink/i);
  assert.match(prompt, /Never invent sources/);
  assert.match(prompt, /study developer-tool landings/);
  assert.match(prompt, /Cobalt/);
  assert.match(prompt, /do NOT write HTML/i);
  // Competitor scope is anchored on the artifact's SHAPE, not the broad domain — and
  // adjacent categories are secondary context, so research doesn't drift (e.g. IDEs for a chat).
  assert.match(prompt, /artifact's SHAPE/);
  assert.match(prompt, /secondary CONTEXT/);
  assert.match(prompt, /drag the design toward the wrong shape/);
  // Assets are curated: real product UI only — no marketing heroes, stock, or portraits.
  assert.match(prompt, /product-UI screenshot/i);
  assert.match(prompt, /people\/portraits/);
  assert.match(prompt, /Do NOT save/i);
  assert.match(prompt, /marketing hero shots/i);
  assert.match(prompt, /DELETE anything that does not/);
});

test("research prompt still works without a skill or brand", () => {
  const prompt = buildResearchPrompt({ brief: "a resume site" });
  assert.match(prompt, /Phase: Research/);
  assert.doesNotMatch(prompt, /Research angles for/);
});

test("buildVisualResearchPrompt targets design sites, best-effort real + fallback, writes .research/visual", () => {
  const p = buildVisualResearchPrompt({ brief: "a fintech dashboard" });
  assert.match(p, /dribbble/i);
  assert.match(p, /behance/i);
  assert.match(p, /awwwards/i);
  assert.match(p, /mobbin/i);
  assert.match(p, /\.research\/visual\/assets/);
  assert.match(p, /\.research\/visual\/visual\.md/);
  assert.match(p, /reachable|blocked|fall ?back/i);
  assert.match(p, /download/i);
  assert.match(p, /real (product )?UI|not marketing/i);
});

test("buildResearchPrompt hardens authority: prefer primary, cite claims, label assumptions", () => {
  const p = buildResearchPrompt({ brief: "a pricing page" });
  assert.match(p, /primary|authoritative|first-party/i);
  assert.match(p, /assumption/i);
  assert.match(p, /cite|traces to|sources\.json/i);
});
