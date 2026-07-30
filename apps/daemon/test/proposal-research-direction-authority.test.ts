import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GenerationPlanCompileError,
  Store,
  type WorkspaceGenerationPayload,
} from "../../../packages/core/src/index.ts";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import { resourceAdapters } from "../src/context/adapters/index.ts";
import {
  assertProposalResearchDirectionMembership,
} from "../src/orchestration/proposal-research-direction-authority.ts";
import { ensureStandardProjectWorkspace } from "../src/workspace-migration.ts";
import {
  createResearchRevisionFixture,
  persistResearchRevisionFixtureContextPack,
} from "./support/research-resource-fixture.ts";

const FROZEN_CODEBUDDY_AGENT = Object.freeze({
  providerId: "codebuddy" as const,
  command: "codebuddy" as const,
  model: "gpt-5.6-sol",
  executionAuthority: {
    kind: "generator" as const,
    baseUrl: "",
    organization: "",
    credentialProviderId: "codebuddy",
    credentialSource: "session" as const,
    credentialRequired: false,
  },
});

const FROZEN_CLAUDE_REVIEWER = Object.freeze({
  providerId: "claude" as const,
  command: "claude" as const,
  model: null,
  executionAuthority: {
    kind: "reviewer" as const,
    baseUrl: "",
    credentialSource: "session" as const,
    credentialRequired: false,
  },
});

async function seedResearchWorkspace(store: Store, dataDir: string) {
  const project = store.createProject({
    name: "Proposal research direction authority",
    mode: "standard",
  });
  const conversation = store.createConversation(project.id, "Legacy seed");
  const variant = store.createVariant(project.id, "Main");
  store.setActiveVariant(project.id, variant.id);
  const repository = join(dataDir, "projects", project.id);
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, "index.html"), "<main>Legacy seed</main>\n", "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Dezin Test"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "dezin@example.test"], { cwd: repository });
  execFileSync("git", ["add", "index.html"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "legacy seed"], { cwd: repository, stdio: "ignore" });
  const commitHash = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash,
    createdAt: 1,
    finishedAt: 2,
    lintPassed: true,
    score: 100,
  });
  const migrated = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);
  assert.equal(migrated.status, "ready");

  const initial = store.workspace.getWorkspace(project.id)!;
  const research = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "KITE Film Festival Research",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
  });
  const contextPack = persistResearchRevisionFixtureContextPack({
    store,
    manifestRoot: dataDir,
    workspaceId: initial.id,
    resourceId: research.resource.id,
    graphRevision: store.workspace.getWorkspace(project.id)!.graphRevision,
  });
  const fixture = createResearchRevisionFixture({
    workspaceId: initial.id,
    resourceId: research.resource.id,
    contextPack,
  });
  await writeFile(
    join(repository, "research.json"),
    `${JSON.stringify(fixture.bundle)}\n`,
    "utf8",
  );
  const sealed = await resourceAdapters.require("research").snapshot({
    workspaceId: initial.id,
    resourceId: research.resource.id,
    revisionId: "research-revision-direction-authority",
    kind: "research",
    workspaceRoot: repository,
    snapshotRoot: dataDir,
    source: { type: "owned-file", path: "research.json", mimeType: "application/json" },
    provenance: fixture.provenance,
    createdAt: 1,
  });
  const revision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    research.resource.id,
    {
      revisionId: sealed.id,
      parentRevisionId: null,
      manifestPath: sealed.manifestPath,
      summary: "Two fixture directions",
      metadata: {
        mimeType: sealed.mimeType,
        ...fixture.metadata,
      },
      checksum: sealed.checksum,
      provenance: sealed.provenance,
    },
  );
  const resourceSnapshot = store.workspace.publishResourceRevisionForProject(
    project.id,
    research.resource.id,
    revision.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: research.snapshot.id,
      reason: "Publish Research fixture",
    },
  );
  const researchNode = store.workspace.getGraph(project.id).nodes.find((node) => (
    node.kind === "resource" && node.resourceId === research.resource.id
  ));
  assert.ok(researchNode);
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: research.snapshot.graphRevision,
    expectedSnapshotId: resourceSnapshot.id,
    commands: [{
      id: "add-program-card",
      type: "add-node",
      node: {
        id: "program-card-node",
        kind: "component",
        name: "KITE Program Card",
        artifactId: "program-card",
        createIdentity: { initialTrackId: "program-card-track" },
      },
    }],
  });
  return {
    project,
    research: research.resource,
    revision,
    researchNodeId: researchNode.id,
  };
}

