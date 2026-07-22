import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  Store,
  WorkspaceAgentTurnConflictError,
  type StoreClock,
} from "../src/index.ts";

const TURN_ID = "turn-550e8400-e29b-41d4-a716-446655440010";
const CONTEXT_HASH = "6".repeat(64);
const REQUEST_CONTEXT_HASH = "7".repeat(64);

function clock(prefix: string): StoreClock {
  let sequence = 0;
  return {
    now: () => 300_000 + ++sequence,
    id: () => `${prefix}-${++sequence}`,
  };
}

function seedWorkspaceTurn(store: Store) {
  const project = store.createProject({ name: "Workspace turn idempotency", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const layout = store.workspace.getLayout(project.id);
  const message = "Plan a coherent checkout journey and its supporting components.";
  const contextPack = store.workspace.persistContextPack({
    id: `context-pack-${CONTEXT_HASH}`,
    workspaceId: workspace.id,
    graphRevision: workspace.graphRevision,
    target: { type: "workspace", id: workspace.id },
    intent: "plan",
    messageChecksum: createHash("sha256").update(message).digest("hex"),
    manifestPath: `context-packs/${CONTEXT_HASH}.json`,
    tokenEstimate: 0,
    omissions: [],
    hash: CONTEXT_HASH,
    items: [],
  });
  const request = {
    workspaceId: workspace.id,
    intent: "plan" as const,
    message,
    graphRevision: workspace.graphRevision,
    requestContextHash: REQUEST_CONTEXT_HASH,
  };
  const proposal = {
    projectId: project.id,
    kind: "workspace-generation" as const,
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [],
    layoutOperations: [],
    generation: {
      kind: "workspace-generation" as const,
      resourceOperations: [],
      artifactPlans: [],
      dependencyPlans: [],
      prototypeIntents: [],
      capabilities: [],
      responsiveFrames: [],
      qualityProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
    },
    rationale: "A planner-specific but valid checkout direction.",
    assumptions: [],
  };
  return { project, workspace, request, proposal, contextPack };
}

test("a committed Workspace Agent turn replays its exact current Proposal after Store reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "dezin-workspace-turn-reopen-"));
  const file = join(directory, "store.db");
  const first = new Store(file, clock("first"));
  const fixture = seedWorkspaceTurn(first);
  const committed = first.workspace.commitWorkspaceAgentTurnForProject({
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
    proposal: fixture.proposal,
  });
  assert.equal(committed.created, true);
  first.close();

  const reopened = new Store(file, clock("reopened"));
  const replay = reopened.workspace.getWorkspaceAgentTurnReceiptForProject(
    fixture.project.id,
    TURN_ID,
    fixture.request,
  );

  assert.deepEqual(replay, committed.receipt);
  assert.equal(replay?.proposal.workspaceId, fixture.workspace.id);
  assert.equal(reopened.workspace.listProposals(fixture.project.id).length, 1);
  reopened.close();
  rmSync(directory, { recursive: true, force: true });
});

test("Workspace Agent replay returns the current owned Proposal after its review status changes", () => {
  const store = new Store(":memory:", clock("status-change"));
  const fixture = seedWorkspaceTurn(store);
  const committed = store.workspace.commitWorkspaceAgentTurnForProject({
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
    proposal: fixture.proposal,
  });
  const rejected = store.workspace.rejectProposalForProject(
    fixture.project.id,
    committed.receipt.proposal.id,
  );

  const replay = store.workspace.getWorkspaceAgentTurnReceiptForProject(
    fixture.project.id,
    TURN_ID,
    fixture.request,
  );

  assert.equal(replay?.proposal.id, committed.receipt.proposal.id);
  assert.deepEqual(replay?.proposal, rejected);
  assert.equal(replay?.proposal.status, "rejected");
  assert.equal(store.workspace.listProposals(fixture.project.id).length, 1);
  store.close();
});

test("reusing a Workspace Agent turn id for divergent immutable request facts fails closed", () => {
  const store = new Store(":memory:", clock("divergence"));
  const fixture = seedWorkspaceTurn(store);
  const committed = store.workspace.commitWorkspaceAgentTurnForProject({
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
    proposal: fixture.proposal,
  });
  const divergent = {
    ...fixture.request,
    requestContextHash: "8".repeat(64),
  };

  assert.throws(
    () => store.workspace.getWorkspaceAgentTurnReceiptForProject(
      fixture.project.id,
      TURN_ID,
      divergent,
    ),
    (error: unknown) => error instanceof WorkspaceAgentTurnConflictError
      && error.turnId === TURN_ID
      && error.expectedRequestHash === committed.receipt.requestHash
      && error.actualRequestHash !== committed.receipt.requestHash,
  );
  assert.equal(store.workspace.listProposals(fixture.project.id).length, 1);
  store.close();
});

function runCommitWorker(
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
          now: () => 400_000 + ++sequence,
          id: () => workerData.prefix + "-" + ++sequence,
        });
        try {
          const result = store.workspace.commitWorkspaceAgentTurnForProject(workerData.input);
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

test("concurrent Workspace planners converge on the first committed Proposal without derived conflicts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dezin-workspace-turn-race-"));
  const file = join(directory, "store.db");
  const bootstrap = new Store(file, clock("bootstrap"));
  const fixture = seedWorkspaceTurn(bootstrap);
  const baseInput = {
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
  };
  bootstrap.close();

  const results = await Promise.all([
    runCommitWorker(file, "planner-a", {
      ...baseInput,
      proposal: { ...fixture.proposal, rationale: "Nondeterministic planner direction A." },
    }),
    runCommitWorker(file, "planner-b", {
      ...baseInput,
      proposal: { ...fixture.proposal, rationale: "Nondeterministic planner direction B." },
    }),
  ]);

  assert.deepEqual(results.map(({ ok }) => ok), [true, true]);
  const first = results[0]?.result as { created: boolean; receipt: unknown };
  const second = results[1]?.result as { created: boolean; receipt: unknown };
  assert.deepEqual(first.receipt, second.receipt);
  assert.deepEqual([first.created, second.created].sort(), [false, true]);
  const verification = new Store(file, clock("verification"));
  assert.equal(verification.workspace.listProposals(fixture.project.id).length, 1);
  assert.throws(
    () => verification.db.prepare("DELETE FROM workspace_agent_turns").run(),
    /Workspace Agent turn.*immutable/i,
  );
  verification.deleteProject(fixture.project.id);
  assert.equal(
    Number((verification.db.prepare(
      "SELECT COUNT(*) AS count FROM workspace_agent_turns",
    ).get() as { count: number }).count),
    0,
  );
  verification.close();
  rmSync(directory, { recursive: true, force: true });
});

