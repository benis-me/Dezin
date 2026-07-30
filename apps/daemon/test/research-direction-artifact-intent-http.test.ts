import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import { resourceAdapters } from "../src/context/adapters/index.ts";
import { ensureStandardProjectWorkspace } from "../src/workspace-migration.ts";
import {
  createResearchRevisionFixture,
  persistResearchRevisionFixtureContextPack,
} from "./support/research-resource-fixture.ts";

const SELECTION_ID = "selection-00000000-0000-4000-8000-000000000011";
const HYPOTHESIS_SELECTION_ID = "selection-00000000-0000-4000-8000-000000000012";
const FROZEN_TRAE_AGENT = Object.freeze({
  providerId: "trae",
  command: "trae-cli",
  model: "doubao-seed-1.6",
  executionAuthority: {
    kind: "generator" as const,
    baseUrl: "",
    organization: "",
    credentialProviderId: "trae",
    credentialSource: "session" as const,
    credentialRequired: false,
  },
});
const FROZEN_CLAUDE_REVIEWER = Object.freeze({
  providerId: "claude",
  command: "claude",
  model: null,
  executionAuthority: {
    kind: "reviewer" as const,
    baseUrl: "",
    credentialSource: "session" as const,
    credentialRequired: false,
  },
});

async function withServer(run: (input: {
  base: string;
  dataDir: string;
  store: Store;
  ticks: string[];
}) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-research-intent-http-"));
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
  try {
    await run({ base: `http://127.0.0.1:${port}`, dataDir, store, ticks });
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function seed(store: Store, dataDir: string) {
  const project = store.createProject({ name: "Research direction HTTP", mode: "standard" });
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
  const commitHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
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
    title: "Checkout decision research",
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
    revisionId: "research-revision-http",
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
      summary: "One evidence and one hypothesis direction",
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
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: research.snapshot.graphRevision,
    expectedSnapshotId: resourceSnapshot.id,
    commands: [{
      id: "add-checkout-target",
      type: "add-node",
      node: {
        id: "checkout-target-node",
        kind: "page",
        name: "Checkout target",
        artifactId: "checkout-target",
        createIdentity: { initialTrackId: "checkout-target-track" },
      },
    }],
  });
  return { project, research, revision };
}

function requestBody(
  store: Store,
  projectId: string,
  resourceId: string,
  selectionRequestId: string,
  confirmHypothesis = false,
) {
  const workspace = store.workspace.getWorkspace(projectId)!;
  const layout = store.workspace.getLayout(projectId);
  const resource = store.workspace.getResourceForProject(projectId, resourceId)!;
  return {
    selectionRequestId,
    artifactId: "checkout-target",
    agentCommand: FROZEN_TRAE_AGENT.command,
    model: FROZEN_TRAE_AGENT.model,
    expectedResourceHeadRevisionId: resource.headRevisionId,
    expectedGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
    expectedLayoutChecksum: layout.checksum,
    confirmHypothesis,
  };
}

function durableIntentState(store: Store, projectId: string) {
  return structuredClone({
    workspace: store.workspace.getWorkspace(projectId),
    graph: store.workspace.getGraph(projectId),
    snapshots: store.workspace.listSnapshots(projectId),
    layout: store.workspace.getLayout(projectId),
    proposals: store.workspace.listProposals(projectId),
    plans: store.workspace.listGenerationPlans(projectId),
    intentRows: store.db.prepare(
      "SELECT * FROM research_direction_artifact_intents ORDER BY request_id",
    ).all(),
  });
}

