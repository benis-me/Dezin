import { test } from "node:test";
import assert from "node:assert/strict";
import { improvementKey, freshImprovements } from "../src/run-handler.ts";
import type { QualityFinding } from "../../../packages/core/src/index.ts";

const imp = (selector: string | undefined, message: string): QualityFinding => ({
  severity: "P2",
  id: "visual-improve-1",
  message,
  fix: "x",
  selector,
});

test("improvementKey is stable per selector+message and distinct across them", () => {
  assert.equal(improvementKey(imp(".send", "Drop the arrow")), improvementKey(imp(".send", "drop the  arrow")));
  assert.notEqual(improvementKey(imp(".send", "Drop the arrow")), improvementKey(imp(".send", "Tighten spacing")));
  assert.notEqual(improvementKey(imp(".send", "Drop the arrow")), improvementKey(imp(".sidebar", "Drop the arrow")));
});

test("freshImprovements drops a suggestion the agent keeps not applying (verify-applied convergence)", () => {
  const history = new Map<string, number>();
  const A = imp(".send", "Drop the redundant arrow icon.");
  // Round 1: fresh → sent.
  assert.deepEqual(freshImprovements([A], history).map((f) => f.selector), [".send"]);
  // Round 2: A recurs unchanged (was not applied) → no longer fresh → dropped → ceiling converges.
  assert.deepEqual(freshImprovements([A], history), []);
  // A genuinely NEW suggestion later is still fresh even though A is stuck.
  const B = imp(".composer", "Reduce the hint density.");
  assert.deepEqual(freshImprovements([A, B], history).map((f) => f.selector), [".composer"]);
});
