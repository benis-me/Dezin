import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRunner, AgentTurnInput, AgentTurnResult } from "../../../packages/agent/src/index.ts";
import {
  executeStandardArtifact,
  sortStandardArtifactVersions,
  StandardArtifactExecutionError,
  type StandardArtifactCandidateIdentity,
  type StandardArtifactCandidateTransactionPort,
  type StandardArtifactQualityResult,
} from "../src/orchestration/standard-artifact-execution.ts";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);
const HASH_D = "d".repeat(40);
const HASH_E = "e".repeat(40);
const HASH_F = "f".repeat(40);

class RecordingRunner implements AgentRunner {
  readonly id = "recording";
  readonly inputs: AgentTurnInput[] = [];
  private readonly outputs: AgentTurnResult[];
  private index = 0;

  constructor(outputs: AgentTurnResult[]) {
    this.outputs = outputs;
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.inputs.push(input);
    return this.outputs[this.index++] ?? { text: "done", artifactHtml: "<main />" };
  }
}

class RecordingTransaction implements StandardArtifactCandidateTransactionPort {
  readonly dir = "/tmp/dezin-standard-artifact-execution";
  readonly restored: StandardArtifactCandidateIdentity[] = [];
  readonly commits: string[] = [];
  private readonly fingerprints: string[];
  private readonly candidates: StandardArtifactCandidateIdentity[];

  constructor(input: {
    fingerprints: string[];
    candidates: StandardArtifactCandidateIdentity[];
  }) {
    this.fingerprints = [...input.fingerprints];
    this.candidates = [...input.candidates];
  }

  async fingerprint(): Promise<string> {
    return this.fingerprints.shift() ?? "stable";
  }

  async commit(message: string): Promise<StandardArtifactCandidateIdentity> {
    this.commits.push(message);
    const candidate = this.candidates.shift();
    assert.ok(candidate);
    return candidate;
  }

  async restore(candidate: StandardArtifactCandidateIdentity): Promise<void> {
    this.restored.push(candidate);
  }
}

function quality(input: {
  passed: boolean;
  score: number;
  repairs?: Array<Record<string, unknown>>;
}): StandardArtifactQualityResult {
  return {
    passed: input.passed,
    score: input.score,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: input.passed ? "passed" : "failed", score: input.score, findings: input.repairs ?? [] },
    evidence: {
      frames: [{ id: "desktop", rendered: true }],
      runtimeChecks: [{ id: "desktop", passed: true }],
      visualReview: { completed: true, findings: input.repairs ?? [] },
    },
    repairFindings: input.repairs ?? [],
  };
}

function candidate(commitHash: string, treeHash: string): StandardArtifactCandidateIdentity {
  return { commitHash, treeHash };
}

function baseInput(input: {
  runner: RecordingRunner;
  transaction: RecordingTransaction;
  qualities: StandardArtifactQualityResult[];
  signal?: AbortSignal;
  maxRepairRounds?: number;
  maxTurns?: number;
}) {
  let qualityIndex = 0;
  return {
    runner: input.runner,
    transaction: input.transaction,
    evaluator: {
      async evaluate() {
        const result = input.qualities[qualityIndex++];
        assert.ok(result);
        return result;
      },
    },
    systemPrompt: "Build one exact Page Artifact.",
    initialMessage: "Create the approved checkout experience.",
    history: [{ role: "user" as const, content: "Earlier approved direction" }],
    signal: input.signal ?? new AbortController().signal,
    maxRepairRounds: input.maxRepairRounds ?? 2,
    maxTurns: input.maxTurns ?? 3,
    commitMessage: (round: number) => `Artifact candidate round ${round}`,
    buildRepairPrompt: ({ round, prior }: { round: number; prior: { quality: StandardArtifactQualityResult } }) => (
      prior.quality.repairFindings.length > 0 ? `Repair round ${round}` : null
    ),
  };
}

test("Standard Artifact execution evaluates bounded repair rounds and selects the best passing candidate", async () => {
  const runner = new RecordingRunner([
    { text: "draft", artifactHtml: "<main>draft</main>" },
    { text: "repair one", artifactHtml: "<main>repair</main>" },
    { text: "repair two", artifactHtml: "<main>final</main>" },
  ]);
  const transaction = new RecordingTransaction({
    fingerprints: ["base", "draft", "draft", "repair-1", "repair-1", "repair-2"],
    candidates: [
      candidate(HASH_A, HASH_B),
      candidate(HASH_C, HASH_D),
      candidate(HASH_E, HASH_F),
    ],
  });
  const events: string[] = [];
  const result = await executeStandardArtifact({
    ...baseInput({
      runner,
      transaction,
      qualities: [
        quality({ passed: false, score: 91, repairs: [{ id: "overflow" }] }),
        quality({ passed: true, score: 96, repairs: [{ id: "polish" }] }),
        quality({ passed: true, score: 94 }),
      ],
    }),
    onEvent: (event) => events.push(`${event.type}:${event.round}`),
  });

  assert.equal(result.versions.length, 3);
  assert.equal(result.turns.length, 3);
  assert.equal(result.selected.candidate.commitHash, HASH_C);
  assert.deepEqual(transaction.restored, [candidate(HASH_C, HASH_D)]);
  assert.deepEqual(transaction.commits, [
    "Artifact candidate round 0",
    "Artifact candidate round 1",
    "Artifact candidate round 2",
  ]);
  assert.equal(runner.inputs[0]?.message, "Create the approved checkout experience.");
  assert.equal(runner.inputs[1]?.message, "Repair round 1");
  assert.deepEqual(runner.inputs[1]?.history, [
    { role: "user", content: "Earlier approved direction" },
    { role: "user", content: "Create the approved checkout experience." },
    { role: "assistant", content: "draft" },
  ]);
  assert.deepEqual(events.slice(-3), ["candidate:2", "quality:2", "restore:1"]);
});