function generationPayload(input: {
  researchNodeId: string;
  resourceId: string;
  revisionId: string;
  directionId: string;
  directionIds?: readonly string[];
}): WorkspaceGenerationPayload {
  return {
    kind: "workspace-generation",
    agent: FROZEN_CODEBUDDY_AGENT,
    reviewerAgent: FROZEN_CLAUDE_REVIEWER,
    resourceOperations: [{
      operation: "reuse",
      nodeId: input.researchNodeId,
      resourceId: input.resourceId,
      kind: "research",
      title: "KITE Film Festival Research",
      revisionPolicy: { kind: "exact", resourceRevisionId: input.revisionId },
    }],
    artifactPlans: [{
      operation: "create",
      nodeId: "program-card-node",
      artifactId: "program-card",
      kind: "component",
      name: "KITE Program Card",
      trackId: "program-card-track",
      baseRevisionId: null,
      dependsOnArtifactIds: [],
      capabilityIds: [],
      responsiveFrameIds: ["desktop"],
      researchDirectionSelection: {
        protocol: "dezin.research-direction-selection.v1",
        version: 1,
        resourceId: input.resourceId,
        revisionId: input.revisionId,
        directionId: input.directionId,
        ...(input.directionIds === undefined ? {} : { directionIds: [...input.directionIds] }),
      },
    }],
    dependencyPlans: [{
      kind: "resource",
      ownerArtifactId: "program-card",
      resourceId: input.resourceId,
    }],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function createPendingProposal(
  store: Store,
  projectId: string,
  generation: WorkspaceGenerationPayload,
) {
  const workspace = store.workspace.getWorkspace(projectId)!;
  const layout = store.workspace.getLayout(projectId);
  return store.workspace.createProposal({
    projectId,
    kind: "workspace-generation",
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [],
    layoutOperations: [],
    generation,
    rationale: "Revise the Program Card against one exact Research direction.",
    assumptions: [],
  });
}

test("approval authority accepts exact Research direction membership and rejects corrupt ids like the live KITE failure", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-proposal-research-direction-"));
  const store = new Store(join(dataDir, "store.db"));
  try {
    const seeded = await seedResearchWorkspace(store, dataDir);
    const valid = createPendingProposal(
      store,
      seeded.project.id,
      generationPayload({
        researchNodeId: seeded.researchNodeId,
        resourceId: seeded.research.id,
        revisionId: seeded.revision.id,
        directionId: "quiet-confidence",
      }),
    );
    await assert.doesNotReject(() => assertProposalResearchDirectionMembership({
      store,
      dataDir,
      projectId: seeded.project.id,
      proposal: valid,
    }));

    const multi = createPendingProposal(
      store,
      seeded.project.id,
      generationPayload({
        researchNodeId: seeded.researchNodeId,
        resourceId: seeded.research.id,
        revisionId: seeded.revision.id,
        directionId: "quiet-confidence",
        directionIds: ["quiet-confidence", "expressive-confirmation"],
      }),
    );
    await assert.doesNotReject(() => assertProposalResearchDirectionMembership({
      store,
      dataDir,
      projectId: seeded.project.id,
      proposal: multi,
    }));

    // Live KITE acceptance failure: Agent emitted directionId "s".
    const corrupt = createPendingProposal(
      store,
      seeded.project.id,
      generationPayload({
        researchNodeId: seeded.researchNodeId,
        resourceId: seeded.research.id,
        revisionId: seeded.revision.id,
        directionId: "s",
      }),
    );
    await assert.rejects(
      () => assertProposalResearchDirectionMembership({
        store,
        dataDir,
        projectId: seeded.project.id,
        proposal: corrupt,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationPlanCompileError);
        assert.equal(error.code, "invalid-reference");
        assert.match(error.message, /missing or ambiguous in its pinned Revision/i);
        assert.deepEqual(error.details.missingDirectionIds, ["s"]);
        assert.deepEqual(
          new Set(error.details.availableDirectionIds as string[]),
          new Set(["quiet-confidence", "expressive-confirmation"]),
        );
        return true;
      },
    );
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("approve Proposal HTTP rejects corrupt Research direction selection before a Plan is queued", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-proposal-research-direction-http-"));
  const store = new Store(join(dataDir, "store.db"));
  const ticks: string[] = [];
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const server = createApp({
    store,
    dataDir,
    runtimeSupervisor,
    generationPlanRuntime: {
      requestTick() { ticks.push("tick"); },
      requestCancellation() {},
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const seeded = await seedResearchWorkspace(store, dataDir);
    const proposal = createPendingProposal(
      store,
      seeded.project.id,
      generationPayload({
        researchNodeId: seeded.researchNodeId,
        resourceId: seeded.research.id,
        revisionId: seeded.revision.id,
        directionId: "s",
      }),
    );
    const response = await fetch(
      `${base}/api/projects/${seeded.project.id}/workspace/proposals/${proposal.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "generate" }),
      },
    );
    assert.equal(response.status, 422);
    const body = await response.json() as {
      code?: string;
      error?: string;
      details?: { missingDirectionIds?: string[] };
    };
    assert.equal(body.code, "invalid_research_direction_selection");
    assert.match(String(body.error), /missing or ambiguous in its pinned Revision/i);
    assert.deepEqual(body.details?.missingDirectionIds, ["s"]);
    assert.equal(store.workspace.listGenerationPlans(seeded.project.id).length, 0);
    assert.equal(ticks.length, 0);
    assert.equal(
      store.workspace.getProposalForProject(seeded.project.id, proposal.id).status,
      "draft",
    );
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
