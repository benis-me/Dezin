import { test } from "node:test";
import assert from "node:assert/strict";
import { lintArtifact, lintScore, scoreGrade } from "../src/index.ts";
import type { Finding } from "../src/types.ts";
import { CLEAN_ARTIFACT, SLOPPY_ARTIFACT } from "./fixtures.ts";

const f = (severity: string): Finding => ({ severity: severity as Finding["severity"], id: "x", message: "m", fix: "f" });

test("lintScore weights: 100 clean, P0=-25, P1=-8, P2=-3, clamped", () => {
  assert.equal(lintScore([]), 100);
  assert.equal(lintScore([f("P0")]), 75);
  assert.equal(lintScore([f("P1")]), 92);
  assert.equal(lintScore([f("P2")]), 97);
  assert.equal(lintScore([f("P1"), f("P2")]), 89);
  assert.equal(lintScore([f("P0"), f("P0"), f("P0"), f("P0"), f("P0")]), 0); // clamps at 0
});

test("scoreGrade bands", () => {
  assert.equal(scoreGrade(100), "A");
  assert.equal(scoreGrade(80), "B");
  assert.equal(scoreGrade(60), "C");
  assert.equal(scoreGrade(45), "D");
  assert.equal(scoreGrade(10), "F");
});

// ── Regression baseline: scores of known-good / known-bad artifacts ──────────

test("regression: a clean Linear/Vercel artifact scores 100", () => {
  assert.equal(lintScore(lintArtifact(CLEAN_ARTIFACT)), 100);
});

test("regression: a sloppy artifact scores low (< 50)", () => {
  const s = lintScore(lintArtifact(SLOPPY_ARTIFACT));
  assert.ok(s < 50, `expected sloppy < 50, got ${s}`);
});

test("regression: a clean dark-theme page scores 100", () => {
  const dark = `<!doctype html><html><head><style>
    :root { --bg:#0a0a0a; --fg:#f2f2f2; --accent:#4da6ff; --font-display: Geist, sans-serif; }
    [data-theme="dark"] { background:#0a0a0a; color:#f2f2f2; }
    body { background: var(--bg); color: var(--fg); }
  </style></head><body><h1>Dark, but not pure black</h1><p>Real content.</p></body></html>`;
  assert.equal(lintScore(lintArtifact(dark)), 100);
});

test("regression: a justify + multiple-h1 page lands in a mid band (two P1)", () => {
  const mid = `<!doctype html><html><head><style>.prose { text-align: justify; }</style></head>
    <body><h1>One</h1><section><h1>Two</h1></section><p class="prose">x</p></body></html>`;
  const s = lintScore(lintArtifact(mid));
  assert.ok(s >= 80 && s < 100, `expected mid band [80,100), got ${s}`);
});

import { scoreTrend } from "../src/score.ts";

test("scoreTrend summarizes latest vs previous (most-recent first)", () => {
  const t = scoreTrend([90, 80, 70]);
  assert.equal(t.latest, 90);
  assert.equal(t.previous, 80);
  assert.equal(t.delta, 10);
  assert.equal(t.direction, "up");
  assert.equal(t.average, 80);
  assert.equal(t.count, 3);
});

test("scoreTrend reports a downward move and handles sparse history", () => {
  assert.equal(scoreTrend([70, 85]).direction, "down");
  const one = scoreTrend([88]);
  assert.equal(one.latest, 88);
  assert.equal(one.previous, null);
  assert.equal(one.direction, "none");
  const none = scoreTrend([]);
  assert.equal(none.latest, null);
  assert.equal(none.direction, "none");
  assert.equal(none.count, 0);
});
