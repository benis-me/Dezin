import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResearchActivity } from "../src/index.ts";

/** A stream-json assistant line carrying the given content blocks. */
function line(content: unknown[]): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
}

test("surfaces web searches, fetches, downloads, writes, and reasoning notes", () => {
  assert.deepEqual(parseResearchActivity(line([{ type: "tool_use", name: "WebSearch", input: { query: "deep work time-blocking apps" } }])), [
    { kind: "search", text: "deep work time-blocking apps" },
  ]);
  assert.deepEqual(parseResearchActivity(line([{ type: "tool_use", name: "WebFetch", input: { url: "https://www.sunsama.com/pricing" } }])), [
    { kind: "fetch", text: "sunsama.com" },
  ]);
  assert.deepEqual(parseResearchActivity(line([{ type: "tool_use", name: "Bash", input: { command: "curl -sL https://stripe.com/img/hero.png -o assets/stripe-hero.png" } }])), [
    { kind: "download", text: "hero.png" },
  ]);
  assert.deepEqual(parseResearchActivity(line([{ type: "tool_use", name: "Write", input: { file_path: "/proj/.research/research.md" } }])), [
    { kind: "write", text: "research.md" },
  ]);
  const note = parseResearchActivity(line([{ type: "text", text: "Comparing Sunsama and Reclaim on onboarding.\nNext I'll check pricing." }]));
  assert.equal(note[0]?.kind, "note");
  assert.match(note[0]!.text, /Comparing Sunsama and Reclaim/);
  assert.ok(!note[0]!.text.includes("\n"), "note is a single line");
});

test("ignores noise — reads, non-assistant events, and non-JSON", () => {
  assert.deepEqual(parseResearchActivity(line([{ type: "tool_use", name: "Read", input: { file_path: "x" } }])), []);
  assert.deepEqual(parseResearchActivity(line([{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }])), []);
  assert.deepEqual(parseResearchActivity(JSON.stringify({ type: "result", result: "done" })), []);
  assert.deepEqual(parseResearchActivity("not json at all"), []);
  assert.deepEqual(parseResearchActivity(""), []);
});

test("handles several blocks in one line, in order", () => {
  const acts = parseResearchActivity(line([
    { type: "text", text: "Downloading references." },
    { type: "tool_use", name: "WebSearch", input: { query: "calm productivity landing pages" } },
  ]));
  assert.equal(acts.length, 2);
  assert.equal(acts[0]!.kind, "note");
  assert.equal(acts[1]!.kind, "search");
});
