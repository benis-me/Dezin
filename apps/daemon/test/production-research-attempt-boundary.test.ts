import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  NodeSpawnerOptions,
  ProcessSpawner,
  SpawnInput,
  SpawnOutput,
} from "../../../packages/agent/src/index.ts";
import { Store } from "../../../packages/core/src/index.ts";
import { BUNDLED_DESIGN_SYSTEMS, DesignRegistry } from "../../../packages/design/src/index.ts";
import { sealResourceRevisionPayload } from "../src/context/adapters/file.ts";
import { RuntimeSupervisor } from "../src/runtime-supervisor.ts";
import { createProductionGenerationBootstrap } from "../src/orchestration/production-generation-bootstrap.ts";
import { createProductionResourceRuntimePorts } from "../src/orchestration/production-resource-runtime.ts";
import type { SafeBoundedExternalFetcher } from "../src/resource-revision-source.ts";
import { waitForDurableProgress } from "./support/wait-for-durable-progress.ts";

const TEST_CODEX_EXECUTABLE = "/trusted/codex/install/bin/codex";
const WEB_URL_1 = "https://www.w3.org/WAI/tutorials/images/";
const WEB_URL_2 = "https://analysisfunction.civilservice.gov.uk/policy-store/data-visualisation-charts/";
const WEB_EXCERPT_1 = "Accessible alternatives and meaningful image treatment.";
const WEB_EXCERPT_2 = "Legible chart selection and annotation.";

type JsonRecord = Record<string, any>;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function researchDraft(): JsonRecord {
  return {
    protocol: "dezin.research-generation.v3",
    executiveSummary: "Decision-grade evidence favors a calm editorial system that makes provenance visible.",
    sources: [
      {
        id: "source-web-1",
        kind: "web",
        title: "W3C data visualization accessibility",
        locator: WEB_URL_1,
        excerpt: WEB_EXCERPT_1,
        binding: null,
        notes: "Accessible alternatives and meaningful image treatment.",
      },
      {
        id: "source-web-2",
        kind: "web",
        title: "GOV.UK data visualisation guidance",
        locator: WEB_URL_2,
        excerpt: WEB_EXCERPT_2,
        binding: null,
        notes: "Legible chart selection and annotation.",
      },
    ],
    findings: [
      {
        id: "finding-1",
        statement: "Readers need accessible alternatives near visual evidence.",
        implication: "Pair every chart with concise text alternatives and nearby provenance.",
        confidence: "high",
        supports: [
          { sourceId: "source-web-1", quote: WEB_EXCERPT_1 },
          { sourceId: "source-web-2", quote: WEB_EXCERPT_2 },
        ],
      },
      {
        id: "finding-2",
        statement: "Chart selection and annotation must remain legible.",
        implication: "Use explicit labels and annotations instead of relying on color alone.",
        confidence: "high",
        supports: [
          { sourceId: "source-web-1", quote: WEB_EXCERPT_1 },
          { sourceId: "source-web-2", quote: WEB_EXCERPT_2 },
        ],
      },
      {
        id: "finding-3",
        statement: "Meaningful image treatment and annotation should form one reading sequence.",
        implication: "Lead with one takeaway and progressively disclose supporting detail.",
        confidence: "medium",
        supports: [
          { sourceId: "source-web-1", quote: WEB_EXCERPT_1 },
          { sourceId: "source-web-2", quote: WEB_EXCERPT_2 },
        ],
      },
    ],
    designPrinciples: [
      {
        id: "principle-1",
        title: "Accessible evidence in the reading flow",
        rationale: "Alternatives and provenance belong beside the evidence they explain.",
        findingIds: ["finding-1"],
      },
      {
        id: "principle-2",
        title: "Legibility before decoration",
        rationale: "Labels and annotation must carry meaning independently of color.",
        findingIds: ["finding-2"],
      },
      {
        id: "principle-3",
        title: "One narrative with layered detail",
        rationale: "Scanning and close reading should follow the same hierarchy.",
        findingIds: ["finding-3"],
      },
    ],
    directions: [
      {
        id: "direction-field-journal",
        title: "Field Journal",
        thesis: "A measured editorial report with annotated evidence bands.",
        visualLanguage: ["warm paper ground", "precise ink hierarchy", "quiet evidence rules"],
        interactionPrinciples: ["stable scroll narrative", "details expand in place"],
        risks: ["The direction can feel archival without current-state signals."],
        findingIds: ["finding-1", "finding-3"],
      },
      {
        id: "direction-signal-desk",
        title: "Signal Desk",
        thesis: "A compact operational surface that foregrounds change and confidence.",
        visualLanguage: ["cool neutral canvas", "high-contrast signal marks", "tabular typography"],
        interactionPrinciples: ["keyboard-first comparison", "persistent provenance drawer"],
        risks: ["The direction can become dashboard-like without an editorial lead."],
        findingIds: ["finding-1", "finding-2"],
      },
    ],
    openQuestions: [
      "Which metrics have stable update cadences?",
      "Which claims need downloadable source tables?",
    ],
  };
}

