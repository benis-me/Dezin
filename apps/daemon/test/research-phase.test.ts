import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResearchPhase } from "../src/research-phase.ts";
import { directionsExist, listDirections } from "../../../packages/research/src/index.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function writeTrackBundle(cwd: string, track: "product" | "visual"): void {
  const root = track === "product" ? join(cwd, ".research") : join(cwd, ".research", "visual");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(
    join(root, track === "product" ? "research.md" : "visual.md"),
    track === "product"
      ? "# Product research\n\nReal users compare alternatives, scan proof, and need a clear primary action before committing. This report grounds the design in observed needs. [product-source]\n"
      : "# Visual research\n\nThe inspected references use restrained contrast, deliberate hierarchy, and one focused accent to create a calm but distinctive interface. [visual-source]\n",
  );
  writeFileSync(join(root, "assets", `${track}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(
    join(root, "sources.json"),
    JSON.stringify([
      {
        id: `${track}-source`,
        title: `${track} source`,
        url: `https://example.com/${track}`,
        authority: track === "product" ? "primary" : undefined,
        reached: track === "visual" ? true : undefined,
        takeaways: ["Concrete source-grounded takeaway."],
        assets: [`assets/${track}.png`],
      },
    ]),
  );
}

function writeDirection(cwd: string, slug: string): void {
  const target = join(cwd, ".research", "directions", slug);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, "direction.md"),
    `# ${slug}\n\nConcept: A focused product surface grounded in the research findings.\n\nStructure: Lead with the primary task, then evidence, details, and a clear next action.\n\nDistinctive move: Use one precise editorial transition to make the experience memorable without noise.\n`,
  );
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
    const joined = args.join(" ");
    if (joined.includes("Phase: Synthesis")) {
      writeDirection(cwd, "calm-editorial");
      writeDirection(cwd, "focused-console");
      return { code: 0, stderr: "" };
    }
    const isVisual = joined.includes("Visual Research");
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
      writeTrackBundle(cwd, "visual");
      opts.onActivity?.({ kind: "search", text: "dribbble" });
    } else {
      writeTrackBundle(cwd, "product");
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
      writeTrackBundle(cwd, "visual");
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

test("runResearchPhase runs a synthesis step after both tracks and produces directions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-rp-synth-"));
  const calls: string[] = [];
  const spawn = async (_cmd: string, args: string[], cwd: string, _opts: any) => {
    const joined = args.join(" ");
    if (joined.includes("Phase: Synthesis")) {
      calls.push("synthesis");
      writeDirection(cwd, "calm-editorial");
      writeDirection(cwd, "focused-console");
    } else if (joined.includes("Visual Research")) {
      calls.push("visual");
      writeTrackBundle(cwd, "visual");
    } else {
      calls.push("product");
      writeTrackBundle(cwd, "product");
    }
    return { code: 0, stderr: "" };
  };
  const result = await runResearchPhase({ dir, brief: "a hero", agentCommand: "claude" }, spawn);
  assert.equal(result.produced, true);
  assert.equal(result.visualProduced, true);
  assert.ok(directionsExist(dir), "synthesis step should have produced directions");
  assert.ok(calls.includes("synthesis"), "synthesis spawn should run");
  // Synthesis runs AFTER both tracks.
  assert.ok(calls.indexOf("synthesis") > calls.indexOf("product"));
  assert.ok(calls.indexOf("synthesis") > calls.indexOf("visual"));
});

test("runResearchPhase discards stale directions and re-synthesizes after either evidence track reruns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-rp-stale-directions-"));
  writeTrackBundle(dir, "product");
  writeTrackBundle(dir, "visual");
  writeDirection(dir, "stale-one");
  writeDirection(dir, "stale-two");
  writeFileSync(join(dir, ".research", "research.md"), "too thin");
  const calls: string[] = [];
  const spawn = async (_cmd: string, args: string[], cwd: string) => {
    const joined = args.join(" ");
    if (joined.includes("Phase: Synthesis")) {
      calls.push("synthesis");
      writeDirection(cwd, "fresh-one");
      writeDirection(cwd, "fresh-two");
    } else if (joined.includes("Visual Research")) {
      calls.push("visual");
      writeTrackBundle(cwd, "visual");
    } else {
      calls.push("product");
      writeTrackBundle(cwd, "product");
    }
    return { code: 0, stderr: "" };
  };

  const result = await runResearchPhase({ dir, brief: "a changed evidence base", agentCommand: "claude" }, spawn);
  const slugs = (await listDirections(dir)).map((direction) => direction.slug).sort();

  assert.equal(result.complete, true);
  assert.deepEqual(calls, ["product", "synthesis"]);
  assert.deepEqual(slugs, ["fresh-one", "fresh-two"]);
});

test("runResearchPhase returns complete only after a validated two-direction bundle exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-rp-complete-"));
  const spawn = async (_cmd: string, args: string[], cwd: string) => {
    const joined = args.join(" ");
    if (joined.includes("Phase: Synthesis")) {
      writeDirection(cwd, "calm-editorial");
      writeDirection(cwd, "focused-console");
    } else if (joined.includes("Visual Research")) {
      writeTrackBundle(cwd, "visual");
    } else {
      writeTrackBundle(cwd, "product");
    }
    return { code: 0, stderr: "" };
  };

  const result = await runResearchPhase({ dir, brief: "a hero", agentCommand: "claude" }, spawn);

  assert.equal(result.complete, true);
  assert.deepEqual(result.issues, []);
});

test("explicit forced Research replaces a previously complete bundle instead of returning it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-rp-force-"));
  writeTrackBundle(dir, "product");
  writeTrackBundle(dir, "visual");
  writeDirection(dir, "old-one");
  writeDirection(dir, "old-two");
  const calls: string[] = [];
  const spawn = async (_cmd: string, args: string[], cwd: string) => {
    const joined = args.join(" ");
    if (joined.includes("Phase: Synthesis")) {
      calls.push("synthesis");
      writeDirection(cwd, "new-one");
      writeDirection(cwd, "new-two");
    } else if (joined.includes("Visual Research")) {
      calls.push("visual");
      writeTrackBundle(cwd, "visual");
    } else {
      calls.push("product");
      writeTrackBundle(cwd, "product");
    }
    return { code: 0, stderr: "" };
  };

  const result = await runResearchPhase({ dir, brief: "a completely new brief", agentCommand: "claude", force: true }, spawn);

  assert.equal(result.ran, true);
  assert.equal(result.complete, true);
  assert.deepEqual(calls.sort(), ["product", "synthesis", "visual"]);
  assert.equal(directionsExist(dir), true);
});

test("runResearchPhase returns concrete bundle issues after retries cannot complete Research", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-rp-incomplete-"));
  const spawn = async (_cmd: string, args: string[], cwd: string) => {
    if (args.join(" ").includes("Visual Research")) writeTrackBundle(cwd, "visual");
    return { code: 0, stderr: "" };
  };

  const result = await runResearchPhase({ dir, brief: "a hero", agentCommand: "claude" }, spawn);

  assert.equal(result.complete, false);
  assert.ok(result.issues.some((issue) => issue.area === "product"));
  assert.ok(result.issues.some((issue) => issue.code === "directions-count"));
});
