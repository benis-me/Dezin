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

// ── low-contrast (WCAG AA) ────────────────────────────────────────────────────
test("flags near-invisible body text as a P0 contrast defect", () => {
  const findings = detectComputedFindings([
    el({ selector: "p.muted", style: { color: "rgb(187, 187, 187)", effectiveBg: "rgb(255, 255, 255)", fontSizePx: 16 } }),
  ]);
  const lc = findings.find((f) => f.id === "low-contrast");
  assert.ok(lc, "#bbb on white (~1.9:1) must fail AA");
  assert.equal(lc!.severity, "P0", "below ~2:1 is effectively unreadable → P0");
});

test("passes strong body contrast", () => {
  const findings = detectComputedFindings([
    el({ style: { color: "rgb(17, 17, 17)", effectiveBg: "rgb(255, 255, 255)", fontSizePx: 16 } }),
  ]);
  assert.equal(findings.some((f) => f.id === "low-contrast"), false);
});

test("applies the large-text threshold: gray fails as body but passes as a heading", () => {
  const asBody = detectComputedFindings([
    el({ selector: "p", style: { color: "rgb(136, 136, 136)", effectiveBg: "rgb(255, 255, 255)", fontSizePx: 16 } }),
  ]);
  assert.ok(asBody.some((f) => f.id === "low-contrast"), "#888 body (~3.5:1) fails the 4.5:1 rule");
  const asHeading = detectComputedFindings([
    el({ selector: "h2", tag: "h2", style: { color: "rgb(136, 136, 136)", effectiveBg: "rgb(255, 255, 255)", fontSizePx: 32 } }),
  ]);
  assert.equal(asHeading.some((f) => f.id === "low-contrast"), false, "#888 large (~3.5:1) clears the 3:1 rule");
});

test("composites translucent text over its background before judging contrast", () => {
  const findings = detectComputedFindings([
    el({ style: { color: "rgba(0, 0, 0, 0.3)", effectiveBg: "rgb(255, 255, 255)", fontSizePx: 16 } }),
  ]);
  assert.ok(findings.some((f) => f.id === "low-contrast"), "30%-alpha black on white is pale gray → fails");
});

test("skips contrast when the effective background is unresolved (translucent/image)", () => {
  const findings = detectComputedFindings([
    el({ style: { color: "rgb(187, 187, 187)", effectiveBg: "rgba(0, 0, 0, 0)", fontSizePx: 16 } }),
  ]);
  assert.equal(findings.some((f) => f.id === "low-contrast"), false, "no opaque backdrop → not provable, don't file");
});

// ── gray-on-color ─────────────────────────────────────────────────────────────
test("flags gray text sitting on a chromatic surface", () => {
  const findings = detectComputedFindings([
    el({ selector: "p.on-brand", style: { color: "rgb(120, 120, 120)", effectiveBg: "rgb(30, 80, 160)", fontSizePx: 16 } }),
  ]);
  assert.ok(findings.some((f) => f.id === "gray-on-color"));
});

test("does not flag gray-on-color for gray text on a neutral background", () => {
  const findings = detectComputedFindings([
    el({ style: { color: "rgb(120, 120, 120)", effectiveBg: "rgb(255, 255, 255)", fontSizePx: 16 } }),
  ]);
  assert.equal(findings.some((f) => f.id === "gray-on-color"), false);
});

// ── tight-leading ─────────────────────────────────────────────────────────────
test("flags body copy with line-height below 1.3", () => {
  const findings = detectComputedFindings([
    el({ text: "A long paragraph of body copy set far too tightly to read comfortably at all.", style: { fontSizePx: 16, lineHeightPx: 18 } }),
  ]);
  assert.ok(findings.some((f) => f.id === "tight-leading"));
});

test("does not flag comfortable leading, or tight leading on large display type", () => {
  const comfy = detectComputedFindings([el({ text: "A long paragraph of body copy with room to breathe between its lines.", style: { fontSizePx: 16, lineHeightPx: 26 } })]);
  assert.equal(comfy.some((f) => f.id === "tight-leading"), false);
  const display = detectComputedFindings([el({ tag: "h1", text: "Big tight display headline", style: { fontSizePx: 48, lineHeightPx: 50 } })]);
  assert.equal(display.some((f) => f.id === "tight-leading"), false, "display type legitimately runs tight");
});

// ── skipped-heading (document-level) ──────────────────────────────────────────
test("flags a heading level jump (h1 → h3 with no h2)", () => {
  const findings = detectComputedFindings([
    el({ selector: "h1", tag: "h1", text: "Title", style: { fontSizePx: 40 } }),
    el({ selector: "h3", tag: "h3", text: "Subsection", style: { fontSizePx: 20 } }),
  ]);
  assert.ok(findings.some((f) => f.id === "skipped-heading"));
});

test("does not flag a well-ordered heading outline", () => {
  const findings = detectComputedFindings([
    el({ selector: "h1", tag: "h1", text: "Title", style: { fontSizePx: 40 } }),
    el({ selector: "h2", tag: "h2", text: "Section", style: { fontSizePx: 28 } }),
    el({ selector: "h3", tag: "h3", text: "Subsection", style: { fontSizePx: 20 } }),
  ]);
  assert.equal(findings.some((f) => f.id === "skipped-heading"), false);
});
