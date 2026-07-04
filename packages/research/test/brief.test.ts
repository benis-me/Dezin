import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBriefMarkdown, parseBriefMarkdown } from "../src/brief.ts";
import type { ResearchBrief } from "../src/types.ts";

const brief: ResearchBrief = {
  what: "A landing page for an open-source design tool",
  audience: "developers evaluating the tool",
  goals: ["communicate the anti-slop value", "drive a star/try"],
  tone: ["calm", "confident"],
  mustHave: ["a real terminal demo"],
  mustAvoid: ["trust gradients", "emoji icons"],
  references: ["./refs/inspo.png"],
  skill: "landing",
  body: "The page should read as designed, not generated.\n\nLead with the linter.",
};

test("buildBriefMarkdown round-trips through parseBriefMarkdown", () => {
  const parsed = parseBriefMarkdown(buildBriefMarkdown(brief));
  assert.deepEqual(parsed, brief);
});

test("buildBriefMarkdown emits a frontmatter fence and prose body", () => {
  const md = buildBriefMarkdown(brief);
  assert.ok(md.startsWith("---\n"));
  assert.match(md, /skill: landing/);
  assert.match(md, /goals: \[/);
  assert.ok(md.trimEnd().endsWith("Lead with the linter."));
});

test("parseBriefMarkdown tolerates missing fields", () => {
  const parsed = parseBriefMarkdown("---\nwhat: A poster\n---\n\nJust a poster.");
  assert.equal(parsed.what, "A poster");
  assert.deepEqual(parsed.goals, []);
  assert.equal(parsed.skill, undefined);
  assert.equal(parsed.body, "Just a poster.");
});

test("parseBriefMarkdown handles quoted values containing commas", () => {
  const md = buildBriefMarkdown({ ...brief, what: "A page: bold, editorial" });
  assert.equal(parseBriefMarkdown(md).what, "A page: bold, editorial");
});