function codexJsonlOutput(value: unknown, invocation: number): SpawnOutput {
  return {
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: `thread-research-${invocation}` }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: `message-research-${invocation}`,
          type: "agent_message",
          text: JSON.stringify(value),
        },
      }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n"),
    stderr: "",
    exitCode: 0,
  };
}

function immutableTaskEnvelope(stdin: string): JsonRecord {
  const match = /IMMUTABLE_TASK_JSON_UTF8_BYTES=(\d+)\n/.exec(stdin);
  assert.ok(match?.index !== undefined, "Resource Agent transport must carry the immutable Task marker");
  const byteLength = Number(match[1]);
  const start = match.index + match[0].length;
  const bytes = Buffer.from(stdin.slice(start), "utf8");
  assert.ok(bytes.byteLength >= byteLength, "immutable Task bytes must be complete");
  return JSON.parse(bytes.subarray(0, byteLength).toString("utf8")) as JsonRecord;
}

class RecordingSpawner implements ProcessSpawner {
  readonly inputs: SpawnInput[] = [];
  readonly schemas: JsonRecord[] = [];
  readonly envelopes: JsonRecord[] = [];

  async run(input: SpawnInput): Promise<SpawnOutput> {
    this.inputs.push(input);
    const schemaArgumentIndex = input.args.indexOf("--output-schema");
    assert.notEqual(schemaArgumentIndex, -1, "Codex Research must receive its runtime output schema");
    const schemaPath = input.args[schemaArgumentIndex + 1];
    assert.equal(typeof schemaPath, "string");
    this.schemas.push(JSON.parse(await readFile(schemaPath!, "utf8")) as JsonRecord);
    this.envelopes.push(immutableTaskEnvelope(input.stdin));
    return codexJsonlOutput(researchDraft(), this.inputs.length);
  }
}

function evidenceFetcher(input: {
  rejectRepair: boolean;
  counts: Map<string, number>;
}): SafeBoundedExternalFetcher {
  return async (request) => {
    const count = (input.counts.get(request.url) ?? 0) + 1;
    input.counts.set(request.url, count);
    if (request.url === WEB_URL_2 && (input.rejectRepair || count === 1)) {
      throw new Error("deterministic canonical evidence outage");
    }
    const excerpt = request.url === WEB_URL_1 ? WEB_EXCERPT_1 : WEB_EXCERPT_2;
    return {
      finalUrl: request.url,
      status: 200,
      mimeType: "text/html; charset=utf-8",
      bytes: Buffer.from(`<html><body><p>Before. ${excerpt} After.</p></body></html>`, "utf8"),
    };
  };
}

