import { test } from "node:test";
import assert from "node:assert/strict";
import { inferDials, renderDialsBlock } from "../src/dials.ts";

test("a balanced brief yields mid-range dials", () => {
  const d = inferDials("a website for a coffee shop");
  assert.deepEqual(d, { variance: 5, motion: 4, density: 5 });
});

test("minimal/editorial briefs pull density and motion down", () => {
  const d = inferDials("a minimalist, calm editorial portfolio");
  assert.ok(d.density <= 3, `density ${d.density}`);
  assert.ok(d.motion <= 3, `motion ${d.motion}`);
});

test("playful/experimental briefs push variance and motion up", () => {
  const d = inferDials("a playful, experimental Awwwards-style landing page");
  assert.ok(d.variance >= 8, `variance ${d.variance}`);
  assert.ok(d.motion >= 8, `motion ${d.motion}`);
});

test("dashboard/data briefs push density up", () => {
  const d = inferDials("an analytics dashboard with lots of metrics and tables");
  assert.ok(d.density >= 8, `density ${d.density}`);
});

test("trust/regulated briefs cap variance and motion low", () => {
  const d = inferDials("a fintech banking app for regulated financial data");
  assert.ok(d.variance <= 4, `variance ${d.variance}`);
  assert.ok(d.motion <= 3, `motion ${d.motion}`);
});

test("a more specific category wins the conflict (a minimalist dashboard is still dense)", () => {
  const d = inferDials("a minimalist analytics dashboard");
  assert.ok(d.density >= 8, `density ${d.density}`);
});

test("dials clamp to 1..10", () => {
  for (const d of [inferDials(""), inferDials("playful maximal dense dashboard experimental")]) {
    for (const v of [d.variance, d.motion, d.density]) {
      assert.ok(v >= 1 && v <= 10, `out of range: ${v}`);
    }
  }
});

test("renderDialsBlock states each dial value and frames them as the target", () => {
  const block = renderDialsBlock({ variance: 3, motion: 2, density: 9 });
  assert.match(block, /variance[^\n]*3\/10/i);
  assert.match(block, /motion[^\n]*2\/10/i);
  assert.match(block, /density[^\n]*9\/10/i);
  assert.match(block, /prefers-reduced-motion/i);
});
