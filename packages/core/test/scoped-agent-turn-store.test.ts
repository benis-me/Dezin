import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  ScopedAgentTurnConflictError,
  ScopedAgentTurnDerivedInputConflictError,
  Store,
  type StoreClock,
} from "../src/index.ts";

const TURN_ID = "turn-550e8400-e29b-41d4-a716-446655440000";
const CONTEXT_HASH = "b".repeat(64);
const REQUEST_CONTEXT_HASH = "c".repeat(64);

function clock(prefix: string): StoreClock {
  let sequence = 0;
  return {
    now: () => 100_000 + ++sequence,
    id: () => `${prefix}-${++sequence}`,
  };
}

function seedScopedTurn(store: Store) {
  const project = store.createProject({ name: "Scoped turn idempotency", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    commands: [{
      id: "add-scoped-turn-page",
      type: "add-node",
      node: {
        id: "scoped-turn-page-node",
        kind: "page",
        name: "Checkout",
        artifactId: "scoped-turn-page",
        createIdentity: { initialTrackId: "scoped-turn-page-track" },
      },
    }],
  });
  const revision = store.workspace.createArtifactRevision({
    artifactId: "scoped-turn-page",
    trackId: "scoped-turn-page-track",
    parentRevisionId: null,
    sourceCommitHash: "1".repeat(40),
    sourceTreeHash: "2".repeat(40),
    kernelRevisionId: initial.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  const snapshot = store.workspace.publishArtifactRevision(revision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  const workspace = store.workspace.getWorkspace(project.id)!;
  const layout = store.workspace.getLayout(project.id);
  const message = "Improve checkout hierarchy without changing its information architecture.";
  const contextPack = store.workspace.persistContextPack({
    id: `context-pack-${CONTEXT_HASH}`,
    workspaceId: workspace.id,
    graphRevision: workspace.graphRevision,
    target: { type: "artifact", id: "scoped-turn-page" },
    intent: "edit",
    messageChecksum: createHash("sha256").update(message).digest("hex"),
    manifestPath: `context-packs/${CONTEXT_HASH}.json`,
    tokenEstimate: 0,
    omissions: [],
    hash: CONTEXT_HASH,
    items: [],
  });
  const request = {
    workspaceId: workspace.id,
    scopeType: "artifact" as const,
    scopeId: "scoped-turn-page",
    intent: "edit" as const,
    agent: { providerId: "codebuddy" as const, command: "codebuddy" as const, model: "gpt-5.6-sol" },
    message,
    graphRevision: workspace.graphRevision,
    baseRevisionId: revision.id,
    requestContextHash: REQUEST_CONTEXT_HASH,
  };
  const proposal = {
    projectId: project.id,
    kind: "workspace-generation" as const,
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: snapshot.id,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [],
    layoutOperations: [],
    generation: {
      kind: "workspace-generation" as const,
      agent: { providerId: "codebuddy" as const, command: "codebuddy" as const, model: "gpt-5.6-sol" },
      resourceOperations: [],
      artifactPlans: [{
        operation: "revise" as const,
        nodeId: "scoped-turn-page-node",
        artifactId: "scoped-turn-page",
        kind: "page" as const,
        name: "Checkout",
        trackId: "scoped-turn-page-track",
        baseRevisionId: revision.id,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
        dispatchContextPackId: contextPack.id,
      }],
      dependencyPlans: [],
      prototypeIntents: [],
      capabilities: [],
      responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }],
      qualityProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
    },
    rationale: message,
    assumptions: [`Dispatch Context Pack: ${contextPack.id}.`],
  };
  return { project, workspace, request, proposal, contextPack };
}

test("a committed scoped Agent turn replays its exact durable receipt after Store reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "dezin-scoped-turn-reopen-"));
  const file = join(directory, "store.db");
  const first = new Store(file, clock("first"));
  const fixture = seedScopedTurn(first);
  const enqueued = first.workspace.enqueueScopedAgentTurnForProject({
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
    proposal: fixture.proposal,
  });
  assert.equal(enqueued.created, true);
  const receipt = enqueued.receipt;
  first.close();

  const reopened = new Store(file, clock("reopened"));
  const replay = reopened.workspace.getScopedAgentTurnReceiptForProject(
    fixture.project.id,
    TURN_ID,
    fixture.request,
  );

  assert.deepEqual(replay, receipt);
  assert.equal(replay?.task.target.type, "artifact");
  assert.deepEqual(
    (replay?.task.payload as { agent?: unknown }).agent,
    fixture.request.agent,
  );
  assert.equal(replay?.contextPackId, fixture.contextPack.id);
  assert.equal(
    Number((reopened.db.prepare("SELECT COUNT(*) AS count FROM scoped_agent_turns").get() as { count: number }).count),
    1,
  );
  assert.equal(
    Number((reopened.db.prepare("SELECT COUNT(*) AS count FROM generation_plans").get() as { count: number }).count),
    1,
  );
  reopened.close();
  rmSync(directory, { recursive: true, force: true });
});

