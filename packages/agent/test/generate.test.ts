import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeRunner, generateArtifact, runTurnWithRetry, type GenerateEvent } from "../src/index.ts";

const CLEAN = `<style>:root{--accent:#2563eb}</style>
<section data-dezin-id="x"><h1>Hi there</h1><p>Real copy describing the thing.</p></section>`;

const SLOPPY = `<style>.hero{background:#6366f1}</style><h1>🚀 Launch</h1><p>10x faster.</p>`;

test("clean first draft → zero repair rounds, one turn", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN] });
  const r = await generateArtifact({
    runner,
    systemPrompt: "SYS",
    brief: "make a hero",
    projectDir: "/tmp/x",
  });
  assert.equal(r.rounds, 0);
  assert.equal(r.passed, true);
  assert.equal(r.turns.length, 1);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]?.message, "make a hero");
  assert.equal(runner.calls[0]?.systemPrompt, "SYS");
});

test("sloppy draft → one repair round feeds the <artifact-lint> block back", async () => {
  const runner = new FakeRunner({ artifacts: [SLOPPY, CLEAN] });
  const r = await generateArtifact({
    runner,
    systemPrompt: "SYS",
    brief: "make a hero",
    projectDir: "/tmp/x",
  });
  assert.equal(r.rounds, 1, "one repair round");
  assert.equal(r.passed, true, "final artifact passes");
  assert.equal(r.turns.length, 2);
  assert.equal(runner.calls.length, 2);
  // the second turn's message is the lint feedback, and it is marked a repair
  assert.match(runner.calls[1]?.message ?? "", /<artifact-lint>/);
  assert.equal(runner.calls[1]?.isRepair, true);
  // history was threaded into the repair turn
  assert.ok((runner.calls[1]?.history?.length ?? 0) >= 2);
});

test("never-fixed artifact stops at maxRounds, reports failure", async () => {
  const runner = new FakeRunner({ artifacts: [SLOPPY] }); // repeats sloppy forever
  const r = await generateArtifact({
    runner,
    systemPrompt: "SYS",
    brief: "make a hero",
    projectDir: "/tmp/x",
    lint: { maxRounds: 2 },
  });
  assert.equal(r.rounds, 2);
  assert.equal(r.passed, false);
  assert.ok(r.findings.length > 0);
  assert.equal(r.turns.length, 3); // initial + 2 repairs
});

test("onEvent emits the run lifecycle in order", async () => {
  const runner = new FakeRunner({ artifacts: [SLOPPY, CLEAN] });
  const events: GenerateEvent[] = [];
  await generateArtifact({
    runner,
    systemPrompt: "SYS",
    brief: "go",
    projectDir: "/tmp/x",
    onEvent: (e) => events.push(e),
  });
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "turn-start", // initial
    "turn-end",
    "lint", // round 1 findings
    "turn-start", // repair
    "turn-end",
    "done",
  ]);
  const done = events.at(-1);
  assert.ok(done?.type === "done" && done.passed === true && done.rounds === 1);
});

test("lint options are threaded into the loop (stricter accent cap)", async () => {
  // 4 accent uses: passes default-disabled? default cap is 3 → fails → triggers a round.
  const accenty =
    `<style>:root{--accent:#2563eb}</style>` +
    Array.from({ length: 4 }, () => `<i style="color:var(--accent)"></i>`).join("");
  const runner = new FakeRunner({ artifacts: [accenty, CLEAN] });
  const r = await generateArtifact({
    runner,
    systemPrompt: "SYS",
    brief: "go",
    projectDir: "/tmp/x",
    lint: { blockOn: ["P0", "P1"], maxRounds: 1 },
  });
  // accent-overuse is P1; with blockOn including P1 it triggers a repair
  assert.equal(r.rounds, 1);
  assert.equal(r.passed, true);
});

test("runTurnWithRetry retries transient failures then succeeds", async () => {
  let calls = 0;
  const flaky = {
    async runTurn() {
      calls++;
      if (calls < 3) throw new Error("stream hiccup");
      return { text: "ok", artifactHtml: CLEAN, artifactPath: "index.html" };
    },
  };
  const retries: number[] = [];
  const r = await runTurnWithRetry(flaky as never, { systemPrompt: "S", message: "m", projectDir: "/tmp/x" }, {
    maxAttempts: 3,
    sleep: async () => {},
    onRetry: (a) => retries.push(a),
  });
  assert.equal(r.text, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]);
});

test("runTurnWithRetry throws after exhausting attempts", async () => {
  const dead = {
    async runTurn() {
      throw new Error("agent crashed");
    },
  };
  await assert.rejects(
    runTurnWithRetry(dead as never, { systemPrompt: "S", message: "m", projectDir: "/tmp/x" }, { maxAttempts: 2, sleep: async () => {} }),
    /agent crashed/,
  );
});
