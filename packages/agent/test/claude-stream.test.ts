import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAskUserQuestion, extractFinalSummary, parseClaudeStream, parseClaudeLine } from "../src/index.ts";

test("parseClaudeLine surfaces live text + meaningful tool steps", () => {
  const line = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Building it. "},{"type":"tool_use","name":"Write","input":{"file_path":"src/App.tsx"}},{"type":"tool_use","name":"Bash","input":{"command":"npm install gsap"}},{"type":"tool_use","name":"Read","input":{"file_path":"x"}}]}}`;
  assert.deepEqual(parseClaudeLine(line), [
    { kind: "text", text: "Building it. " },
    { kind: "tool", name: "Write", summary: "Writing App.tsx" },
    { kind: "tool", name: "Bash", summary: "Running npm install gsap" },
    // Read is intentionally not surfaced (too noisy)
  ]);
  assert.deepEqual(parseClaudeLine(`{"type":"system"}`), []);
  assert.deepEqual(parseClaudeLine("not json"), []);
});

const SAMPLE = [
  `{"type":"system","subtype":"init","session_id":"sess-1","tools":["Write"]}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Writing the hero. "},{"type":"tool_use","name":"Write","input":{"file_path":"index.html","content":"<h1>hi</h1>"}}]},"session_id":"sess-1"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]},"session_id":"sess-1"}`,
  `{"type":"result","subtype":"success","result":"Wrote index.html.","is_error":false,"session_id":"sess-1"}`,
].join("\n");

test("parses assistant text, tool uses, result, session id", () => {
  const p = parseClaudeStream(SAMPLE);
  assert.equal(p.text, "Writing the hero. Done.");
  assert.equal(p.toolUses.length, 1);
  assert.equal(p.toolUses[0]?.name, "Write");
  assert.equal(p.toolUses[0]?.input.file_path, "index.html");
  assert.equal(p.result, "Wrote index.html.");
  assert.equal(p.isError, false);
  assert.equal(p.sessionId, "sess-1");
});

test("falls back to result text when there is no assistant text", () => {
  const stream = `{"type":"result","subtype":"success","result":"Only the result.","is_error":false}`;
  const p = parseClaudeStream(stream);
  assert.equal(p.text, "Only the result.");
});

test("flags error results", () => {
  const stream = `{"type":"result","subtype":"error_max_turns","result":"hit the turn limit","is_error":true}`;
  const p = parseClaudeStream(stream);
  assert.equal(p.isError, true);
  assert.equal(p.text, "hit the turn limit");
});

test("ignores blank lines and non-JSON noise", () => {
  const stream = [
    "",
    "  ",
    "not json at all",
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}`,
    "{ broken json",
  ].join("\n");
  const p = parseClaudeStream(stream);
  assert.equal(p.text, "ok");
  assert.equal(p.toolUses.length, 0);
});

test("accepts an array of lines too", () => {
  const p = parseClaudeStream([
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"a"}]}}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"b"}]}}`,
  ]);
  assert.equal(p.text, "ab");
});

test("extracts a Dezin ask-user-question marker and strips it from assistant text", () => {
  const out = extractAskUserQuestion(
    "I need one detail.\n<dezin-ask-user-question>\nWhich pricing tier should be featured?\n</dezin-ask-user-question>",
  );
  assert.equal(out.question, "Which pricing tier should be featured?");
  assert.equal(out.text, "I need one detail.");
});

test("extracts the forced Dezin final summary boundary", () => {
  const out = extractFinalSummary(
    "Drafted the layout and tightened spacing.\n<dezin-final-summary>\nDone. Updated the pricing page.\n</dezin-final-summary>",
  );
  assert.equal(out.hadBoundary, true);
  assert.equal(out.processText, "Drafted the layout and tightened spacing.");
  assert.equal(out.summaryText, "Done. Updated the pricing page.");
});

test("extractFinalSummary keeps indexes aligned when preceding text lowercases to multiple code points", () => {
  const out = extractFinalSummary(
    "Working with İstanbul copy.\n<DEZIN-FINAL-SUMMARY>\nDone. Updated the page.\n</DEZIN-FINAL-SUMMARY>",
  );
  assert.equal(out.hadBoundary, true);
  assert.equal(out.processText, "Working with İstanbul copy.");
  assert.equal(out.summaryText, "Done. Updated the page.");
});

test("falls back to treating unmarked text as summary only", () => {
  const out = extractFinalSummary("Done. Updated the pricing page.");
  assert.equal(out.hadBoundary, false);
  assert.equal(out.processText, "");
  assert.equal(out.summaryText, "Done. Updated the pricing page.");
});
