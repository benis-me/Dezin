import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentReviewPrompt, auditVisualArtifact, parseVisualReview, reviewWithRetry, type VisualQaInput } from "../src/visual-qa.ts";

test("parseVisualReview rejects a malformed non-empty findings array instead of marking it reviewed", () => {
  const findings = parseVisualReview(
    JSON.stringify({
      findings: [{ kind: "defect", message: "The composer overlaps the last message." }],
    }),
  );

  assert.deepEqual(findings, []);
});

test("parseVisualReview rejects the whole response when valid and malformed findings are mixed", () => {
  const findings = parseVisualReview(
    JSON.stringify({
      findings: [
        { kind: "defect", severity: "P1", message: "The CTA is clipped.", fix: "Allow the label to wrap." },
        { kind: "defect", severity: "P9", message: "Unsupported severity." },
      ],
    }),
  );

  assert.deepEqual(findings, []);
});

test("parseVisualReview preserves an explicit brief or chosen-direction contradiction as a blocking contract finding", () => {
  const findings = parseVisualReview(
    JSON.stringify({
      findings: [
        {
          kind: "contract",
          severity: "P1",
          selector: "main.hero",
          message: "The chosen direction requires a near-monochrome surface, but the hero is dominated by a saturated gradient.",
          fix: "Apply the chosen near-monochrome palette to main.hero.",
        },
      ],
    }),
  );

  const contract = findings.find((finding) => finding.id === "visual-contract-drift-1");
  assert.equal(contract?.severity, "P1");
  assert.equal(contract?.selector, "main.hero");
  assert.ok(findings.some((finding) => finding.id === "visual-reviewed"));
});

test("agentReviewPrompt separates explicit contract drift from subjective taste", () => {
  const prompt = agentReviewPrompt(
    {
      htmlPath: "/project/index.html",
      projectRoot: "/project",
      brief: "A restrained editorial dashboard. Avoid gradients.",
      directionSpec: "# Quiet ledger\n\nNear-monochrome surfaces with one restrained accent.",
    } as VisualQaInput,
    "/project/.visual-qa/screenshot.png",
  );

  assert.match(prompt, /kind ["`]contract["`]/i);
  assert.match(prompt, /explicit brief|chosen direction/i);
  assert.match(prompt, /P1/);
  assert.match(prompt, /subjective taste|advisory/i);
});

test("reviewWithRetry returns a blocking unassessed finding after two malformed critic responses", async () => {
  let calls = 0;
  const findings = await reviewWithRetry(async () => {
    calls += 1;
    return [];
  });

  assert.equal(calls, 2);
  assert.equal(findings[0]?.id, "visual-review-unassessed");
  assert.equal(findings[0]?.severity, "P1");
});

test("Sharingan visual QA fails closed before rendering when source truth is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-no-source-"));
  const htmlPath = join(root, "index.html");
  writeFileSync(htmlPath, "<main>generated candidate</main>");

  const findings = await auditVisualArtifact({
    htmlPath,
    projectRoot: root,
    isSharingan: true,
    settings: { visualQaEnabled: true, agentCommand: "/usr/bin/true" } as any,
    agentCommand: "/usr/bin/true",
  });

  assert.equal(findings[0]?.id, "visual-source-evidence-missing");
  assert.equal(findings[0]?.severity, "P0");
});
