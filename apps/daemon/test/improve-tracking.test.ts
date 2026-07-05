import { test } from "node:test";
import assert from "node:assert/strict";
import { recurKey, freshFindings } from "../src/run-handler.ts";
import type { QualityFinding } from "../../../packages/core/src/index.ts";

const find = (selector: string | undefined, message: string, severity: "P1" | "P2" = "P2"): QualityFinding => ({
  severity,
  id: severity === "P2" ? "visual-improve-1" : "visual-ai-review-1",
  message,
  fix: "x",
  selector,
});

test("recurKey anchors on the selector (the critic rephrases the prose each round)", () => {
  // Same element, different wording → SAME key (so a rephrased recurrence is still caught).
  assert.equal(recurKey(find(".send", "Send has a redundant arrow icon")), recurKey(find(".send", "The send button shows both text and an arrow")));
  // Different element → different key.
  assert.notEqual(recurKey(find(".send", "x")), recurKey(find(".sidebar", "x")));
  // No selector → falls back to a normalized message.
  assert.notEqual(recurKey(find(undefined, "copy button missing")), recurKey(find(undefined, "contrast too low")));
});

test("freshFindings drops a suggestion after it is re-raised (limit 1) and converges", () => {
  const history = new Map<string, number>();
  const A = find(".send", "Drop the redundant arrow.");
  assert.deepEqual(freshFindings([A], history, 1).map((f) => f.selector), [".send"]); // round 1: sent
  assert.deepEqual(freshFindings([A], history, 1), []); // round 2: recurs (not applied) → dropped
});

test("freshFindings gives up on a defect the model can't fix after DEFECT_RECUR_LIMIT (2) tries", () => {
  const history = new Map<string, number>();
  const D = find("[data-dezin-id=\"thread-main\"]", "Thread loads at the wrong scroll position.", "P1");
  // Retried twice (the model gets two attempts)...
  assert.equal(freshFindings([D], history, 2).length, 1);
  assert.equal(freshFindings([D], history, 2).length, 1);
  // ...then given up on the third recurrence — no more spinning.
  assert.equal(freshFindings([D], history, 2).length, 0);
});

test("a genuinely new finding stays fresh even when another on a different element is stuck", () => {
  const history = new Map<string, number>();
  const A = find(".send", "arrow");
  freshFindings([A], history, 1); // A used up
  const B = find(".composer", "reduce hint density");
  assert.deepEqual(freshFindings([A, B], history, 1).map((f) => f.selector), [".composer"]);
});