function assertPriorResearchExcludedFromCurrentEvidence(
  spawner: RecordingSpawner,
  priorResourceId: string,
  priorRevisionId: string,
): void {
  assert.equal(spawner.inputs.length, 2, "one Attempt owns exactly an initial turn and one repair turn");
  assert.equal(spawner.schemas.length, 2);
  assert.equal(spawner.envelopes.length, 2);
  for (const [index, envelope] of spawner.envelopes.entries()) {
    const prior = envelope.contextPack.items.find((item: JsonRecord) => (
      item.ref?.kind === "resource"
      && item.ref?.id === priorResourceId
      && item.ref?.resourceKind === "research"
      && item.ref?.revisionId === priorRevisionId
    ));
    assert.ok(prior, "the immutable prior Research Revision remains visible in the full Context Pack");
    assert.equal(
      envelope.contextSourceOptions.some(
        (option: JsonRecord) => option.binding?.itemOrdinal === prior.ordinal,
      ),
      false,
      "prior Research must not be offered as a current-attempt Context evidence option",
    );
    const sourceBranches = spawner.schemas[index]!.properties.sources.items.anyOf as JsonRecord[];
    assert.equal(
      sourceBranches.some(
        (branch) => branch.properties?.binding?.properties?.itemOrdinal?.enum?.[0] === prior.ordinal,
      ),
      false,
      "prior Research must not receive a current-attempt evidence schema branch",
    );
  }
  assert.equal(spawner.envelopes[0]!.mode, undefined);
  assert.equal(spawner.envelopes[1]!.mode, "decision-grade-repair");
  assert.equal(spawner.envelopes[1]!.repair?.attempt, 1);
  assert.deepEqual(spawner.envelopes[1]!.repair?.rejectionAudit?.gate?.observed, {
    verifiedWebSourceCount: 1,
    evidenceFindingCount: 3,
    evidenceDirectionCount: 2,
    groundednessVerifierAvailable: true,
  });
}

