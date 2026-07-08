import { test } from "node:test";
import assert from "node:assert/strict";
import { standardRepairPrompt } from "../src/run-handler.ts";
import type { QualityFinding } from "../../../packages/core/src/index.ts";

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