test("reusing one scoped Agent turn id for divergent immutable request facts fails closed", () => {
  const store = new Store(":memory:", clock("divergence"));
  const fixture = seedScopedTurn(store);
  const receipt = store.workspace.enqueueScopedAgentTurnForProject({
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
    proposal: fixture.proposal,
  }).receipt;
  const divergent = {
    ...fixture.request,
    agent: { ...fixture.request.agent, model: "gpt-5.6-terra" },
  };

  assert.throws(
    () => store.workspace.getScopedAgentTurnReceiptForProject(
      fixture.project.id,
      TURN_ID,
      divergent,
    ),
    (error: unknown) => error instanceof ScopedAgentTurnConflictError
      && error.turnId === TURN_ID
      && error.expectedRequestHash === receipt.requestHash
      && error.actualRequestHash !== receipt.requestHash,
  );
  assert.throws(
    () => store.workspace.enqueueScopedAgentTurnForProject({
      projectId: fixture.project.id,
      turnId: TURN_ID,
      request: divergent,
      contextPackId: fixture.contextPack.id,
      proposal: { ...fixture.proposal, rationale: divergent.message },
    }),
    ScopedAgentTurnConflictError,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM scoped_agent_turns").get() as { count: number }).count),
    1,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM generation_plans").get() as { count: number }).count),
    1,
  );
  store.close();
});

test("an exact scoped request cannot silently swap its derived Context Pack or Proposal", () => {
  const store = new Store(":memory:", clock("derived-divergence"));
  const fixture = seedScopedTurn(store);
  const original = store.workspace.enqueueScopedAgentTurnForProject({
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
    proposal: fixture.proposal,
  });
  const substitutedHash = "d".repeat(64);
  const substitutedPack = store.workspace.persistContextPack({
    id: `context-pack-${substitutedHash}`,
    workspaceId: fixture.workspace.id,
    graphRevision: fixture.request.graphRevision,
    target: { type: fixture.request.scopeType, id: fixture.request.scopeId },
    intent: fixture.request.intent,
    messageChecksum: createHash("sha256").update(fixture.request.message).digest("hex"),
    manifestPath: `context-packs/${substitutedHash}.json`,
    tokenEstimate: 0,
    omissions: [],
    hash: substitutedHash,
    items: [],
  });
  const substitutedProposal = structuredClone(fixture.proposal);
  substitutedProposal.generation.artifactPlans[0]!.dispatchContextPackId = substitutedPack.id;
  substitutedProposal.assumptions = [`Dispatch Context Pack: ${substitutedPack.id}.`];

  assert.throws(
    () => store.workspace.enqueueScopedAgentTurnForProject({
      projectId: fixture.project.id,
      turnId: TURN_ID,
      request: fixture.request,
      contextPackId: substitutedPack.id,
      proposal: substitutedProposal,
    }),
    (error: unknown) => error instanceof ScopedAgentTurnDerivedInputConflictError
      && error.turnId === TURN_ID,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM scoped_agent_turns").get() as { count: number }).count),
    1,
  );
  assert.equal(store.workspace.listProposals(fixture.project.id).length, 1);
  assert.equal(store.workspace.listGenerationPlans(fixture.project.id).length, 1);
  assert.equal(
    store.workspace.getScopedAgentTurnReceiptForProject(
      fixture.project.id,
      TURN_ID,
      fixture.request,
    )?.task.id,
    original.receipt.task.id,
  );
  store.close();
});

