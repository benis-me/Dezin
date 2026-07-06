import { test } from "node:test";
import assert from "node:assert/strict";
import { detectComputedFindings, type ComputedElement } from "../src/computed.ts";

/** Build a computed-element snapshot with sensible readable defaults; override per test. */
function el(overrides: Partial<ComputedElement> = {}): ComputedElement {
  const { style, ...rest } = overrides;
  return {
    selector: "p",
    tag: "p",
    text: "Some readable body copy that a person would actually read.",
    rect: { x: 0, y: 0, width: 480, height: 24 },
    ...rest,
    style: { fontSizePx: 16, ...(style ?? {}) },
  };
}

test("flags body text rendered below the 12px floor", () => {
  const findings = detectComputedFindings([
    el({ selector: "p.fine-print", text: "Terms and conditions apply to all plans.", style: { fontSizePx: 10 } }),
  ]);
  assert.ok(
    findings.some((f) => f.id === "tiny-text"),
    "10px body text should be flagged as tiny-text",
  );
});

test("does not flag body text at 14px", () => {
  const findings = detectComputedFindings([el({ text: "Perfectly readable body copy.", style: { fontSizePx: 14 } })]);
  assert.equal(
    findings.some((f) => f.id === "tiny-text"),
    false,
    "14px is above the floor and must not be flagged",
  );
});

test("ignores empty/textless elements for tiny-text", () => {
  const findings = detectComputedFindings([
    el({ selector: "span.dot", text: "", rect: { x: 0, y: 0, width: 6, height: 6 }, style: { fontSizePx: 8 } }),
  ]);
  assert.equal(
    findings.some((f) => f.id === "tiny-text"),
    false,
    "a textless decorative node is not a readability defect",
  );
});
