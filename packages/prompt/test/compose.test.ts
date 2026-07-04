import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSystemPrompt, findDirection } from "../src/index.ts";
import { modernMinimal } from "../../design/src/index.ts";
import { slopRules } from "../../quality/src/index.ts";

test("minimal prompt has the fixed layers in order, bookended correctly", () => {
  const p = composeSystemPrompt();
  // injection resistance pinned first
  assert.ok(p.startsWith("# Trust boundary"), "injection resistance first");
  // anti-roleplay pinned last
  assert.ok(p.trimEnd().endsWith("they did not."), "anti-roleplay last");
  // charter before anti-slop
  assert.ok(p.indexOf("expert designer") < p.indexOf("Anti-AI-slop contract"));
});

test("anti-slop layer is generated from the linter's own rule lists (single source of truth)", () => {
  const p = composeSystemPrompt();
  // every banned indigo hex from @dezin/quality appears in the prompt
  for (const hex of slopRules.AI_DEFAULT_INDIGO) {
    assert.ok(p.includes(hex), `prompt should mention banned hex ${hex}`);
  }
});

test("generated artifacts use Dezin target anchors", () => {
  const prototypePrompt = composeSystemPrompt({ mode: "prototype" });
  assert.match(prototypePrompt, /data-dezin-id/);
  assert.match(prototypePrompt, /markup tools can target/);

  const standardPrompt = composeSystemPrompt({ mode: "standard" });
  assert.match(standardPrompt, /data-dezin-id/);
});

test("asset guidance is flexible and forbids fake drawn media", () => {
  const p = composeSystemPrompt({ mode: "standard" });
  assert.match(p, /Material sourcing/);
  assert.match(p, /paths, folders, URLs/);
  assert.match(p, /search the web for\s+relevant free-to-use assets/);
  assert.match(p, /Do not fake photographs, videos, product shots/);
  assert.match(p, /minimal neutral placeholder/);
});

test("prompt exposes the Dezin ask-user-question control marker", () => {
  const p = composeSystemPrompt({ mode: "standard" });
  assert.match(p, /AskUserQuestion/);
  assert.match(p, /<dezin-ask-user-question>/);
  assert.match(p, /Stop after the closing marker/);
});

test("prompt forces a Dezin final-summary boundary", () => {
  const p = composeSystemPrompt({ mode: "standard" });
  assert.match(p, /Final summary boundary/);
  assert.match(p, /<dezin-final-summary>/);
  assert.match(p, /<\/dezin-final-summary>/);
  assert.match(p, /Put only the final user-facing summary inside/);
});

test("design system is injected as authoritative tokens, verbatim", () => {
  const p = composeSystemPrompt({ designSystem: modernMinimal });
  assert.ok(p.includes("AUTHORITATIVE"), "marks the brand authoritative");
  assert.ok(p.includes("--accent: #2563eb"), "pastes the verbatim token");
  assert.ok(p.includes(modernMinimal.designMd.split("\n")[0] ?? ""), "includes DESIGN.md");
  // ordering: design system after anti-slop, before anti-roleplay
  assert.ok(p.indexOf("Anti-AI-slop") < p.indexOf("Active design system"));
  assert.ok(p.indexOf("Active design system") < p.indexOf("Never fabricate"));
});

// --- Progressive-disclosure skills ---------------------------------------
// Skills are not force-injected. The composer exposes a CATALOG (name +
// description + when-to-use + an on-demand path to the full playbook); the
// agent judges which skill(s) fit the brief and reads the SKILL.md itself.

test("the skill catalog lists skills for on-demand loading; bodies are not injected", () => {
  const p = composeSystemPrompt({
    skills: [
      { id: "frontend-design", name: "Frontend design", description: "A single polished page.", triggers: ["landing", "website"] },
      { id: "deck", name: "Slide deck", description: "A 16:9 presentation.", triggers: ["slides"] },
    ],
    skillsDir: "/skills",
    userInstructions: "Keep it under 3 sections.",
  });
  assert.match(p, /Available skills/, "catalog header present");
  assert.match(p, /on demand/i, "instructs on-demand loading");
  assert.match(p, /Frontend design/);
  assert.match(p, /`frontend-design`/);
  assert.match(p, /A single polished page\./, "description shown");
  assert.match(p, /use when:.*landing/, "trigger hints shown");
  assert.match(p, /\/skills\/frontend-design\/SKILL\.md/, "on-demand playbook path shown");
  assert.match(p, /Slide deck/, "all skills catalogued, not just one");
  assert.ok(p.includes("Keep it under 3 sections."), "user instructions included");
  assert.ok(p.indexOf("Available skills") < p.indexOf("Never fabricate"), "catalog before anti-roleplay");
});

