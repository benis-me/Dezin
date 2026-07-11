import { test } from "node:test";
import assert from "node:assert/strict";
import { standardRepairableDefects, standardRepairPolicy, standardRepairPrompt, standardRunPassed } from "../src/run-policy.ts";
import type { QualityFinding } from "../../../packages/core/src/index.ts";
import type { Settings } from "../../../packages/core/src/index.ts";

test("standardRepairPrompt constrains visual-source findings to measured local patches", () => {
  const findings: QualityFinding[] = [
    {
      severity: "P2",
      id: "visual-source-box-delta",
      selector: "h1.hero",
      message: "Source heading is measured at 80,120 520x72, generated is at 240,300 480x50.",
      fix: "Patch toward x:80, y:120, size:520x72.",
    },
  ];

  const prompt = standardRepairPrompt(findings, 1, 3, 94, "Clone https://example.com");
  assert.ok(prompt, "repair prompt is produced");
  assert.match(prompt!, /source-fidelity|source-vs-result/i);
  assert.match(prompt!, /measured local patches/i);
  assert.match(prompt!, /do not redesign|do not re-layout the whole page/i);
  assert.match(prompt!, /h1\.hero/);
});

test("standardRepairPrompt constrains measured layout repairs instead of inviting structural drift", () => {
  const findings: QualityFinding[] = [
    {
      severity: "P1",
      id: "visual-text-clipped",
      selector: ".card-title",
      message: "Desktop text appears clipped in .card-title.",
      fix: "Allow wrapping, increase the container height, or remove fixed dimensions that hide text.",
    },
  ];

  const prompt = standardRepairPrompt(findings, 1, 3, 91, "Clone https://example.com");
  assert.ok(prompt, "repair prompt is produced");
  assert.match(prompt!, /Measured layout repair mode/i);
  assert.match(prompt!, /Do not add new content|reinterpret the page structure/i);
});

test("standardRepairPolicy forces a bounded closed loop for Sharingan even when normal auto-improve is off", () => {
  const settings = { autoImproveEnabled: false, autoImproveMaxRounds: 0 } as Settings;
  assert.deepEqual(standardRepairPolicy(settings, false), { enabled: false, maxRounds: 0 });
  assert.deepEqual(standardRepairPolicy(settings, true), { enabled: true, maxRounds: 3 });
});

test("standardRunPassed treats every unresolved Sharingan finding as not passed", () => {
  const sourceDrift: QualityFinding[] = [
    { severity: "P2", id: "visual-source-screenshot-diff", message: "large source diff", fix: "repair" },
  ];
  assert.equal(standardRunPassed(sourceDrift, false), true);
  assert.equal(standardRunPassed(sourceDrift, true), false);
  assert.equal(standardRunPassed([{ severity: "P2", id: "visual-improve-1", message: "missing nav pill", fix: "fix" }], true), false);
  assert.equal(standardRunPassed([{ severity: "P1", id: "visual-text-clipped", message: "clipped", fix: "fix" }], true), false);
  assert.equal(standardRunPassed([{ severity: "P1", id: "visual-horizontal-overflow", message: "overflow", fix: "fix" }], true), false);
  assert.equal(standardRunPassed([{ severity: "P0", id: "runtime", message: "blank", fix: "fix" }], true), false);
  assert.equal(standardRunPassed([{ severity: "P2", id: "visual-reviewed", message: "reviewed", fix: "" }], true), true);
});

test("standardRepairableDefects sends every Sharingan finding except the review marker into auto-repair", () => {
  const findings: QualityFinding[] = [
    { severity: "P1", id: "visual-below-fold-strip", message: "mobile strip", fix: "fix layout" },
    { severity: "P1", id: "visual-text-clipped", message: "clipped title", fix: "fix text box" },
    { severity: "P1", id: "visual-horizontal-overflow", message: "wide content", fix: "constrain content" },
    { severity: "P1", id: "visual-source-box-delta", message: "source drift", fix: "patch measured box" },
    { severity: "P2", id: "visual-improve-1", message: "missing active nav pill", fix: "recreate the active nav pill" },
    { severity: "P2", id: "raw-hex", message: "raw color", fix: "tokenize" },
    { severity: "P0", id: "runtime-error", message: "blank", fix: "fix runtime" },
    { severity: "P2", id: "visual-reviewed", message: "reviewed", fix: "" },
  ];

  assert.deepEqual(standardRepairableDefects(findings, true).map((f) => f.id), [
    "visual-below-fold-strip",
    "visual-text-clipped",
    "visual-horizontal-overflow",
    "visual-source-box-delta",
    "visual-improve-1",
    "raw-hex",
    "runtime-error",
  ]);
  assert.deepEqual(standardRepairableDefects(findings, false).map((f) => f.id), [
    "visual-below-fold-strip",
    "visual-text-clipped",
    "visual-horizontal-overflow",
    "visual-source-box-delta",
    "runtime-error",
  ]);
});

test("standardRepairPrompt renders Sharingan findings without priority labels or optional language", () => {
  const prompt = standardRepairPrompt(
    [
      {
        severity: "P2",
        id: "visual-improve-1",
        selector: ".nav-home",
        message: "The active home nav pill is missing compared with the source.",
        fix: "Recreate the active nav pill in the measured position.",
      },
    ],
    1,
    3,
    92,
    "Clone https://example.com",
    { isSharingan: true },
  );

  assert.ok(prompt, "repair prompt is produced");
  assert.doesNotMatch(prompt!, /\bP[012]\b/);
  assert.doesNotMatch(prompt!, /nice to have|should fix|ideally|advisory|optional|improvements are concrete/i);
  assert.match(prompt!, /fix every finding/i);
  assert.match(prompt!, /\.nav-home/);
});
