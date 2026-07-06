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

// ── flat-type-hierarchy ───────────────────────────────────────────────────────
test("flags a flat type hierarchy (h1 barely larger than h2)", () => {
  const findings = detectComputedFindings([
    el({ selector: "h1", tag: "h1", text: "Headline", style: { fontSizePx: 20 } }),
    el({ selector: "h2", tag: "h2", text: "Subhead", style: { fontSizePx: 18 } }),
  ]);
  assert.ok(findings.some((f) => f.id === "flat-type-hierarchy"));
});

test("does not flag a hierarchy with real size jumps", () => {
  const findings = detectComputedFindings([
    el({ selector: "h1", tag: "h1", text: "Headline", style: { fontSizePx: 40 } }),
    el({ selector: "h2", tag: "h2", text: "Subhead", style: { fontSizePx: 28 } }),
  ]);
  assert.equal(findings.some((f) => f.id === "flat-type-hierarchy"), false);
});

// ── line-length ───────────────────────────────────────────────────────────────
test("flags a paragraph running wider than ~80ch", () => {
  const findings = detectComputedFindings([
    el({ selector: "p.wide", text: "x".repeat(200), rect: { x: 0, y: 0, width: 960, height: 40 }, style: { fontSizePx: 16 } }),
  ]);
  assert.ok(findings.some((f) => f.id === "line-length"));
});

test("does not flag a comfortably measured paragraph", () => {
  const findings = detectComputedFindings([
    el({ selector: "p", text: "x".repeat(200), rect: { x: 0, y: 0, width: 560, height: 40 }, style: { fontSizePx: 16 } }),
  ]);
  assert.equal(findings.some((f) => f.id === "line-length"), false);
});

// ── monotonous-spacing ────────────────────────────────────────────────────────
test("flags spacing that never varies (no vertical rhythm)", () => {
  const els = Array.from({ length: 12 }, (_, i) => el({ selector: `section.s${i}`, style: { fontSizePx: 16, paddingTopPx: 16, paddingBottomPx: 16 } }));
  assert.ok(detectComputedFindings(els).some((f) => f.id === "monotonous-spacing"));
});

test("does not flag varied spacing", () => {
  const sizes = [8, 16, 24, 32, 48, 64, 12, 20, 40, 56, 72, 96];
  const els = sizes.map((p, i) => el({ selector: `section.s${i}`, style: { fontSizePx: 16, paddingTopPx: p, paddingBottomPx: p } }));
  assert.equal(detectComputedFindings(els).some((f) => f.id === "monotonous-spacing"), false);
});

// ── cream-palette ─────────────────────────────────────────────────────────────
test("flags the AI cream/sand page background", () => {
  const findings = detectComputedFindings([el()], { pageBackground: "rgb(245, 240, 225)" });
  assert.ok(findings.some((f) => f.id === "cream-palette"));
});

test("does not flag a true off-white or a dark page", () => {
  assert.equal(detectComputedFindings([el()], { pageBackground: "rgb(255, 255, 255)" }).some((f) => f.id === "cream-palette"), false);
  assert.equal(detectComputedFindings([el()], { pageBackground: "rgb(20, 20, 24)" }).some((f) => f.id === "cream-palette"), false);
});

// ── ai-purple-text ────────────────────────────────────────────────────────────
test("flags saturated violet display type", () => {
  const findings = detectComputedFindings([el({ selector: "h1", tag: "h1", text: "Ship faster", style: { fontSizePx: 44, color: "rgb(124, 58, 237)" } })]);
  assert.ok(findings.some((f) => f.id === "ai-purple-text"));
});

test("does not flag neutral display type or small purple micro-text", () => {
  assert.equal(detectComputedFindings([el({ tag: "h1", style: { fontSizePx: 44, color: "rgb(17, 17, 17)" } })]).some((f) => f.id === "ai-purple-text"), false);
  assert.equal(detectComputedFindings([el({ tag: "span", text: "tiny", style: { fontSizePx: 12, color: "rgb(124, 58, 237)" } })]).some((f) => f.id === "ai-purple-text"), false);
});

