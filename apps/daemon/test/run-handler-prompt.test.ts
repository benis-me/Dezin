import { test } from "node:test";
import assert from "node:assert/strict";
import { standardRepairableDefects, standardRepairPolicy, standardRepairPrompt, standardRunPassed } from "../src/run-handler.ts";
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

test("standardRepairPolicy forces a bounded closed loop for Sharingan even when normal auto-improve is off", () => {
  const settings = { autoImproveEnabled: false, autoImproveMaxRounds: 0 } as Settings;
  assert.deepEqual(standardRepairPolicy(settings, false), { enabled: false, maxRounds: 0 });
  assert.deepEqual(standardRepairPolicy(settings, true), { enabled: true, maxRounds: 3 });
});

test("standardRunPassed treats remaining Sharingan source-fidelity P1 findings as not passed", () => {
  const sourceDrift: QualityFinding[] = [
    { severity: "P1", id: "visual-source-screenshot-diff", message: "large source diff", fix: "repair" },
  ];
  assert.equal(standardRunPassed(sourceDrift, false), true);
  assert.equal(standardRunPassed(sourceDrift, true), false);
  assert.equal(standardRunPassed([{ severity: "P0", id: "runtime", message: "blank", fix: "fix" }], true), false);
});

test("standardRepairableDefects limits Sharingan auto-repair to source-fidelity P1s and P0s", () => {
  const findings: QualityFinding[] = [
    { severity: "P1", id: "visual-below-fold-strip", message: "mobile strip", fix: "fix layout" },
    { severity: "P1", id: "visual-source-box-delta", message: "source drift", fix: "patch measured box" },
    { severity: "P2", id: "visual-improve-1", message: "advisory", fix: "improve" },
    { severity: "P0", id: "runtime-error", message: "blank", fix: "fix runtime" },
  ];

  assert.deepEqual(standardRepairableDefects(findings, true).map((f) => f.id), ["visual-source-box-delta", "runtime-error"]);
  assert.deepEqual(standardRepairableDefects(findings, false).map((f) => f.id), ["visual-below-fold-strip", "visual-source-box-delta", "runtime-error"]);
});
