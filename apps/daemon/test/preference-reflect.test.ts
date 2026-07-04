import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreferenceReflectionPrompt, cleanPreferenceSuggestion } from "../src/preference-reflect.ts";

test("buildPreferenceReflectionPrompt summarizes feedback and forbids invention", () => {
  const prompt = buildPreferenceReflectionPrompt(
    [
      { verdict: "up", skill: "landing" },
      { verdict: "down", gap: "tone", skill: "landing" },
    ],
    "One accent only.",
  );
  assert.match(prompt, /KEPT.*\[landing\]/);
  assert.match(prompt, /REJECTED \(off: tone\) \[landing\]/);
  assert.match(prompt, /One accent only\./); // current instructions echoed
  assert.match(prompt, /invent nothing/i);
  assert.match(prompt, /ONLY the lines/);
});

test("cleanPreferenceSuggestion keeps only bullet lines and strips fences", () => {
  const raw = "Here are prefs:\n- Prefer whitespace\n```\n- In a fence\n```\nsome noise\n- Restrained accent\n";
  assert.equal(cleanPreferenceSuggestion(raw), "- Prefer whitespace\n- In a fence\n- Restrained accent");
});

test("cleanPreferenceSuggestion caps at 6 lines", () => {
  const raw = Array.from({ length: 9 }, (_, i) => `- pref ${i}`).join("\n");
  assert.equal(cleanPreferenceSuggestion(raw).split("\n").length, 6);
});