test("Research viewer and selection HTTP preserve evidence quality, exact idempotency, and visible dependency", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const { project, research, revision } = await seed(store, dataDir);
    const revisionUrl = `${base}/api/projects/${project.id}/resources/${research.resource.id}/revisions/${revision.id}`;

    const viewResponse = await fetch(`${revisionUrl}/research`);
    const view = await viewResponse.json() as {
      qualityState: string;
      evidenceDirectionCount: number;
      hypothesisDirectionCount: number;
      sources: Array<{ verification: string }>;
      directions: Array<{ id: string; evidenceStatus: string }>;
      openQuestions: string[];
    };
    assert.equal(viewResponse.status, 200, JSON.stringify(view));
    assert.equal(view.qualityState, "grounded");
    assert.equal(view.evidenceDirectionCount, 1);
    assert.equal(view.hypothesisDirectionCount, 1);
    assert.deepEqual(view.sources.map((source) => source.verification), ["verified", "unverified"]);
    assert.deepEqual(view.directions.map((direction) => direction.evidenceStatus), ["evidence", "hypothesis"]);
    assert.equal(view.openQuestions.length, 1);

    const body = requestBody(store, project.id, research.resource.id, SELECTION_ID);
    for (const invalidBody of [
      { ...body, providerId: "codebuddy" },
      { ...body, agentCommand: undefined },
      { ...body, agentCommand: "unknown-agent" },
      { ...body, model: " doubao-seed-1.6" },
    ]) {
      const invalidAgent = await fetch(`${revisionUrl}/directions/quiet-confidence/artifact-intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invalidBody),
      });
      assert.equal(invalidAgent.status, 400, await invalidAgent.text());
    }
    const staleHead = await fetch(`${revisionUrl}/directions/quiet-confidence/artifact-intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, expectedResourceHeadRevisionId: "research-revision-stale" }),
    });
    assert.equal(staleHead.status, 409);
    assert.equal(Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM generation_plans",
    ).get() as { count: number }).count), 0);
    const post = () => fetch(`${revisionUrl}/directions/quiet-confidence/artifact-intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const responses = await Promise.all([post(), post()]);
    const results = await Promise.all(responses.map(async (response) => ({
      status: response.status,
      body: await response.json() as {
        proposal: {
          id: string;
          generation: {
            agent: typeof FROZEN_TRAE_AGENT;
            reviewerAgent: typeof FROZEN_CLAUDE_REVIEWER;
          };
        };
        plan: { id: string };
        task: { id: string };
      },
    })));
    assert.deepEqual(results.map(({ status }) => status).sort(), [200, 201]);
    assert.deepEqual(results[0]!.body.proposal.generation.agent, FROZEN_TRAE_AGENT);
    assert.deepEqual(
      results[0]!.body.proposal.generation.reviewerAgent,
      FROZEN_CLAUDE_REVIEWER,
    );
    assert.equal(new Set(results.map(({ body: result }) => result.proposal.id)).size, 1);
    assert.equal(new Set(results.map(({ body: result }) => result.plan.id)).size, 1);
    assert.equal(new Set(results.map(({ body: result }) => result.task.id)).size, 1);
    assert.equal(Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM research_direction_artifact_intents",
    ).get() as { count: number }).count), 1);
    assert.equal(Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM generation_plans",
    ).get() as { count: number }).count), 1);
    for (const agentOverride of [
      { agentCommand: "claude", model: null },
      { agentCommand: "codebuddy", model: "gpt-5.6-terra" },
    ]) {
      const divergentAgent = await fetch(`${revisionUrl}/directions/quiet-confidence/artifact-intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, ...agentOverride }),
      });
      assert.equal(divergentAgent.status, 409);
      assert.equal(
        (await divergentAgent.json() as { code: string }).code,
        "research_direction_intent_request_conflict",
      );
    }
    assert.equal(store.workspace.getGraph(project.id).edges.filter((edge) => edge.kind === "informs"
      && edge.sourceNodeId === research.node.id
      && edge.targetNodeId === "checkout-target-node").length, 1);

    const current = store.workspace.getWorkspace(project.id)!;
    store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: current.graphRevision,
      expectedSnapshotId: current.activeSnapshotId,
      commands: [{
        id: "add-later-unrelated-node",
        type: "add-node",
        node: {
          id: "later-unrelated-node",
          kind: "component",
          name: "Later unrelated component",
          artifactId: "later-unrelated",
          createIdentity: { initialTrackId: "later-unrelated-track" },
        },
      }],
    });
    const lateReplay = await post();
    const lateBody = await lateReplay.json() as { plan: { id: string } };
    assert.equal(lateReplay.status, 200, JSON.stringify(lateBody));
    assert.equal(lateBody.plan.id, results[0]!.body.plan.id);

    const conflicting = await fetch(`${revisionUrl}/directions/expressive-confirmation/artifact-intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(conflicting.status, 409);
    assert.equal((await conflicting.json() as { code: string }).code, "research_direction_intent_request_conflict");
  });
});

test("hypothesis direction requires explicit confirmation before creating a successor Plan", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const { project, research, revision } = await seed(store, dataDir);
    const url = `${base}/api/projects/${project.id}/resources/${research.resource.id}/revisions/${revision.id}/directions/expressive-confirmation/artifact-intents`;
    const unconfirmedBody = requestBody(
      store,
      project.id,
      research.resource.id,
      HYPOTHESIS_SELECTION_ID,
      false,
    );
    const unconfirmed = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(unconfirmedBody),
    });
    assert.equal(unconfirmed.status, 409);
    assert.equal((await unconfirmed.json() as { code: string }).code, "research_hypothesis_confirmation_required");
    assert.equal(Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM research_direction_artifact_intents",
    ).get() as { count: number }).count), 0);

    const confirmed = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...unconfirmedBody, confirmHypothesis: true }),
    });
    const confirmedBody = await confirmed.json() as {
      proposal?: {
        generation: {
          agent: typeof FROZEN_TRAE_AGENT;
          reviewerAgent: typeof FROZEN_CLAUDE_REVIEWER;
        };
      };
      plan?: { id: string };
      error?: string;
    };
    assert.equal(confirmed.status, 201, JSON.stringify(confirmedBody));
    assert.ok(confirmedBody.plan?.id);
    assert.deepEqual(confirmedBody.proposal?.generation.agent, FROZEN_TRAE_AGENT);
    assert.deepEqual(
      confirmedBody.proposal?.generation.reviewerAgent,
      FROZEN_CLAUDE_REVIEWER,
    );
  });
});

test("Research direction Artifact intent rejects invalid live generator authority before durable mutation", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const { project, research, revision } = await seed(store, dataDir);
    store.updateSettings({
      agentCommand: "claude",
      apiBaseUrl: "https://provider.example.test/v1?route=not-canonical",
      aiProviderId: "",
      aiProviderProfiles: "",
    });
    const before = store.workspace.getWorkspace(project.id)!;
    const beforeLayout = store.workspace.getLayout(project.id);
    const body = {
      ...requestBody(
        store,
        project.id,
        research.resource.id,
        "selection-00000000-0000-4000-8000-000000000013",
      ),
      agentCommand: "claude",
      model: null,
    };

    const response = await fetch(
      `${base}/api/projects/${project.id}/resources/${research.resource.id}/revisions/${revision.id}/directions/quiet-confidence/artifact-intents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const result = await response.json() as { code?: string; error?: string };
    assert.equal(response.status, 422, JSON.stringify(result));
    assert.equal(result.code, "research_direction_intent_invalid");
    assert.doesNotMatch(JSON.stringify(result), /route=not-canonical/);
    assert.equal(Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM workspace_proposals",
    ).get() as { count: number }).count), 0);
    assert.equal(Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM generation_plans",
    ).get() as { count: number }).count), 0);
    assert.equal(Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM research_direction_artifact_intents",
    ).get() as { count: number }).count), 0);
    const after = store.workspace.getWorkspace(project.id)!;
    const afterLayout = store.workspace.getLayout(project.id);
    assert.equal(after.graphRevision, before.graphRevision);
    assert.equal(after.activeSnapshotId, before.activeSnapshotId);
    assert.equal(afterLayout.checksum, beforeLayout.checksum);
  });
});