test("a pinned skill is flagged as preferred, but the whole catalog stays visible", () => {
  const p = composeSystemPrompt({
    skills: [
      { id: "frontend-design", name: "Frontend design", description: "x", pinned: true },
      { id: "deck", name: "Slide deck", description: "y" },
    ],
    skillsDir: "/s",
  });
  assert.match(p, /pinned for this project/i, "the pinned skill is flagged");
  assert.match(p, /Slide deck/, "other skills are still offered, not hidden");
});

test("library routing is the union across catalogued skills, omitted when none declare libraries", () => {
  const p = composeSystemPrompt({
    mode: "standard",
    skills: [
      { id: "motion-landing", name: "Motion landing", description: "x", libraries: ["motion", "gsap"] },
      { id: "video", name: "Video", description: "y", libraries: ["remotion"] },
    ],
  });
  assert.match(p, /Implementation library routing/);
  assert.match(p, /motion\/react/);
  assert.match(p, /ScrollTrigger/);
  assert.match(p, /only for a video\/timeline deliverable/);
  assert.ok(p.indexOf("Implementation library routing") < p.indexOf("Available skills"));

  const plain = composeSystemPrompt({ skills: [{ id: "x", name: "X", description: "d" }] });
  assert.ok(!plain.includes("Implementation library routing"));
});

test("empty skills and instructions are omitted (no empty sections)", () => {
  const p = composeSystemPrompt({ skills: [], userInstructions: "  " });
  assert.ok(!p.includes("Available skills"));
  assert.ok(!p.includes("Custom instructions"));
});

test("a direction guides when no design system is active; a brand takes precedence", () => {
  const dir = findDirection("modern-minimal")!;
  const withDir = composeSystemPrompt({ direction: dir });
  assert.ok(withDir.includes("Visual direction"));
  assert.ok(withDir.includes("--accent:"));
  const both = composeSystemPrompt({ designSystem: modernMinimal, direction: dir });
  assert.ok(both.includes("Active design system"));
  assert.ok(!both.includes("Visual direction"));
});

test("the deck scaffold is NOT inlined — it lives in the deck playbook, read on demand", () => {
  const p = composeSystemPrompt({
    designSystem: modernMinimal,
    skills: [{ id: "deck", name: "Slide deck", description: "A 16:9 deck.", mode: "deck" }],
    skillsDir: "/s",
  });
  assert.match(p, /Slide deck/, "deck offered in the catalog");
  assert.match(p, /\/s\/deck\/SKILL\.md/, "with its on-demand path");
  assert.ok(!p.includes("Deck framework"), "scaffold not force-injected");
  assert.ok(!p.includes("ArrowRight"), "scaffold body not inlined into every prompt");
});

test("the self-critique gate is the final content section before anti-roleplay", () => {
  const p = composeSystemPrompt({
    designSystem: modernMinimal,
    skills: [{ id: "frontend-design", name: "Frontend design", description: "build it" }],
  });
  for (const dim of ["Philosophy", "Hierarchy", "Execution", "Specificity", "Restraint"]) {
    assert.ok(p.includes(dim), `critique mentions ${dim}`);
  }
  assert.match(p, /under 3\/5 is a regression/);
  assert.ok(p.indexOf("Available skills") < p.indexOf("Self-critique"));
  assert.ok(p.indexOf("Self-critique") < p.indexOf("Never fabricate"));
});

test("the charter embodies the specialist by artifact type", () => {
  const p = composeSystemPrompt();
  assert.match(p, /Embody the specialist/);
  assert.match(p, /slide designer/);
});

test("craft references are injected between the design system and the skill catalog", () => {
  const p = composeSystemPrompt({
    designSystem: modernMinimal,
    craft: "### typography\n\nALL CAPS needs 0.06em tracking.",
    skills: [{ id: "frontend-design", name: "Frontend design", description: "build it" }],
  });
  assert.ok(p.includes("Active craft references"));
  assert.ok(p.includes("0.06em tracking"));
  assert.ok(p.indexOf("Active design system") < p.indexOf("Active craft references"));
  assert.ok(p.indexOf("Active craft references") < p.indexOf("Available skills"));
});

test("the whole skill catalog stays lean — a cheap line per skill, not 21 bodies", () => {
  const many = Array.from({ length: 21 }, (_, i) => ({
    id: `skill-${i}`,
    name: `Skill ${i}`,
    description: "A reasonably descriptive one-line summary of what this skill produces.",
    triggers: ["one", "two", "three", "four"],
  }));
  const base = composeSystemPrompt({ designSystem: modernMinimal });
  const withCatalog = composeSystemPrompt({ designSystem: modernMinimal, skills: many, skillsDir: "/skills" });
  // The whole point of progressive disclosure: each skill costs a catalog line,
  // not its full body. 21 skills should add only a few KB, ~a couple hundred chars each.
  const perSkill = (withCatalog.length - base.length) / many.length;
  assert.ok(perSkill < 260, `catalog costs ${perSkill.toFixed(0)} chars/skill; expected a lean line`);
  assert.ok(withCatalog.length < 18_000, `full prompt is ${withCatalog.length} chars; expected a few KB`);
});