test("scoped Agent receipt reads fail closed on a substituted Context Pack pointer", () => {
  const store = new Store(":memory:", clock("receipt-corruption"));
  const fixture = seedScopedTurn(store);
  store.workspace.enqueueScopedAgentTurnForProject({
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
    proposal: fixture.proposal,
  });
  const substitutedHash = "e".repeat(64);
  const substituted = store.workspace.persistContextPack({
    id: `context-pack-${substitutedHash}`,
    workspaceId: fixture.workspace.id,
    graphRevision: fixture.request.graphRevision,
    target: { type: fixture.request.scopeType, id: fixture.request.scopeId },
    intent: "generate",
    messageChecksum: createHash("sha256").update(fixture.request.message).digest("hex"),
    manifestPath: `context-packs/${substitutedHash}.json`,
    tokenEstimate: 0,
    omissions: [],
    hash: substitutedHash,
    items: [],
  });
  store.db.exec("DROP TRIGGER scoped_agent_turn_update_immutable");
  store.db.prepare(
    "UPDATE scoped_agent_turns SET context_pack_id = ? WHERE workspace_id = ? AND turn_id = ?",
  ).run(substituted.id, fixture.workspace.id, TURN_ID);

  assert.throws(
    () => store.workspace.getScopedAgentTurnReceiptForProject(
      fixture.project.id,
      TURN_ID,
      fixture.request,
    ),
    /durable receipt.*inconsistent/i,
  );
  store.close();
});

test("scoped Agent turn ids reject uppercase, surrounding whitespace, and non-v4 UUIDs", () => {
  const store = new Store(":memory:", clock("canonical-id"));
  const fixture = seedScopedTurn(store);
  for (const invalid of [
    TURN_ID.toUpperCase(),
    ` ${TURN_ID}`,
    "turn-550e8400-e29b-11d4-a716-446655440000",
    "turn-550e8400-e29b-41d4-7716-446655440000",
  ]) {
    assert.throws(
      () => store.workspace.getScopedAgentTurnReceiptForProject(
        fixture.project.id,
        invalid,
        fixture.request,
      ),
      /canonical.*lowercase UUID v4/i,
    );
  }
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM scoped_agent_turns").get() as { count: number }).count),
    0,
  );
  store.close();
});

function runEnqueueWorker(
  file: string,
  prefix: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      import(workerData.moduleUrl).then(({ Store }) => {
        let sequence = 0;
        const store = new Store(workerData.file, {
          now: () => 200_000 + ++sequence,
          id: () => workerData.prefix + "-" + ++sequence,
        });
        try {
          const result = store.workspace.enqueueScopedAgentTurnForProject(workerData.input);
          parentPort.postMessage({ ok: true, result });
        } catch (error) {
          parentPort.postMessage({ ok: false, name: error?.name, message: error?.message ?? String(error) });
        } finally {
          store.close();
        }
      }).catch((error) => parentPort.postMessage({ ok: false, name: error?.name, message: error?.stack }));
    `, {
      eval: true,
      workerData: {
        file,
        prefix,
        input,
        moduleUrl: new URL("../src/index.ts", import.meta.url).href,
      },
    });
    worker.once("message", (message) => {
      resolve(message as Record<string, unknown>);
      void worker.terminate();
    });
    worker.once("error", reject);
  });
}

test("two Store connections racing one scoped Agent turn converge on one Plan and receipt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dezin-scoped-turn-race-"));
  const file = join(directory, "store.db");
  const bootstrap = new Store(file, clock("bootstrap"));
  const fixture = seedScopedTurn(bootstrap);
  const input = {
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
    proposal: fixture.proposal,
  };
  bootstrap.close();

  const results = await Promise.all([
    runEnqueueWorker(file, "racer-a", input),
    runEnqueueWorker(file, "racer-b", input),
  ]);

  assert.deepEqual(results.map(({ ok }) => ok), [true, true]);
  const firstResult = results[0]?.result as { created: boolean; receipt: unknown };
  const secondResult = results[1]?.result as { created: boolean; receipt: unknown };
  assert.deepEqual(firstResult.receipt, secondResult.receipt);
  assert.deepEqual([firstResult.created, secondResult.created].sort(), [false, true]);
  const verification = new Store(file, clock("verification"));
  assert.equal(
    Number((verification.db.prepare("SELECT COUNT(*) AS count FROM scoped_agent_turns").get() as { count: number }).count),
    1,
  );
  assert.equal(
    Number((verification.db.prepare("SELECT COUNT(*) AS count FROM workspace_proposals").get() as { count: number }).count),
    1,
  );
  assert.equal(
    Number((verification.db.prepare("SELECT COUNT(*) AS count FROM generation_plans").get() as { count: number }).count),
    1,
  );
  assert.throws(
    () => verification.db.prepare("DELETE FROM scoped_agent_turns").run(),
    /Scoped Agent turn.*immutable/i,
  );
  verification.deleteProject(fixture.project.id);
  assert.equal(
    Number((verification.db.prepare("SELECT COUNT(*) AS count FROM scoped_agent_turns").get() as { count: number }).count),
    0,
  );
  verification.close();
  rmSync(directory, { recursive: true, force: true });
});