// ── extreme-negative-tracking ─────────────────────────────────────────────────
test("flags crushed display letter-spacing (< -0.05em)", () => {
  const findings = detectComputedFindings([el({ selector: "h1", tag: "h1", text: "Crushed", style: { fontSizePx: 48, letterSpacing: "-3px" } })]);
  assert.ok(findings.some((f) => f.id === "extreme-negative-tracking"));
});

test("does not flag mild negative tracking", () => {
  const findings = detectComputedFindings([el({ tag: "h1", text: "Fine", style: { fontSizePx: 48, letterSpacing: "-1px" } })]);
  assert.equal(findings.some((f) => f.id === "extreme-negative-tracking"), false);
});

// ── dark-glow ─────────────────────────────────────────────────────────────────
test("flags a chromatic neon glow on a dark surface", () => {
  const findings = detectComputedFindings([
    el({ selector: ".cta", text: "Buy", rect: { x: 0, y: 0, width: 160, height: 48 }, style: { backgroundColor: "rgb(10, 10, 14)", effectiveBg: "rgb(10, 10, 14)", boxShadow: "rgba(139, 92, 246, 0.6) 0px 0px 24px 0px", fontSizePx: 16 } }),
  ]);
  assert.ok(findings.some((f) => f.id === "dark-glow"));
});

test("does not flag a neutral shadow or a glow on a light surface", () => {
  const neutral = detectComputedFindings([el({ style: { backgroundColor: "rgb(10, 10, 14)", boxShadow: "rgba(0, 0, 0, 0.5) 0px 2px 8px 0px", fontSizePx: 16 } })]);
  assert.equal(neutral.some((f) => f.id === "dark-glow"), false);
  const light = detectComputedFindings([el({ style: { backgroundColor: "rgb(255, 255, 255)", boxShadow: "rgba(139, 92, 246, 0.6) 0px 0px 24px 0px", fontSizePx: 16 } })]);
  assert.equal(light.some((f) => f.id === "dark-glow"), false);
});

// ── nested-cards ──────────────────────────────────────────────────────────────
test("flags a card nested inside another card", () => {
  const outer = el({ selector: ".card.outer", text: "", rect: { x: 0, y: 0, width: 400, height: 300 }, style: { cardLike: true } });
  const inner = el({ selector: ".card.inner", text: "", rect: { x: 40, y: 40, width: 200, height: 120 }, style: { cardLike: true } });
  assert.ok(detectComputedFindings([outer, inner]).some((f) => f.id === "nested-cards"));
});

test("does not flag sibling cards laid side by side", () => {
  const a = el({ selector: ".card.a", text: "", rect: { x: 0, y: 0, width: 200, height: 120 }, style: { cardLike: true } });
  const b = el({ selector: ".card.b", text: "", rect: { x: 220, y: 0, width: 200, height: 120 }, style: { cardLike: true } });
  assert.equal(detectComputedFindings([a, b]).some((f) => f.id === "nested-cards"), false);
});

// ── icon-tile-stack ───────────────────────────────────────────────────────────
test("flags a rounded icon tile stacked directly above a heading", () => {
  const tile = el({ selector: ".feature .icon", text: "", rect: { x: 0, y: 0, width: 48, height: 48 }, style: { hasIconChild: true, borderRadius: "12px" } });
  const heading = el({ selector: "h3", tag: "h3", text: "Fast", rect: { x: 0, y: 56, width: 200, height: 28 }, style: { fontSizePx: 20 } });
  assert.ok(detectComputedFindings([tile, heading]).some((f) => f.id === "icon-tile-stack"));
});

test("does not flag an icon tile that is not sitting above a heading", () => {
  const tile = el({ selector: ".feature .icon", text: "", rect: { x: 0, y: 0, width: 48, height: 48 }, style: { hasIconChild: true, borderRadius: "12px" } });
  assert.equal(detectComputedFindings([tile]).some((f) => f.id === "icon-tile-stack"), false);
});
