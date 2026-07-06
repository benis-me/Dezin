import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResearchPhase } from "../src/research-phase.ts";
import { reportPath, visualReportPath, visualAssetsDir } from "../../../packages/research/src/index.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("runResearchPhase runs product + visual in parallel and tags activities by track", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-rp-"));
  const seen: Array<{ track: string; kind: string }> = [];

  // Overlap barrier: each track signals when it enters the spawner, then blocks until
  // BOTH have entered. Under Promise.all both reach the barrier and it opens; under a
  // sequential-await regression the first track would wait for a second that hasn't
  // started yet, so its gate times out and rejects. This makes the test actually guard
  // PARALLELISM (the task's crux) rather than merely "both tracks eventually ran".
  const startedProduct = deferred();
  const startedVisual = deferred();
  const bothStarted = Promise.all([startedProduct.promise, startedVisual.promise]);
  let inFlight = 0;
  let maxConcurrent = 0;

  const spawn = async (_cmd: string, args: string[], cwd: string, opts: any) => {
    const isVisual = args.join(" ").includes("Visual Research");
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    (isVisual ? startedVisual : startedProduct).resolve();
    try {
      // Block until both tracks are simultaneously in-flight (or fail fast if they never are).
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no overlap: research tracks did not run concurrently")), 1000);
        bothStarted.then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          () => {},
        );
      });
    } finally {
      inFlight -= 1;
    }
    if (isVisual) {
      mkdirSync(visualAssetsDir(cwd), { recursive: true });
      writeFileSync(visualReportPath(cwd), "# Visual");
      opts.onActivity?.({ kind: "search", text: "dribbble" });
    } else {
      writeFileSync(reportPath(cwd), "# Product");
      opts.onActivity?.({ kind: "search", text: "competitors" });
    }
    return { code: 0, stderr: "" };
  };

  const result = await runResearchPhase(
    { dir, brief: "a hero", agentCommand: "claude", onActivity: (a) => seen.push({ track: a.track, kind: a.kind }) },
    spawn,
  );

  assert.equal(result.produced, true);
  assert.equal(result.visualProduced, true);
  assert.ok(seen.some((a) => a.track === "product"));
  assert.ok(seen.some((a) => a.track === "visual"));
  // The crux: both tracks were in-flight simultaneously — proves Promise.all, not sequential awaits.
  assert.equal(maxConcurrent, 2);
});

test("runResearchPhase populates error with a reason when a track never produces a report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-rp-"));

  // The visual track writes its report normally; the product track's spawner always rejects
  // (simulating a crashed agent turn) and never writes research.md, so it never produces.
  const spawn = async (_cmd: string, args: string[], cwd: string, opts: any) => {
    const isVisual = args.join(" ").includes("Visual Research");
    if (isVisual) {
      mkdirSync(visualAssetsDir(cwd), { recursive: true });
      writeFileSync(visualReportPath(cwd), "# Visual");
      return { code: 0, stderr: "" };
    }
    throw new Error("agent crashed: ENOENT spawn claude");
  };

  const result = await runResearchPhase({ dir, brief: "a hero", agentCommand: "claude" }, spawn);

  assert.equal(result.produced, false);
  assert.equal(result.visualProduced, true);
  assert.ok(result.error, "expected a non-undefined error reason when the product track failed to produce");
  assert.match(result.error!, /product:/);
  assert.match(result.error!, /agent crashed/);
  // The visual track succeeded — its reason must not appear in the combined error.
  assert.doesNotMatch(result.error!, /visual:/);
});

test("runResearchPhase reports a per-track reason (with prefixes) when BOTH tracks fail to produce", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-rp-"));

  // Neither track writes a report; the spawner resolves with a non-zero exit code both times
  // (no thrown error), exercising the "${command} exited …" reason path rather than a caught error.
  const spawn = async () => ({ code: 1, stderr: "fatal: no api key configured" });

  const result = await runResearchPhase({ dir, brief: "a hero", agentCommand: "claude" }, spawn);

  assert.equal(result.produced, false);
  assert.equal(result.visualProduced, false);
  assert.ok(result.error, "expected a non-undefined error reason when both tracks failed to produce");
  assert.match(result.error!, /product:.*claude exited with code 1/);
  assert.match(result.error!, /visual:.*claude exited with code 1/);
  assert.match(result.error!, /no api key configured/);
});
