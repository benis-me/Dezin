import { test } from "node:test";
import assert from "node:assert/strict";
import { chromaSpread, compositeOver, contrastRatio, parseColor, relativeLuminance } from "../src/color.ts";

const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("parseColor reads rgb, rgba, space-syntax, and hex", () => {
  assert.deepEqual(parseColor("rgb(255, 255, 255)"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("rgba(0, 0, 0, 0)"), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(parseColor("rgb(16 32 48 / 0.5)"), { r: 16, g: 32, b: 48, a: 0.5 });
  assert.deepEqual(parseColor("#ffffff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor("transparent")?.a, 0);
  assert.equal(parseColor("not-a-color"), null);
});

test("relativeLuminance anchors at black=0 and white=1", () => {
  near(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  near(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
});

test("contrastRatio is 21:1 for black-on-white and 1:1 for same colors", () => {
  near(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21, 0.1);
  near(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 }), 1);
  // Order-independent.
  near(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }), 21, 0.1);
});

test("compositeOver blends a semi-transparent color onto an opaque background", () => {
  const out = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255 });
  near(out.r, 128, 1);
  near(out.g, 128, 1);
  near(out.b, 128, 1);
});

test("chromaSpread separates neutral gray from a chromatic color", () => {
  assert.equal(chromaSpread({ r: 128, g: 128, b: 128 }), 0);
  assert.equal(chromaSpread({ r: 200, g: 40, b: 40 }), 160);
});
