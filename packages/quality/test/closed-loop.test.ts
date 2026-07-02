import { test } from "node:test";
import assert from "node:assert/strict";
import { lintAndRepair, type ReviseArtifact } from "../src/closed-loop.ts";
import { renderFindingsForAgent } from "../src/render-findings.ts";
import { lintArtifact } from "../src/lint-artifact.ts";
import { lintScore } from "../src/score.ts";
import { CLEAN_ARTIFACT, SLOPPY_ARTIFACT } from "./fixtures.ts";

test("clean artifact needs zero repair rounds", async () => {
  const revise: ReviseArtifact = () => {
    throw new Error("revise should not be called for a clean artifact");
  };
  const result = await lintAndRepair(CLEAN_ARTIFACT, revise);
  assert.equal(result.rounds, 0);
  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

test("closed loop repairs a sloppy artifact in one round", async () => {
  let sawLintBlock = "";
  const revise: ReviseArtifact = (lintBlock) => {
    // A real agent would rewrite the file; the fake one just returns a clean one.
    sawLintBlock = lintBlock;
    return CLEAN_ARTIFACT;
  };
  const result = await lintAndRepair(SLOPPY_ARTIFACT, revise, { maxRounds: 2 });
  assert.equal(result.rounds, 1, "one repair round");
  assert.equal(result.passed, true, "final artifact passes");
  assert.deepEqual(result.findings, [], "no remaining findings");
  assert.match(sawLintBlock, /<artifact-lint>/, "agent was fed the lint block");
  assert.match(sawLintBlock, /\bP0\b/, "lint block names P0s");
  assert.equal(result.history.length, 1);
});

test("closed loop stops at maxRounds when never fixed", async () => {
  // revise returns the same sloppy artifact every time → never converges.
  const revise: ReviseArtifact = () => SLOPPY_ARTIFACT;
  const result = await lintAndRepair(SLOPPY_ARTIFACT, revise, { maxRounds: 2 });
  assert.equal(result.rounds, 2, "ran exactly maxRounds");
  assert.equal(result.passed, false, "still failing");
  assert.ok(result.findings.length > 0, "findings remain");
});

test("closed loop returns the best-scoring artifact when repair regresses", async () => {
  const initiallyBad = `<!doctype html><html><head><style>.cta{color:#6366f1}</style></head><body><h1>Plain product copy</h1></body></html>`;
  const result = await lintAndRepair(initiallyBad, () => SLOPPY_ARTIFACT, { maxRounds: 1 });

  assert.equal(result.passed, false);
  assert.equal(result.rounds, 1);
  assert.equal(result.html, initiallyBad);
  assert.ok(lintScore(result.findings) > lintScore(lintArtifact(SLOPPY_ARTIFACT)), "returned findings should be from the best artifact");
});

test("closed loop converges across two rounds (partial fixes)", async () => {
  // Round 1 fixes the indigo but leaves the emoji; round 2 returns clean.
  const partiallyFixed = `<style>:root{--accent:#2563eb}</style><h1>✨ Hi</h1>`;
  let call = 0;
  const revise: ReviseArtifact = () => {
    call += 1;
    return call === 1 ? partiallyFixed : CLEAN_ARTIFACT;
  };
  const result = await lintAndRepair(SLOPPY_ARTIFACT, revise, { maxRounds: 3 });
  assert.equal(result.rounds, 2);
  assert.equal(result.passed, true);
});

test("blockOn can include P1", async () => {
  // An artifact with only a P1 (external image): default blockOn=[P0] does not loop.
  const p1Only = `<img src="https://picsum.photos/200" alt="x">`;
  const noLoop = await lintAndRepair(p1Only, () => CLEAN_ARTIFACT);
  assert.equal(noLoop.rounds, 0, "P1 alone does not trigger default loop");

  const loop = await lintAndRepair(p1Only, () => CLEAN_ARTIFACT, { blockOn: ["P0", "P1"] });
  assert.equal(loop.rounds, 1, "P1 triggers loop when blockOn includes P1");
});

test("renderFindingsForAgent returns null when clean", () => {
  assert.equal(renderFindingsForAgent(lintArtifact(CLEAN_ARTIFACT)), null);
});
