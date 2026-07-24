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
  WorkspaceProposalValidationError,
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
    agent: { providerId: "codebuddy" as const, command: "codebuddy" as const, model: "gpt-5.6-sol" },
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
      agent: { providerId: "codebuddy" as const, command: "codebuddy" as const, model: "gpt-5.6-sol" },
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
    agent: { ...fixture.request.agent, model: "gpt-5.6-terra" },
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

test("Workspace Agent turns reject a Proposal whose Agent differs from the immutable request", () => {
  const store = new Store(":memory:", clock("agent-substitution"));
  const fixture = seedWorkspaceTurn(store);

  assert.throws(
    () => store.workspace.commitWorkspaceAgentTurnForProject({
      projectId: fixture.project.id,
      turnId: TURN_ID,
      request: fixture.request,
      contextPackId: fixture.contextPack.id,
      proposal: {
        ...fixture.proposal,
        generation: {
          ...fixture.proposal.generation,
          agent: {
            providerId: "codebuddy",
            command: "codebuddy",
            model: "gpt-5.6-terra",
          },
        },
      },
    }),
    (error: unknown) => error instanceof WorkspaceProposalValidationError
      && /Agent selection.*immutable request/i.test(error.message),
  );
  assert.equal(store.workspace.listProposals(fixture.project.id).length, 0);
  store.close();
});

test("Workspace Agent Proposal edits cannot replace the frozen origin Agent", () => {
  const store = new Store(":memory:", clock("agent-edit"));
  const fixture = seedWorkspaceTurn(store);
  const committed = store.workspace.commitWorkspaceAgentTurnForProject({
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
    proposal: fixture.proposal,
  });
  const original = committed.receipt.proposal;
  assert.equal(original.revision, 1);
  if (original.generation.kind !== "workspace-generation") {
    assert.fail("Workspace Agent fixture must return a Workspace generation Proposal");
  }
  const originalGeneration = original.generation;

  assert.throws(
    () => store.workspace.updateProposalForProject(fixture.project.id, original.id, {
      expectedProposalRevision: original.revision,
      operations: original.operations,
      layoutOperations: original.layoutOperations,
      generation: {
        ...originalGeneration,
        agent: {
          providerId: "codebuddy",
          command: "codebuddy",
          model: "gpt-5.6-terra",
        },
      },
      rationale: original.rationale,
      assumptions: original.assumptions,
    }),
    (error: unknown) => error instanceof WorkspaceProposalValidationError
      && /frozen origin Agent selection/i.test(error.message),
  );

  const after = store.workspace.getProposalForProject(fixture.project.id, original.id);
  assert.equal(after.revision, original.revision);
  assert.deepEqual(after.generation, original.generation);
  assert.equal(Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM workspace_proposal_audit WHERE proposal_id = ?",
  ).get(original.id) as { count: number }).count), 1);
  store.close();
});

