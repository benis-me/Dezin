import { test } from "node:test";
import assert from "node:assert/strict";
import { rankSkills, scoreSkill, selectSkill } from "../src/select.ts";
import type { SkillInfo } from "../src/types.ts";

function skill(id: string, name: string, triggers: string[], description = ""): SkillInfo {
  return { id, name, description, mode: "prototype", craft: [], triggers, libraries: [], designSystem: true, body: "" };
}

const catalog: SkillInfo[] = [
  skill("landing", "Landing page", ["landing page", "product launch", "waitlist"], "A marketing landing page."),
  skill("pricing-page", "Pricing page", ["pricing", "pricing page", "tiers"], "A pricing page with real tiers."),
  skill("deck", "Deck", ["deck", "slides", "presentation", "pitch"], "An investor or conference slide deck."),
  skill("dashboard", "Dashboard", ["dashboard", "admin", "analytics"], "An analytics dashboard."),
];

test("selectSkill matches a trigger phrase in the brief", () => {
  assert.equal(selectSkill("A pricing page for my SaaS with three tiers", catalog)?.id, "pricing-page");
  assert.equal(selectSkill("a landing page for a product launch", catalog)?.id, "landing");
  assert.equal(selectSkill("an investor pitch deck for series A", catalog)?.id, "deck");
});

test("multi-word trigger phrases outweigh incidental overlap", () => {
  assert.equal(selectSkill("design a pricing page", catalog)?.id, "pricing-page");
});

test("rankSkills orders by match strength and is stable", () => {
  const ranked = rankSkills("a landing page waitlist for a product launch", catalog);
  assert.equal(ranked[0]!.skill.id, "landing");
  assert.ok(ranked[0]!.score > ranked[1]!.score);
});

test("selectSkill returns null when no skill has any signal", () => {
  assert.equal(selectSkill("xyzzy foobar qux", catalog), null);
  assert.equal(selectSkill("", catalog), null);
});

test("scoreSkill is zero when nothing matches", () => {
  assert.equal(scoreSkill("a totally unrelated request", skill("x", "X", ["nope"], "none")), 0);
});