async function runResearchAttemptBoundary(input: {
  rejectRepair: boolean;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-research-attempt-"));
  const store = new Store(join(root, "store.db"));
  const project = store.createProject({
    name: input.rejectRepair ? "Rejected Research repair" : "Accepted Research repair",
    mode: "standard",
  });
  const initialWorkspace = store.workspace.ensureWorkspaceRecord(project.id);
  store.updateSettings({
    agentCommand: "codex",
    model: "gpt-5.4-mini",
    aiProviderId: "openai",
    researchEnabled: true,
  });
  const resourceId = "decision-research";
  const nodeId = "decision-research-node";
  const priorRevisionId = "decision-research-prior-revision";
  const priorBytes = Buffer.from(JSON.stringify({
    format: "dezin-research-resource-bundle",
    version: 3,
    executiveSummary: "Immutable prior Research remains available as reference material.",
    directions: [{
      id: "legacy-direction",
      title: "Legacy Direction",
      thesis: "Useful prior art that cannot become fresh evidence.",
    }],
  }), "utf8");
  const sealedPrior = await sealResourceRevisionPayload({
    storageRoot: root,
    workspaceId: initialWorkspace.id,
    resourceId,
    revisionId: priorRevisionId,
    mimeType: "application/json",
    bytes: priorBytes,
  });
  const prior = store.workspace.createPublishedResourceForProject(project.id, {
    resourceId,
    nodeId,
    commandId: "add-decision-research",
    kind: "research",
    title: "Decision Research",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: initialWorkspace.graphRevision,
    expectedSnapshotId: initialWorkspace.activeSnapshotId,
    revision: {
      revisionId: priorRevisionId,
      parentRevisionId: null,
      manifestPath: sealedPrior.manifestPath,
      summary: "Immutable prior Research",
      metadata: {
        format: "dezin-research-resource-bundle",
        version: 3,
        mimeType: sealedPrior.mimeType,
      },
      checksum: sealedPrior.manifestChecksum,
      provenance: {
        protocol: "dezin.production-research-attempt-boundary-fixture.v1",
        payloadChecksum: sealedPrior.payloadChecksum,
      },
    },
    reason: "Seed immutable Research prior art",
  });
  const workspace = store.workspace.getWorkspace(project.id)!;
  const layout = store.workspace.getLayout(project.id);
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [],
    layoutOperations: [],
    generation: {
      kind: "workspace-generation",
      agent: {
        providerId: "codex",
        command: "codex",
        model: "gpt-5.4-mini",
      },
      resourceOperations: [{
        operation: "revise",
        nodeId,
        resourceId,
        kind: "research",
        title: "Decision Research",
        instructions: "Produce two materially distinct, evidence-backed directions with explicit tradeoffs.",
        revisionPolicy: { kind: "generate" },
      }],
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
    rationale: "Refresh the decision-grade Research without inheriting prior evidence authority.",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);

  const repositoryDir = join(root, "projects", project.id);
  await mkdir(repositoryDir, { recursive: true });
  const fetchCounts = new Map<string, number>();
  const spawner = new RecordingSpawner();
  const spawnerOptions: NodeSpawnerOptions[] = [];
  const reviewRequests: JsonRecord[] = [];
  const runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
  const errors: unknown[] = [];
  const system = createProductionGenerationBootstrap({
    store,
    dataDir: root,
    designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
    runtimeSupervisor,
    daemonOwnerId: input.rejectRepair
      ? "daemon-rejected-research-repair"
      : "daemon-accepted-research-repair",
    repositoryDirForWorkspace: () => repositoryDir,
    resourceExternalFetch: evidenceFetcher({
      rejectRepair: input.rejectRepair,
      counts: fetchCounts,
    }),
    createResourceRuntimePorts(options) {
      return createProductionResourceRuntimePorts({
        ...options,
        createSpawner(spawnOptions) {
          spawnerOptions.push(spawnOptions);
          return spawner;
        },
        resolveRegisteredExecutable(command) {
          assert.equal(command, "codex");
          return TEST_CODEX_EXECUTABLE;
        },
        structuredAgentPlatform: "darwin",
        resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
        reviewTransport: async (request, options) => {
          assert.equal(options?.resolveRegisteredExecutable?.("codex"), TEST_CODEX_EXECUTABLE);
          reviewRequests.push(request as JsonRecord);
          const message = JSON.parse(request.message) as JsonRecord;
          return {
            providerId: "codex",
            text: JSON.stringify({
              verdicts: message.verdicts.map((claim: JsonRecord) => ({
                findingId: claim.findingId,
                supported: claim.supports.length > 0,
                supportReceiptIds: claim.supports.map(
                  (support: JsonRecord) => support.supportReceiptId,
                ),
                rationale: "The exact canonical quote directly supports the bounded claim.",
              })),
            }),
          };
        },
      });
    },
    leaseMs: 5_000,
    heartbeatMs: 500,
    pollMs: 5,
    onError: (error) => errors.push(error),
  });

  try {
    await system.runtime.start();
    await waitForDurableProgress({
      description: input.rejectRepair
        ? "terminal rejected Research repair"
        : "published accepted Research repair",
      read: () => store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan!.id),
      isSettled: ({ plan }) => (
        plan.status === "succeeded"
        || plan.status === "failed"
        || plan.status === "cancelled"
        || plan.status === "compile-failed"
      ),
      fingerprint: ({ plan, tasks }) => JSON.stringify({
        plan: [plan.status, plan.executionEpoch],
        tasks: tasks.map((task) => [
          task.kind,
          task.status,
          task.currentAttempt,
          task.failureClass,
        ]),
      }),
      idleTimeoutMs: 10_000,
      hardTimeoutMs: 30_000,
    });

    const detail = store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan.id);
    const resourceTask = detail.tasks.find((task) => task.kind === "resource");
    assert.ok(resourceTask);
    const attempts = store.db.prepare(
      `SELECT attempt, status, failure_class
         FROM generation_task_attempts
        WHERE task_id = ?
        ORDER BY attempt`,
    ).all(resourceTask.id) as Array<{
      attempt: number;
      status: string;
      failure_class: string | null;
    }>;
    assert.equal(resourceTask.currentAttempt, 1);
    assert.deepEqual(attempts.map((attempt) => attempt.attempt), [1]);
    assert.equal(
      store.workspace.listGenerationPlanEventsForProject(project.id, approved.plan.id)
        .some((event) => event.type === "task-retry-wait"),
      false,
      "the bounded Research repair must never be followed by a Core same-input successor",
    );
    assertPriorResearchExcludedFromCurrentEvidence(spawner, resourceId, priorRevisionId);
    assert.equal(spawnerOptions.length, 2);
    assert.equal(reviewRequests.length, 2);
    assert.equal(fetchCounts.get(WEB_URL_1), 2);
    assert.equal(fetchCounts.get(WEB_URL_2), 2);
    assert.equal(errors.length, 0);

    if (input.rejectRepair) {
      assert.equal(detail.plan.status, "failed");
      assert.equal(resourceTask.status, "failed");
      assert.equal(resourceTask.failureClass, "qa");
      assert.equal(resourceTask.error?.code, "generation-task-quality-gate");
      assert.deepEqual((resourceTask.error?.details as JsonRecord)?.observed, {
        verifiedWebSourceCount: 1,
        evidenceFindingCount: 3,
        evidenceDirectionCount: 2,
        groundednessVerifierAvailable: true,
      });
      assert.deepEqual(attempts.map((attempt) => ({
        status: attempt.status,
        failureClass: attempt.failure_class,
      })), [{ status: "failed", failureClass: "qa" }]);
      assert.equal(
        store.workspace.listResourceRevisions(project.id, resourceId).length,
        1,
        "a rejected repair must not publish a new immutable Revision",
      );
      assert.equal(
        store.workspace.getResourceForProject(project.id, resourceId)?.headRevisionId,
        prior.revision.id,
      );
    } else {
      assert.equal(detail.plan.status, "succeeded", JSON.stringify({
        tasks: detail.tasks.map((task) => ({
          kind: task.kind,
          status: task.status,
          failureClass: task.failureClass,
          error: task.error,
        })),
        fetchCounts: Object.fromEntries(fetchCounts),
        reviewRequests: reviewRequests.length,
        errors: errors.map((error) => error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error),
      }, null, 2));
      assert.equal(resourceTask.status, "succeeded");
      assert.equal(resourceTask.failureClass, null);
      assert.deepEqual(attempts.map((attempt) => ({
        status: attempt.status,
        failureClass: attempt.failure_class,
      })), [{ status: "succeeded", failureClass: null }]);
      assert.equal(store.workspace.listResourceRevisions(project.id, resourceId).length, 2);
      assert.notEqual(resourceTask.resultResourceRevisionId, prior.revision.id);
      const published = store.workspace.getResourceRevisionForWorkspace(
        workspace.id,
        resourceTask.resultResourceRevisionId!,
      );
      assert.equal(
        ((published?.metadata.adapter as JsonRecord)?.decisionGradeGate as JsonRecord)?.accepted,
        true,
      );
      assert.equal(
        store.workspace.getResourceForProject(project.id, resourceId)?.headRevisionId,
        resourceTask.resultResourceRevisionId,
      );
    }
  } finally {
    await system.runtime.stop().catch(() => undefined);
    await runtimeSupervisor.shutdown().catch(() => undefined);
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("production Research initial rejection plus one repair publishes within one Core Attempt", async () => {
  await runResearchAttemptBoundary({ rejectRepair: false });
});

test("production Research rejected repair terminalizes the first Core Attempt without a successor", async () => {
  await runResearchAttemptBoundary({ rejectRepair: true });
});
