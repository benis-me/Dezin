import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSkills, findSkill, defaultSkillsDir } from "../src/index.ts";

test("loads all bundled skills with correct fields", () => {
  const skills = loadSkills(defaultSkillsDir());
  assert.equal(skills.length, 21, `expected 21 skills, got ${skills.map((s) => s.id).join(",")}`);
  // a few key skills are present
  for (const id of ["frontend-design", "deck", "pricing-page", "blog-post", "faq", "motion-landing", "component-library", "design-tokens", "settings-page", "status-page", "onboarding-flow"]) {
    assert.ok(findSkill(skills, id), `missing skill ${id}`);
  }
  for (const s of skills) {
    assert.ok(s.name.length > 0, `${s.id} has a name`);
    assert.ok(s.description.length > 0, `${s.id} has a description`);
    assert.ok(Array.isArray(s.craft) && s.craft.length > 0, `${s.id} has craft`);
    assert.ok(Array.isArray(s.triggers) && s.triggers.length > 0, `${s.id} has triggers`);
    assert.ok(s.body.length > 50, `${s.id} has a real body`);
  }
});

test("modes and designSystem flags are parsed per skill", () => {
  const skills = loadSkills();
  assert.equal(findSkill(skills, "frontend-design")?.mode, "prototype");
  assert.equal(findSkill(skills, "doc")?.mode, "document");
  assert.equal(findSkill(skills, "deck")?.mode, "deck");
  assert.equal(findSkill(skills, "pricing-page")?.mode, "prototype");
  assert.equal(findSkill(skills, "design-md")?.mode, "design-system");
  // design-md PRODUCES a design system, so it does not consume one
  assert.equal(findSkill(skills, "design-md")?.designSystem, false);
  assert.equal(findSkill(skills, "dashboard")?.designSystem, true);
  assert.deepEqual(findSkill(skills, "motion-landing")?.libraries.slice(0, 5), ["css", "waapi", "motion", "gsap", "remotion"]);
  // anti-ai-slop is in the craft of the page-building skills
  assert.ok(findSkill(skills, "landing")?.craft.includes("anti-ai-slop"));
});

test("findSkill returns null for an unknown id", () => {
  const skills = loadSkills();
  assert.equal(findSkill(skills, "nope"), null);
});

test("loadSkills on a missing directory returns []", () => {
  assert.deepEqual(loadSkills("/no/such/dir/anywhere"), []);
});
