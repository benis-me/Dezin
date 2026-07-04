import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIntakePrompt, buildResearchPrompt } from "../src/prompts.ts";

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
  assert.match(prompt, /never hotlink/i);
  assert.match(prompt, /Never invent sources/);
  assert.match(prompt, /study developer-tool landings/);
  assert.match(prompt, /Cobalt/);
  assert.match(prompt, /do NOT write HTML/i);
});

test("research prompt still works without a skill or brand", () => {
  const prompt = buildResearchPrompt({ brief: "a resume site" });
  assert.match(prompt, /Phase: Research/);
  assert.doesNotMatch(prompt, /Research angles for/);
});