test("historical Workspace Agent Proposals without an Agent selection remain readable", () => {
  const store = new Store(":memory:", clock("legacy-agent"));
  const fixture = seedWorkspaceTurn(store);
  const committed = store.workspace.commitWorkspaceAgentTurnForProject({
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
    proposal: fixture.proposal,
  });
  const generationRow = store.db.prepare(
    "SELECT generation_payload_json FROM workspace_proposals WHERE id = ?",
  ).get(committed.receipt.proposal.id) as { generation_payload_json: string };
  const generation = JSON.parse(generationRow.generation_payload_json) as Record<string, unknown>;
  delete generation.agent;
  const auditRow = store.db.prepare(
    "SELECT payload_json FROM workspace_proposal_audit WHERE proposal_id = ? AND revision = 1",
  ).get(committed.receipt.proposal.id) as { payload_json: string };
  const audit = JSON.parse(auditRow.payload_json) as {
    generation: Record<string, unknown>;
  };
  delete audit.generation.agent;
  store.db.exec("DROP TRIGGER workspace_proposal_audit_update_immutable");
  store.db.prepare(
    "UPDATE workspace_proposals SET generation_payload_json = ? WHERE id = ?",
  ).run(JSON.stringify(generation), committed.receipt.proposal.id);
  store.db.prepare(
    "UPDATE workspace_proposal_audit SET payload_json = ? WHERE proposal_id = ? AND revision = 1",
  ).run(JSON.stringify(audit), committed.receipt.proposal.id);

  const proposal = store.workspace.getProposalForProject(
    fixture.project.id,
    committed.receipt.proposal.id,
  );
  assert.equal(proposal.generation.kind, "workspace-generation");
  assert.equal(proposal.generation.agent, undefined);
  const replay = store.workspace.getWorkspaceAgentTurnReceiptForProject(
    fixture.project.id,
    TURN_ID,
    fixture.request,
  );
  assert.equal(replay?.proposal.generation.kind, "workspace-generation");
  assert.equal(
    replay?.proposal.generation.kind === "workspace-generation"
      ? replay.proposal.generation.agent
      : "unexpected-kind",
    undefined,
  );
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

test("latest actionable Workspace Agent Plan discovery restores unresolved work and excludes unrelated history", () => {
  const store = new Store(":memory:", clock("latest-actionable-plan"));
  const fixture = seedWorkspaceTurn(store);
  const committed = store.workspace.commitWorkspaceAgentTurnForProject({
    projectId: fixture.project.id,
    turnId: TURN_ID,
    request: fixture.request,
    contextPackId: fixture.contextPack.id,
    proposal: fixture.proposal,
  });
  assert.equal(
    store.workspace.getLatestActionableWorkspaceAgentGenerationPlanForProject(fixture.project.id),
    null,
  );

  const approved = store.workspace.approveProposalForProject(
    fixture.project.id,
    committed.receipt.proposal.id,
    "generate",
  );
  assert.ok(approved.plan);

  const unrelated = store.workspace.createProposal({
    ...fixture.proposal,
    rationale: "A newer direct Proposal must not impersonate Workspace Agent history.",
  });
  const unrelatedApproval = store.workspace.approveProposalForProject(
    fixture.project.id,
    unrelated.id,
    "generate",
  );
  assert.ok(unrelatedApproval.plan);

  assert.equal(
    store.workspace.getLatestActionableWorkspaceAgentGenerationPlanForProject(fixture.project.id)?.id,
    approved.plan.id,
  );

  const compiled = store.workspace.compileApprovedGenerationPlanForProject(
    fixture.project.id,
    approved.plan.id,
  );
  const rootTask = compiled.tasks.find((task) => task.dependencyIds.length === 0);
  assert.ok(rootTask);
  store.db.exec("DROP TRIGGER generation_plan_status_transition_guard");
  store.db.prepare(
    `UPDATE generation_plans
     SET status = 'requires-new-impact'
     WHERE id = ?`,
  ).run(approved.plan.id);
  assert.equal(
    store.workspace.getLatestActionableWorkspaceAgentGenerationPlanForProject(fixture.project.id)?.id,
    approved.plan.id,
  );

  store.db.prepare(
    `UPDATE generation_plans
     SET status = 'queued'
     WHERE id = ?`,
  ).run(approved.plan.id);
  store.workspace.recordGenerationTaskMaterializationFailureForProject(
    fixture.project.id,
    approved.plan.id,
    {
      taskId: rootTask.id,
      expectedFailureCount: 0,
      failureClass: "design",
      error: { message: "Generated design payload was invalid." },
      nextEligibleAt: null,
    },
  );
  assert.equal(
    store.workspace.getLatestActionableWorkspaceAgentGenerationPlanForProject(fixture.project.id)?.id,
    approved.plan.id,
  );

  store.db.exec("DROP TRIGGER generation_plan_terminal_state_guard");
  store.db.prepare(
    `UPDATE generation_plans
     SET status = 'succeeded', finished_at = ?
     WHERE id = ?`,
  ).run(400_001, approved.plan.id);
  assert.equal(
    store.workspace.getLatestActionableWorkspaceAgentGenerationPlanForProject(fixture.project.id),
    null,
  );

  store.db.prepare(
    `UPDATE generation_plans
     SET status = 'cancelled', finished_at = ?
     WHERE id = ?`,
  ).run(400_002, approved.plan.id);
  assert.equal(
    store.workspace.getLatestActionableWorkspaceAgentGenerationPlanForProject(fixture.project.id),
    null,
  );
  assert.equal(
    store.workspace.getLatestActionableWorkspaceAgentGenerationPlanForProject("missing-project"),
    null,
  );
  store.close();
});