test("Workspace Agent turns reject noncanonical ids and substituted Context or Proposal anchors", () => {
  const store = new Store(":memory:", clock("validation"));
  const fixture = seedWorkspaceTurn(store);
  for (const invalid of [
    TURN_ID.toUpperCase(),
    ` ${TURN_ID}`,
    "turn-550e8400-e29b-11d4-a716-446655440010",
    "turn-550e8400-e29b-41d4-7716-446655440010",
  ]) {
    assert.throws(
      () => store.workspace.getWorkspaceAgentTurnReceiptForProject(
        fixture.project.id,
        invalid,
        fixture.request,
      ),
      /canonical.*lowercase UUID v4/i,
    );
  }
  const substitutedHash = "9".repeat(64);
  const substitutedPack = store.workspace.persistContextPack({
    id: `context-pack-${substitutedHash}`,
    workspaceId: fixture.workspace.id,
    graphRevision: fixture.request.graphRevision,
    target: { type: "workspace", id: fixture.workspace.id },
    intent: "plan",
    messageChecksum: "a".repeat(64),
    manifestPath: `context-packs/${substitutedHash}.json`,
    tokenEstimate: 0,
    omissions: [],
    hash: substitutedHash,
    items: [],
  });
  assert.throws(
    () => store.workspace.commitWorkspaceAgentTurnForProject({
      projectId: fixture.project.id,
      turnId: TURN_ID,
      request: fixture.request,
      contextPackId: substitutedPack.id,
      proposal: fixture.proposal,
    }),
    /Context Pack.*does not match/i,
  );
  assert.throws(
    () => store.workspace.commitWorkspaceAgentTurnForProject({
      projectId: fixture.project.id,
      turnId: TURN_ID,
      request: fixture.request,
      contextPackId: fixture.contextPack.id,
      proposal: {
        ...fixture.proposal,
        baseGraphRevision: fixture.proposal.baseGraphRevision + 1,
      },
    }),
    /not anchored.*graph Revision/i,
  );
  assert.equal(store.workspace.listProposals(fixture.project.id).length, 0);
  store.close();
});

test("Workspace Agent receipt reads fail closed on a substituted Context Pack pointer", () => {
  const store = new Store(":memory:", clock("read-corruption"));
  const fixture = seedWorkspaceTurn(store);
  store.workspace.commitWorkspaceAgentTurnForProject({
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
    proposal: fixture.proposal,
  });
  const substitutedHash = "a".repeat(64);
  const substitutedPack = store.workspace.persistContextPack({
    id: `context-pack-${substitutedHash}`,
    workspaceId: fixture.workspace.id,
    graphRevision: fixture.request.graphRevision,
    target: { type: "workspace", id: fixture.workspace.id },
    intent: "plan",
    messageChecksum: "b".repeat(64),
    manifestPath: `context-packs/${substitutedHash}.json`,
    tokenEstimate: 0,
    omissions: [],
    hash: substitutedHash,
    items: [],
  });
  store.db.exec("DROP TRIGGER workspace_agent_turn_update_immutable");
  store.db.prepare(
    "UPDATE workspace_agent_turns SET context_pack_id = ? WHERE workspace_id = ? AND turn_id = ?",
  ).run(substitutedPack.id, fixture.workspace.id, TURN_ID);

  assert.throws(
    () => store.workspace.getWorkspaceAgentTurnReceiptForProject(
      fixture.project.id,
      TURN_ID,
      fixture.request,
    ),
    /durable receipt.*inconsistent/i,
  );
  store.close();
});