test("a later equal passing candidate wins without a redundant restore", async () => {
  const runner = new RecordingRunner([
    { text: "draft", artifactHtml: "" },
    { text: "polish", artifactHtml: "" },
  ]);
  const transaction = new RecordingTransaction({
    fingerprints: ["a", "b", "b", "c"],
    candidates: [candidate(HASH_A, HASH_B), candidate(HASH_C, HASH_D)],
  });
  const result = await executeStandardArtifact(baseInput({
    runner,
    transaction,
    maxRepairRounds: 1,
    maxTurns: 2,
    qualities: [
      quality({ passed: true, score: 98, repairs: [{ id: "optional" }] }),
      quality({ passed: true, score: 98 }),
    ],
  }));

  assert.equal(result.selected.round, 1);
  assert.deepEqual(transaction.restored, []);
});

test("a no-op Agent turn fails before commit or quality evaluation", async () => {
  const runner = new RecordingRunner([{ text: "no changes", artifactHtml: "" }]);
  const transaction = new RecordingTransaction({
    fingerprints: ["same", "same"],
    candidates: [candidate(HASH_A, HASH_B)],
  });
  let evaluated = 0;
  await assert.rejects(
    executeStandardArtifact({
      ...baseInput({ runner, transaction, qualities: [quality({ passed: true, score: 100 })] }),
      evaluator: { async evaluate() { evaluated += 1; return quality({ passed: true, score: 100 }); } },
    }),
    (error) => error instanceof StandardArtifactExecutionError && error.code === "no-source-change",
  );
  assert.equal(evaluated, 0);
  assert.deepEqual(transaction.commits, []);
});

test("AbortSignal is observed between Agent, fingerprint, commit, quality, and restore boundaries", async (t) => {
  await t.test("before first turn", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    const runner = new RecordingRunner([]);
    const transaction = new RecordingTransaction({ fingerprints: [], candidates: [] });
    await assert.rejects(
      executeStandardArtifact(baseInput({
        runner,
        transaction,
        signal: controller.signal,
        qualities: [],
      })),
      /stop|aborted/i,
    );
    assert.equal(runner.inputs.length, 0);
  });

  await t.test("after quality", async () => {
    const controller = new AbortController();
    const runner = new RecordingRunner([{ text: "draft", artifactHtml: "" }]);
    const transaction = new RecordingTransaction({
      fingerprints: ["a", "b"],
      candidates: [candidate(HASH_A, HASH_B)],
    });
    await assert.rejects(
      executeStandardArtifact({
        ...baseInput({ runner, transaction, signal: controller.signal, qualities: [] }),
        evaluator: {
          async evaluate() {
            controller.abort(new DOMException("quality stop", "AbortError"));
            return quality({ passed: true, score: 100 });
          },
        },
      }),
      /quality stop|aborted/i,
    );
  });
});

test("invalid candidates and hostile quality output fail closed", async (t) => {
  await t.test("candidate hash", async () => {
    const runner = new RecordingRunner([{ text: "draft", artifactHtml: "" }]);
    const transaction = new RecordingTransaction({
      fingerprints: ["a", "b"],
      candidates: [candidate("not-a-hash", HASH_B)],
    });
    await assert.rejects(
      executeStandardArtifact(baseInput({ runner, transaction, qualities: [] })),
      (error) => error instanceof StandardArtifactExecutionError && error.code === "invalid-candidate",
    );
  });

  await t.test("revoked evidence", async () => {
    const runner = new RecordingRunner([{ text: "draft", artifactHtml: "" }]);
    const transaction = new RecordingTransaction({
      fingerprints: ["a", "b"],
      candidates: [candidate(HASH_A, HASH_B)],
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    await assert.rejects(
      executeStandardArtifact({
        ...baseInput({ runner, transaction, qualities: [] }),
        evaluator: {
          async evaluate() {
            return { ...quality({ passed: true, score: 100 }), evidence: revoked.proxy };
          },
        },
      }),
      (error) => error instanceof StandardArtifactExecutionError && error.code === "invalid-quality",
    );
  });
});

test("tree oscillation cannot grind through the remaining repair budget", async () => {
  const runner = new RecordingRunner([
    { text: "draft", artifactHtml: "" },
    { text: "oscillated", artifactHtml: "" },
  ]);
  const transaction = new RecordingTransaction({
    fingerprints: ["a", "b", "b", "c"],
    candidates: [candidate(HASH_A, HASH_B), candidate(HASH_C, HASH_B)],
  });
  const result = await executeStandardArtifact(baseInput({
    runner,
    transaction,
    qualities: [quality({ passed: false, score: 80, repairs: [{ id: "cycle" }] })],
  }));

  assert.equal(runner.inputs.length, 2);
  assert.equal(result.versions.length, 1);
  assert.equal(result.selected.candidate.commitHash, HASH_A);
});

test("version ordering prefers passing, score, recency, then binary commit identity", () => {
  const shared = quality({ passed: true, score: 90 });
  const versions = [
    { round: 9, candidate: candidate(HASH_F, HASH_A), quality: quality({ passed: false, score: 100 }), assistantText: "" },
    { round: 1, candidate: candidate(HASH_B, HASH_A), quality: shared, assistantText: "" },
    { round: 2, candidate: candidate(HASH_C, HASH_A), quality: shared, assistantText: "" },
    { round: 0, candidate: candidate(HASH_A, HASH_A), quality: quality({ passed: true, score: 99 }), assistantText: "" },
  ];
  assert.deepEqual(
    sortStandardArtifactVersions(versions).map((version) => version.candidate.commitHash),
    [HASH_A, HASH_C, HASH_B, HASH_F],
  );
});
