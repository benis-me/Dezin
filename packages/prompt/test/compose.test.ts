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

test("design system is injected as authoritative tokens, verbatim", () => {
  const p = composeSystemPrompt({ designSystem: modernMinimal });
  assert.ok(p.includes("AUTHORITATIVE"), "marks the brand authoritative");
  assert.ok(p.includes("--accent: #2563eb"), "pastes the verbatim token");
  assert.ok(p.includes(modernMinimal.designMd.split("\n")[0] ?? ""), "includes DESIGN.md");
  // ordering: design system after anti-slop, before anti-roleplay
  assert.ok(p.indexOf("Anti-AI-slop") < p.indexOf("Active design system"));
  assert.ok(p.indexOf("Active design system") < p.indexOf("Never fabricate"));
});

test("skill body and user instructions are included when provided", () => {
  const p = composeSystemPrompt({
    skill: { name: "frontend-design", body: "## Steps\n1. Read the seed template." },
    userInstructions: "Keep it under 3 sections.",
  });
  assert.ok(p.includes("Active skill — frontend-design"));
  assert.ok(p.includes("Read the seed template."));
  assert.ok(p.includes("Keep it under 3 sections."));
  // skill comes after design-system slot, before anti-roleplay
  assert.ok(p.indexOf("Active skill") < p.indexOf("Never fabricate"));
});

test("empty skill/instructions are omitted (no empty sections)", () => {
  const p = composeSystemPrompt({ skill: { name: "x", body: "   " }, userInstructions: "  " });
  assert.ok(!p.includes("Active skill"));
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

test("the deck framework is injected only for deck-mode skills", () => {
  const deck = composeSystemPrompt({
    designSystem: modernMinimal,
    skill: { name: "Slide deck", body: "make slides", mode: "deck" },
  });
  assert.match(deck, /Deck framework/);
  assert.match(deck, /1920/);
  assert.match(deck, /ArrowRight/); // keyboard nav
  assert.ok(deck.indexOf("Active skill") < deck.indexOf("Deck framework"));
  assert.ok(deck.indexOf("Deck framework") < deck.indexOf("Self-critique"));

  const notDeck = composeSystemPrompt({
    designSystem: modernMinimal,
    skill: { name: "Landing", body: "make a landing", mode: "prototype" },
  });
  assert.ok(!notDeck.includes("Deck framework"));
});

test("the self-critique gate is the final content section before anti-roleplay", () => {
  const p = composeSystemPrompt({
    designSystem: modernMinimal,
    skill: { name: "frontend-design", body: "build it" },
  });
  for (const dim of ["Philosophy", "Hierarchy", "Execution", "Specificity", "Restraint"]) {
    assert.ok(p.includes(dim), `critique mentions ${dim}`);
  }
  assert.match(p, /under 3\/5 is a regression/);
  assert.ok(p.indexOf("Active skill") < p.indexOf("Self-critique"));
  assert.ok(p.indexOf("Self-critique") < p.indexOf("Never fabricate"));
});

test("the charter embodies the specialist by artifact type", () => {
  const p = composeSystemPrompt();
  assert.match(p, /Embody the specialist/);
  assert.match(p, /slide designer/);
});

test("craft references are injected between the design system and the skill", () => {
  const p = composeSystemPrompt({
    designSystem: modernMinimal,
    craft: "### typography\n\nALL CAPS needs 0.06em tracking.",
    skill: { name: "frontend-design", body: "build it" },
  });
  assert.ok(p.includes("Active craft references"));
  assert.ok(p.includes("0.06em tracking"));
  assert.ok(p.indexOf("Active design system") < p.indexOf("Active craft references"));
  assert.ok(p.indexOf("Active craft references") < p.indexOf("Active skill"));
});

test("a full prompt stays lean (well under 15k tokens)", () => {
  const p = composeSystemPrompt({
    designSystem: modernMinimal,
    skill: { name: "frontend-design", body: "build a landing page" },
  });
  // ~4 chars/token heuristic; assert the whole thing is a few-KB, not tens of KB.
  assert.ok(p.length < 12_000, `prompt is ${p.length} chars; expected lean`);
});