test("Research direction Artifact intent rejects concurrent Settings authority drift before durable mutation", async (t) => {
  const testCredential = "research-intent-barrier-test-credential";
  const anthropicProfile = (input: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
  }) => JSON.stringify({
    anthropic: {
      enabled: input.enabled,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      apiKeyConfigured: Boolean(input.apiKey),
      models: "",
      organization: "",
    },
  });
  const scenarios = [
    {
      name: "generator endpoint and credential drift",
      selectionRequestId: "selection-00000000-0000-4000-8000-000000000014",
      configure(store: Store) {
        store.updateSettings({
          agentCommand: "claude",
          model: "",
          apiBaseUrl: "https://agent-before.example.test/v1",
          apiKey: testCredential,
          aiProviderId: "",
          aiProviderProfiles: "",
          visualQaAgentCommand: "codex",
          visualQaModel: "",
        });
      },
      requestAgent: { agentCommand: "claude", model: null },
      drift(store: Store) {
        store.updateSettings({
          apiBaseUrl: "https://agent-after.example.test/v1",
          apiKey: "",
        });
      },
    },
    {
      name: "reviewer credential source drift",
      selectionRequestId: "selection-00000000-0000-4000-8000-000000000015",
      configure(store: Store) {
        store.updateSettings({
          agentCommand: FROZEN_TRAE_AGENT.command,
          model: FROZEN_TRAE_AGENT.model,
          apiBaseUrl: "",
          apiKey: "",
          visualQaAgentCommand: "claude",
          visualQaModel: "",
          aiProviderProfiles: anthropicProfile({
            enabled: true,
            baseUrl: "https://reviewer-before.example.test/v1",
            apiKey: testCredential,
          }),
        });
      },
      requestAgent: {
        agentCommand: FROZEN_TRAE_AGENT.command,
        model: FROZEN_TRAE_AGENT.model,
      },
      drift(store: Store) {
        store.updateSettings({
          aiProviderProfiles: anthropicProfile({
            enabled: false,
            baseUrl: "",
            apiKey: "",
          }),
        });
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      await withServer(async ({ base, dataDir, store, ticks }) => {
        const { project, research, revision } = await seed(store, dataDir);
        scenario.configure(store);
        const before = durableIntentState(store, project.id);
        const originalGetSettings = store.getSettings.bind(store);
        let armed = true;
        let releaseDriftBarrier!: () => void;
        const driftBarrier = new Promise<void>((resolve) => {
          releaseDriftBarrier = resolve;
        });
        store.getSettings = (() => {
          const settings = originalGetSettings();
          if (armed) {
            armed = false;
            queueMicrotask(() => {
              scenario.drift(store);
              releaseDriftBarrier();
            });
          }
          return settings;
        }) as typeof store.getSettings;

        try {
          const body = {
            ...requestBody(
              store,
              project.id,
              research.resource.id,
              scenario.selectionRequestId,
            ),
            ...scenario.requestAgent,
          };
          const responsePromise = fetch(
            `${base}/api/projects/${project.id}/resources/${research.resource.id}/revisions/${revision.id}/directions/quiet-confidence/artifact-intents`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          await driftBarrier;
          const response = await responsePromise;
          const result = await response.json() as { code?: string; error?: string };

          assert.equal(response.status, 422, JSON.stringify(result));
          assert.equal(result.code, "research_direction_intent_invalid");
          assert.doesNotMatch(JSON.stringify(result), new RegExp(testCredential));
          assert.deepEqual(durableIntentState(store, project.id), before);
          assert.deepEqual(ticks, []);
        } finally {
          store.getSettings = originalGetSettings;
        }
      });
    });
  }
});
