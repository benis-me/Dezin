import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { link, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { sealResourceRevisionPayload } from "../src/context/adapters/file.ts";
import {
  OwnedResourceTaskPayloadStaging,
  resourceTaskReceiptRelativePath,
  type ResourceTaskPayloadReferenceGuard,
} from "../src/orchestration/resource-task-payload-staging.ts";
import {
  ResourceTaskPayloadError,
  type ResourceTaskPayloadReceipt,
  type ResourceTaskPayloadStageInput,
} from "../src/orchestration/resource-task-executor.ts";
import type {
  ClassifyResourcePayloadStagingInput,
  CompleteResourcePayloadStagingInput,
  ResourcePayloadCleanupIdentity,
  ResourcePayloadStagingBeginInput,
  ResourcePayloadStagingJournal,
} from "../../../packages/core/src/index.ts";
import { stableStringify, type ContextPack } from "../src/context/context-types.ts";
import type { ResearchRevisionTaskAuthority } from "../src/research-resource-revision.ts";
import { createResearchRevisionFixture } from "./support/research-resource-fixture.ts";

const MEBIBYTE = 1024 * 1024;

interface ResourcePayloadJournalDouble {
  beginResourcePayloadStaging(input: ResourcePayloadStagingBeginInput): ResourcePayloadStagingJournal;
  getResourcePayloadStaging(input: ResourcePayloadCleanupIdentity): ResourcePayloadStagingJournal | null;
  classifyResourcePayloadStaging(input: ClassifyResourcePayloadStagingInput): ResourcePayloadStagingJournal;
  completeResourcePayloadStaging(input: CompleteResourcePayloadStagingInput): ResourcePayloadStagingJournal;
  replaceReceiptChecksum(revisionId: string, receiptChecksum: string): void;
  replacePayloadChecksums(revisionId: string, input: {
    payloadChecksum: string;
    manifestChecksum: string;
    receiptChecksum: string;
    byteSize: number;
  }): void;
}

function stageInput(
  overrides: Partial<ResourceTaskPayloadStageInput> = {},
): ResourceTaskPayloadStageInput {
  return {
    taskId: "task-owned-resource-stage",
    planId: "plan-owned-resource-stage",
    attempt: 1,
    inputHash: "a".repeat(64),
    workspaceId: "workspace-owned-resource-stage",
    resourceId: "resource-owned-resource-stage",
    revisionId: "7ae98395-aa2e-5a59-8f52-5df48f075d6e",
    parentRevisionId: "resource-owned-parent",
    adapter: { id: "dezin.resource-adapter.asset", version: 1, kind: "asset" },
    maxOutputBytes: 1024 * 1024,
    contextPackId: `context-pack-${"a".repeat(64)}`,
    contextPackHash: "a".repeat(64),
    lease: {
      taskId: "task-owned-resource-stage",
      workspaceId: "workspace-owned-resource-stage",
      attempt: 1,
      ownerId: "worker-owned-resource-stage",
      leaseToken: "lease-owned-resource-stage",
    },
    bytes: new TextEncoder().encode("owned generated payload"),
    mimeType: "text/plain",
    summary: "Owned generated payload",
    metadata: { width: 1440 },
    provenance: { model: "fixture-v1" },
    evidence: { accepted: true },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function completeResearchV4Fixture() {
  const workspaceId = "workspace-research-fixture";
  const resourceId = "resource-research-fixture";
  const contextPackHash = "b".repeat(64);
  const contextPack = {
    id: `context-pack-${contextPackHash}`,
    workspaceId,
    hash: contextPackHash,
    graphRevision: 1,
    target: { type: "resource", id: resourceId },
    intent: "generate",
    messageChecksum: "c".repeat(64),
    items: [],
    omissions: [],
    tokenEstimate: 0,
    manifestPath: "context-packs/research-fixture.json",
    createdAt: 1,
  } as unknown as ContextPack;
  const fixture = createResearchRevisionFixture({
    workspaceId,
    resourceId,
    contextPack,
  });
  const firstCandidateAudit = {
    protocol: "dezin.research-direction-only-first-candidate-audit.v1",
    findingIds: ["finding-comparison", "finding-celebration", "finding-summary"],
    evidenceFindingIds: ["finding-comparison", "finding-summary"],
    hypothesisFindingIds: ["finding-celebration"],
    directionIds: ["quiet-confidence", "expressive-confirmation"],
    directionMappings: [{
      directionId: "quiet-confidence",
      findingIds: ["finding-celebration"],
    }, {
      directionId: "expressive-confirmation",
      findingIds: ["finding-celebration"],
    }],
    changedDirectionOriginalFindingIds: ["finding-celebration"],
  };
  const firstCandidateChecksum = createHash("sha256")
    .update(stableStringify(firstCandidateAudit))
    .digest("hex");
  Object.assign(fixture.bundle, {
    version: 4,
    repairAuthority: {
      protocol: "dezin.research-direction-only-repair-authority.v1",
      firstCandidateAudit: structuredClone(firstCandidateAudit),
      firstCandidateChecksum,
    },
  });
  fixture.metadata.adapter.version = 4;
  Object.assign(fixture.provenance.adapterProvenance, {
    researchRepair: {
      protocol: "dezin.research-direction-only-repair.v1",
      firstCandidateAudit,
      firstCandidateChecksum,
      gateBlockers: ["insufficient-evidence-directions"],
      changedDirectionId: "quiet-confidence",
      selectedEvidenceFindingIds: ["finding-comparison", "finding-summary"],
      revalidatedEvidenceFindingIds: ["finding-comparison", "finding-summary"],
      droppedFindingIds: [],
    },
  });
  return { fixture, contextPack };
}

function largeJsonPayload(): Buffer {
  return Buffer.from(JSON.stringify({
    format: "dezin-moodboard-resource-bundle",
    version: 2,
    board: { id: "board-large", name: "Large generated board", coverAssetId: null },
    nodes: [],
    messages: [],
    assets: [],
    padding: "x".repeat(8 * MEBIBYTE),
  }), "utf8");
}

function emptyMoodboardLineage(taskId: string, attempt: number, inputHash: string) {
  return {
    metadata: {
      format: "dezin-moodboard-resource-bundle",
      version: 2,
      assetCount: 0,
      nodeCount: 0,
      referenceCount: 0,
    },
    provenance: {
      protocol: "dezin.production-resource-generation.v1",
      taskId,
      attempt,
      inputHash,
      contextPackId: `context-pack-${"a".repeat(64)}`,
      contextPackHash: "a".repeat(64),
      qualityReviewer: {
        providerId: "fixture-reviewer",
        model: null,
        baseUrl: null,
      },
      qualityRepair: {
        maxRepairRounds: 1,
        usedRepairRounds: 0,
        assetRounds: [],
      },
    },
    evidence: {
      assetChecksums: [],
      qualityReviews: [],
      qualityReviewHistory: [],
      referenceIds: [],
    },
  } as const;
}

function reviewedMoodboardFixture() {
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const assetChecksum = createHash("sha256").update(image).digest("hex");
  const originalPrompt = "Original editorial still";
  const acceptedPrompt = "Repaired editorial still with a clear focal subject";
  const originalPromptChecksum = createHash("sha256").update(originalPrompt).digest("hex");
  const acceptedPromptChecksum = createHash("sha256").update(acceptedPrompt).digest("hex");
  const reviewerId = "fixture-reviewer";
  const bundle = {
    format: "dezin-moodboard-resource-bundle",
    version: 2,
    board: { id: "board-reviewed", name: "Reviewed board", coverAssetId: "asset-reviewed" },
    nodes: [],
    messages: [],
    assets: [{
      id: "asset-reviewed",
      metadata: {
        kind: "image",
        fileName: "reviewed.png",
        mimeType: "image/png",
        originalPrompt,
        prompt: acceptedPrompt,
        qualityRepair: {
          roundsApplied: 1,
          acceptedRound: 1,
          originalPromptChecksum,
          acceptedPromptChecksum,
        },
      },
      byteLength: image.byteLength,
      checksum: assetChecksum,
      bytesBase64: image.toString("base64"),
    }],
  };
  return {
    bundle,
    metadata: {
      format: bundle.format,
      version: bundle.version,
      assetCount: 1,
      nodeCount: 0,
      referenceCount: 0,
    } as Record<string, unknown>,
    provenance: {
      protocol: "dezin.production-resource-generation.v1",
      taskId: "task-owned-reviewed-moodboard",
      attempt: 1,
      inputHash: "e".repeat(64),
      contextPackId: `context-pack-${"a".repeat(64)}`,
      contextPackHash: "a".repeat(64),
      qualityReviewer: {
        providerId: reviewerId,
        model: null,
        baseUrl: "",
      },
      qualityRepair: {
        maxRepairRounds: 1,
        usedRepairRounds: 1,
        assetRounds: [{ id: "asset-reviewed", roundsApplied: 1 }],
      },
    } as Record<string, unknown>,
    evidence: {
      assetChecksums: [{ id: "asset-reviewed", checksum: assetChecksum }],
      qualityReviews: [{
        id: "asset-reviewed",
        checksum: assetChecksum,
        reviewer: { id: reviewerId },
        decision: "pass",
        semanticMatch: true,
        visualQuality: "pass",
      }],
      qualityReviewHistory: [{
        id: "asset-reviewed",
        reviewer: { id: reviewerId },
        reviews: [{
          round: 0,
          reviewer: { id: reviewerId },
          promptChecksum: originalPromptChecksum,
          imageChecksum: "0".repeat(64),
          decision: "fail",
          semanticMatch: false,
          visualQuality: "fail",
          findings: ["Subject hierarchy is unclear"],
        }, {
          round: 1,
          reviewer: { id: reviewerId },
          promptChecksum: acceptedPromptChecksum,
          imageChecksum: assetChecksum,
          decision: "pass",
          semanticMatch: true,
          visualQuality: "pass",
          findings: [],
        }],
      }],
      referenceIds: [],
    } as Record<string, unknown>,
  };
}

function directionBoundMoodboardFixture() {
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const imageChecksum = createHash("sha256").update(image).digest("hex");
  const reviewerId = "fixture-reviewer";
  const contextPackHash = "8".repeat(64);
  const contextPackId = `context-pack-${contextPackHash}`;
  const directions = [
    {
      resourceId: "research-direction-source",
      revisionId: "research-direction-revision",
      id: "direction-field-notes",
      title: "Field Notes",
      thesis: "Turn field evidence into a tactile editorial archive.",
      visualLanguage: ["warm paper", "precise ink annotation"],
      interactionPrinciples: ["reveal provenance in reading order"],
      risks: ["nostalgia obscures evidence"],
    },
    {
      resourceId: "research-direction-source",
      revisionId: "research-direction-revision",
      id: "direction-signal-ledger",
      title: "Signal Ledger",
      thesis: "Make changing evidence legible through a restrained operational ledger.",
      visualLanguage: ["dense evidence grid", "restrained status color"],
      interactionPrinciples: ["keep status changes spatially stable"],
      risks: ["density becomes dashboard noise"],
    },
    {
      resourceId: "research-direction-source",
      revisionId: "research-direction-revision",
      id: "direction-quiet-atlas",
      title: "Quiet Atlas",
      thesis: "Connect spatial evidence without losing editorial calm.",
      visualLanguage: ["spatial index", "calm editorial hierarchy"],
      interactionPrinciples: ["preserve geographic orientation"],
      risks: ["maps become decorative"],
    },
  ].map((direction) => ({
    ...direction,
    checksum: createHash("sha256").update(stableStringify(direction)).digest("hex"),
  }));
  const directionContractBody = {
    protocol: "dezin.moodboard-direction-contract.v1",
    contextPackId,
    directions,
  };
  const directionContract = {
    ...directionContractBody,
    checksum: createHash("sha256").update(stableStringify(directionContractBody)).digest("hex"),
  };
  const assets = directions.map((direction, index) => {
    const prompt = `One coherent ${direction.title} visual direction`;
    const promptChecksum = createHash("sha256").update(prompt).digest("hex");
    return {
      id: `asset-${index + 1}`,
      metadata: {
        kind: "image",
        fileName: `direction-${index + 1}.png`,
        mimeType: "image/png",
        agentPrompt: prompt,
        originalPrompt: prompt,
        prompt,
        directionId: direction.id,
        directionTitle: direction.title,
        directionChecksum: direction.checksum,
        qualityRepair: {
          roundsApplied: 0,
          acceptedRound: 0,
          agentPromptChecksum: promptChecksum,
          originalPromptChecksum: promptChecksum,
          acceptedPromptChecksum: promptChecksum,
        },
      },
      byteLength: image.byteLength,
      checksum: imageChecksum,
      bytesBase64: image.toString("base64"),
    };
  });
  const bundle = {
    format: "dezin-moodboard-resource-bundle",
    version: 3,
    board: {
      id: "board-direction-bound",
      name: "Direction-bound board",
      coverAssetId: assets[0]!.id,
      directionContract,
    },
    nodes: [],
    messages: [],
    assets,
  };
  return {
    bundle,
    metadata: {
      format: bundle.format,
      version: bundle.version,
      assetCount: assets.length,
      nodeCount: 0,
      referenceCount: 0,
    } as Record<string, unknown>,
    provenance: {
      protocol: "dezin.production-resource-generation.v1",
      taskId: "task-owned-direction-bound-moodboard",
      attempt: 1,
      inputHash: "9".repeat(64),
      contextPackId,
      contextPackHash,
      qualityReviewer: {
        providerId: reviewerId,
        model: null,
        baseUrl: "",
      },
      qualityRepair: {
        maxRepairRounds: 1,
        usedRepairRounds: 0,
        assetRounds: assets.map((asset) => ({ id: asset.id, roundsApplied: 0 })),
      },
      directionContract: {
        protocol: directionContract.protocol,
        contextPackId,
        checksum: directionContract.checksum,
        directionCount: directions.length,
      },
    } as Record<string, unknown>,
    evidence: {
      assetChecksums: assets.map((asset) => ({ id: asset.id, checksum: asset.checksum })),
      qualityReviews: assets.map((asset) => ({
        id: asset.id,
        checksum: asset.checksum,
        reviewer: { id: reviewerId },
        decision: "pass",
        semanticMatch: true,
        visualQuality: "pass",
      })),
      qualityReviewHistory: assets.map((asset) => ({
        id: asset.id,
        reviewer: { id: reviewerId },
        reviews: [{
          round: 0,
          reviewer: { id: reviewerId },
          promptChecksum: asset.metadata.qualityRepair.acceptedPromptChecksum,
          imageChecksum: asset.checksum,
          decision: "pass",
          semanticMatch: true,
          visualQuality: "pass",
          findings: [],
        }],
      })),
      referenceIds: [],
      directionAssignments: assets.map((asset) => ({
        assetId: asset.id,
        directionId: asset.metadata.directionId,
        directionTitle: asset.metadata.directionTitle,
        directionChecksum: asset.metadata.directionChecksum,
      })),
    } as Record<string, unknown>,
  };
}

function directionContextPacks(
  fixture: ReturnType<typeof directionBoundMoodboardFixture>,
): { get(workspaceId: string, contextPackId: string): ContextPack | null } {
  const contextPackId = fixture.provenance.contextPackId as string;
  const contextPackHash = fixture.provenance.contextPackHash as string;
  const directions = structuredClone(fixture.bundle.board.directionContract.directions);
  const pack: ContextPack = {
    id: contextPackId,
    workspaceId: "workspace-owned-resource-stage",
    graphRevision: 1,
    target: { type: "resource", id: "resource-owned-direction-bound-moodboard" },
    intent: "generate",
    messageChecksum: "6".repeat(64),
    items: [{
      ordinal: 0,
      contextClass: "explicit",
      ref: {
        kind: "resource",
        id: directions[0]!.resourceId,
        resourceKind: "research",
        revisionId: directions[0]!.revisionId,
      },
      resolvedKind: "resource-revision",
      content: JSON.stringify({
        format: "dezin-research-resource-bundle",
        version: 3,
        directions,
      }),
      checksum: "5".repeat(64),
      reason: "Exact pinned Research Revision",
      trustLevel: "trusted",
      capabilities: [],
      boundary: {
        source: "fixture",
        readOnly: true,
        mayGrantCapabilities: false,
      },
      tokenEstimate: 1,
      provenance: {},
      provided: true,
    }],
    omissions: [],
    tokenEstimate: 1,
    manifestPath: "context-packs/direction-bound.json",
    hash: contextPackHash,
    createdAt: 1,
  };
  return {
    get(workspaceId, requestedContextPackId) {
      return workspaceId === pack.workspaceId && requestedContextPackId === pack.id
        ? structuredClone(pack)
        : null;
    },
  };
}

function substituteDirectionAndRechecksum(
  fixture: ReturnType<typeof directionBoundMoodboardFixture>,
): void {
  const contract = fixture.bundle.board.directionContract;
  const direction = contract.directions[0]!;
  direction.resourceId = "research-substituted";
  direction.revisionId = "research-revision-substituted";
  direction.title = "Substituted Field Notes";
  direction.thesis = "A self-consistent but untrusted replacement thesis.";
  direction.visualLanguage = ["substituted visual language", "recomputed visual system"];
  direction.interactionPrinciples = ["substituted interaction principle"];
  direction.risks = ["substituted risk"];
  const { checksum: _directionChecksum, ...directionBody } = direction;
  direction.checksum = createHash("sha256").update(stableStringify(directionBody)).digest("hex");
  const { checksum: _contractChecksum, ...contractBody } = contract;
  contract.checksum = createHash("sha256").update(stableStringify(contractBody)).digest("hex");

  const asset = fixture.bundle.assets[0]!;
  asset.metadata.directionTitle = direction.title;
  asset.metadata.directionChecksum = direction.checksum;
  (fixture.provenance.directionContract as Record<string, unknown>).checksum = contract.checksum;
  const assignment = (fixture.evidence.directionAssignments as Array<Record<string, unknown>>)[0]!;
  assignment.directionTitle = direction.title;
  assignment.directionChecksum = direction.checksum;
}

function moveDirectionsToForeignContextPackAndRechecksum(
  fixture: ReturnType<typeof directionBoundMoodboardFixture>,
  contextPackHash: string,
): void {
  substituteDirectionAndRechecksum(fixture);
  const contextPackId = `context-pack-${contextPackHash}`;
  const contract = fixture.bundle.board.directionContract;
  contract.contextPackId = contextPackId;
  const { checksum: _contractChecksum, ...contractBody } = contract;
  contract.checksum = createHash("sha256").update(stableStringify(contractBody)).digest("hex");
  fixture.provenance.contextPackId = contextPackId;
  fixture.provenance.contextPackHash = contextPackHash;
  const provenanceContract = fixture.provenance.directionContract as Record<string, unknown>;
  provenanceContract.contextPackId = contextPackId;
  provenanceContract.checksum = contract.checksum;
}

function moodboardWithInvalidEmbeddedPng(): Buffer {
  const invalid = Buffer.from("not a PNG", "utf8");
  return Buffer.from(JSON.stringify({
    format: "dezin-moodboard-resource-bundle",
    version: 1,
    board: { id: "board-invalid-image", name: "Invalid generated board", coverAssetId: "asset-invalid" },
    nodes: [{ id: "image-invalid", type: "image", assetId: "asset-invalid" }],
    messages: [],
    assets: [{
      id: "asset-invalid",
      metadata: { kind: "image", fileName: "invalid.png", mimeType: "image/png" },
      byteLength: invalid.byteLength,
      checksum: createHash("sha256").update(invalid).digest("hex"),
      bytesBase64: invalid.toString("base64"),
    }],
  }), "utf8");
}

function referenceGuard(state: { referenced: boolean; removals: number }): ResourceTaskPayloadReferenceGuard {
  return {
    async removeIfUnreferenced(_identity, removeOwnedPayload) {
      if (state.referenced) return false;
      await removeOwnedPayload();
      state.removals += 1;
      return true;
    },
  };
}

function journalDouble(options: {
  onBegin?: (input: ResourcePayloadStagingBeginInput) => void;
  planId?: string;
} = {}): ResourcePayloadJournalDouble {
  const values = new Map<string, ResourcePayloadStagingJournal>();
  return {
    beginResourcePayloadStaging(input) {
      options.onBegin?.(input);
      const existing = values.get(input.revisionId);
      if (existing !== undefined) return existing;
      const { lease, ...journalInput } = input;
      const value: ResourcePayloadStagingJournal = {
        ...journalInput,
        sequence: values.size + 1,
        planId: options.planId ?? "plan-owned-resource-stage",
        ownerId: lease.ownerId,
        leaseToken: lease.leaseToken,
        status: "prepared",
        storageDisposition: null,
        createdAt: 1,
        classifiedAt: null,
        receiptCommittedAt: null,
      };
      values.set(input.revisionId, value);
      return value;
    },
    getResourcePayloadStaging(input) {
      const value = values.get(input.revisionId);
      return value?.taskId === input.taskId
        && value.attempt === input.attempt
        && value.inputHash === input.inputHash
        && value.workspaceId === input.workspaceId
        && value.resourceId === input.resourceId
        && value.revisionId === input.revisionId
        ? value
        : null;
    },
    classifyResourcePayloadStaging(input) {
      const value = values.get(input.revisionId);
      assert.ok(value);
      const classified: ResourcePayloadStagingJournal = {
        ...value,
        storageDisposition: input.storageDisposition,
        classifiedAt: 2,
      };
      values.set(input.revisionId, classified);
      return classified;
    },
    completeResourcePayloadStaging(input) {
      const value = values.get(input.revisionId);
      assert.ok(value);
      assert.equal(input.receiptChecksum, value.receiptChecksum);
      const completed: ResourcePayloadStagingJournal = {
        ...value,
        status: "receipt-committed",
        receiptCommittedAt: 3,
      };
      values.set(input.revisionId, completed);
      return completed;
    },
    replaceReceiptChecksum(revisionId, receiptChecksum) {
      const value = values.get(revisionId);
      assert.ok(value);
      values.set(revisionId, { ...value, receiptChecksum });
    },
    replacePayloadChecksums(revisionId, input) {
      const value = values.get(revisionId);
      assert.ok(value);
      values.set(revisionId, { ...value, ...input });
    },
  };
}

interface ReceiptScanCursor {
  relativePath: string;
}

interface ReceiptScanPage {
  receipts: Array<{ relativePath: string; receipt: ResourceTaskPayloadReceipt }>;
  invalidReceiptPaths: string[];
  scanned: number;
  nextCursor: ReceiptScanCursor | null;
}

interface ReceiptScanner {
  scanReceipts(input: {
    cursor?: ReceiptScanCursor | null;
    limit?: number;
    signal: AbortSignal;
  }): Promise<ReceiptScanPage>;
}

test("commits an exact staging journal before the first owned filesystem write", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-journal-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const input = stageInput({ inputHash: "a".repeat(64) });
  const events: string[] = [];
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble({
      onBegin(begin) {
        events.push("begin");
        const manifest = join(storageRoot, ...begin.manifestPath.split("/"));
        assert.throws(() => lstatSync(manifest), { code: "ENOENT" });
      },
    }),
    now: () => 122_000,
  });

  await staging.stage(input);

  assert.deepEqual(events, ["begin"]);
});

test("a stale lease rejection leaves zero Resource payload filesystem writes", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-stale-lease-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const journal = journalDouble();
  journal.beginResourcePayloadStaging = () => {
    assert.throws(() => lstatSync(join(storageRoot, "resource-revisions")), { code: "ENOENT" });
    throw new Error("stale Resource payload lease fence");
  };
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal,
  });

  await assert.rejects(
    staging.stage(stageInput()),
    (error) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
      && error.cause instanceof Error
      && /stale Resource payload lease fence/.test(error.cause.message),
  );
  assert.throws(() => lstatSync(join(storageRoot, "resource-revisions")), { code: "ENOENT" });
});

test("seals and replays a real immutable attempt-scoped payload receipt", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const state = { referenced: false, removals: 0 };
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard(state),
    journal: journalDouble(),
    now: () => 123_000,
  });
  const input = stageInput();

  const staged = await staging.stage(input);
  const replay = await staging.find(input);

  assert.deepEqual(replay, staged);
  assert.equal(staged.revisionId, input.revisionId);
  assert.equal(staged.parentRevisionId, input.parentRevisionId);
  assert.equal(staged.byteSize, input.bytes.byteLength);
  assert.match(staged.manifestChecksum, /^[a-f0-9]{64}$/);
  assert.match(staged.payloadChecksum, /^[a-f0-9]{64}$/);
  assert.equal(
    resourceTaskReceiptRelativePath(input.workspaceId, input.revisionId),
    `${dirname(staged.manifestPath)}/generation-receipt.json`,
  );
});

test("does not charge the durable receipt envelope against the adapter output budget", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-budget-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 123_500,
  });
  const input = stageInput({ maxOutputBytes: 300 });

  const receipt = await staging.stage(input);

  assert.deepEqual(await staging.find(input), receipt);
});

test("stages and replays a generated Moodboard JSON bundle larger than the ordinary 8 MiB text boundary", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-large-moodboard-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 123_750,
  });
  const bytes = largeJsonPayload();
  assert.ok(bytes.byteLength > 8 * MEBIBYTE);
  const input = stageInput({
    taskId: "task-owned-large-moodboard",
    inputHash: "b".repeat(64),
    resourceId: "resource-owned-large-moodboard",
    revisionId: "8ae98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    bytes,
    mimeType: "application/json",
    ...emptyMoodboardLineage("task-owned-large-moodboard", 1, "b".repeat(64)),
  });

  const receipt = await staging.stage(input);

  assert.equal(receipt.byteSize, bytes.byteLength);
  assert.deepEqual(await staging.find(input), receipt);
});

test("validates complete Research v4 bytes before staging and again on replay", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-research-v4-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const { fixture, contextPack } = completeResearchV4Fixture();
  const researchTaskAuthority: ResearchRevisionTaskAuthority = {
    operation: fixture.bundle.scope.operation,
    nodeId: fixture.bundle.scope.nodeId,
    title: fixture.bundle.scope.title,
    brief: {
      proposalRationale: fixture.bundle.brief.proposalRationale,
      assumptions: [...fixture.bundle.brief.assumptions],
      targetInstructions: {
        operation: fixture.bundle.brief.targetInstructions.operation,
        kind: "research",
        title: fixture.bundle.brief.targetInstructions.title,
      },
    },
  };
  const contextPacks = new Map([[contextPack.id, contextPack]]);
  const journal = journalDouble({ planId: fixture.bundle.scope.planId });
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal,
    contextPacks: {
      get(workspaceId, contextPackId) {
        const candidate = contextPacks.get(contextPackId);
        return workspaceId === candidate?.workspaceId ? candidate : null;
      },
    },
    attemptContextAuthority: {
      resolveMoodboardAttemptContext() {
        return {
          contextPackId: contextPack.id,
          contextPackHash: contextPack.hash,
          researchTaskAuthority,
        };
      },
    },
    now: () => 123_800,
  });
  const input = stageInput({
    taskId: fixture.bundle.scope.taskId,
    planId: fixture.bundle.scope.planId,
    inputHash: fixture.bundle.scope.inputHash,
    workspaceId: fixture.bundle.scope.workspaceId,
    resourceId: fixture.bundle.scope.resourceId,
    revisionId: "8be98395-aa2e-5a59-8f52-5df48f075d6e",
    parentRevisionId: null,
    adapter: { id: "dezin.resource-adapter.research", version: 1, kind: "research" },
    contextPackId: contextPack.id,
    contextPackHash: contextPack.hash,
    researchTaskAuthority,
    lease: {
      taskId: fixture.bundle.scope.taskId,
      workspaceId: fixture.bundle.scope.workspaceId,
      attempt: fixture.bundle.scope.attempt,
      ownerId: "worker-research-v4",
      leaseToken: "lease-research-v4",
    },
    bytes: Buffer.from(stableStringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    summary: "Complete Research v4 fixture",
    metadata: fixture.metadata.adapter,
    provenance: fixture.provenance.adapterProvenance,
    evidence: { accepted: true },
  });

  await staging.validate(input);
  await assert.rejects(
    staging.validate({
      ...input,
      bytes: Buffer.from(JSON.stringify({
        format: "dezin-research-resource-bundle",
        version: 4,
      }), "utf8"),
    }),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
      && /Research payload is invalid/i.test(error.message),
  );
  for (const mutate of [
    (bundle: any) => {
      bundle.scope.operation = bundle.scope.operation === "create" ? "revise" : "create";
      bundle.brief.targetInstructions.operation = bundle.scope.operation;
    },
    (bundle: any) => {
      bundle.scope.nodeId = "node-substituted";
    },
    (bundle: any) => {
      bundle.scope.title = "Substituted Research title";
      bundle.brief.targetInstructions.title = bundle.scope.title;
    },
    (bundle: any) => {
      bundle.brief.targetInstructions.instructions = "Substituted Research instructions";
    },
  ]) {
    const substituted = structuredClone(fixture.bundle);
    mutate(substituted);
    await assert.rejects(
      staging.validate({
        ...input,
        bytes: Buffer.from(stableStringify(substituted), "utf8"),
      }),
      (error: unknown) => error instanceof ResourceTaskPayloadError
        && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
        && /frozen Task|Task target/i.test(error.message),
    );
  }

  const receipt = await staging.stage(input);
  assert.deepEqual(await staging.find(input), receipt);

  const foreignHash = "d".repeat(64);
  const foreignContextPack = {
    ...contextPack,
    id: `context-pack-${foreignHash}`,
    hash: foreignHash,
    manifestPath: "context-packs/research-foreign.json",
  } as ContextPack;
  contextPacks.set(foreignContextPack.id, foreignContextPack);
  const foreignFixture = createResearchRevisionFixture({
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    contextPack: foreignContextPack,
  });
  const relativePath = resourceTaskReceiptRelativePath(input.workspaceId, input.revisionId);
  const receiptPath = join(storageRoot, ...relativePath.split("/"));
  const storedReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  const manifestPath = join(storageRoot, ...(storedReceipt.manifestPath as string).split("/"));
  const payloadPath = join(dirname(manifestPath), "payload.bin");
  const foreignPayloadBytes = Buffer.from(stableStringify(foreignFixture.bundle), "utf8");
  const foreignPayloadChecksum = createHash("sha256").update(foreignPayloadBytes).digest("hex");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    payload: { byteLength: number; checksum: string };
  };
  manifest.payload.byteLength = foreignPayloadBytes.byteLength;
  manifest.payload.checksum = foreignPayloadChecksum;
  const manifestBytes = Buffer.from(`${stableStringify(manifest)}\n`, "utf8");
  const manifestChecksum = createHash("sha256").update(manifestBytes).digest("hex");
  storedReceipt.summary = "Self-consistent foreign Research Context Pack";
  storedReceipt.metadata = foreignFixture.metadata.adapter;
  storedReceipt.provenance = foreignFixture.provenance.adapterProvenance;
  storedReceipt.payloadChecksum = foreignPayloadChecksum;
  storedReceipt.manifestChecksum = manifestChecksum;
  storedReceipt.byteSize = foreignPayloadBytes.byteLength;
  const receiptBytes = Buffer.from(`${JSON.stringify(storedReceipt)}\n`, "utf8");
  const receiptChecksum = createHash("sha256").update(receiptBytes).digest("hex");
  for (const [path, bytes] of [
    [payloadPath, foreignPayloadBytes],
    [manifestPath, manifestBytes],
    [receiptPath, receiptBytes],
  ] as const) {
    const replacementPath = `${path}.replacement`;
    await writeFile(replacementPath, bytes);
    await rename(replacementPath, path);
  }
  journal.replacePayloadChecksums(input.revisionId, {
    payloadChecksum: foreignPayloadChecksum,
    manifestChecksum,
    receiptChecksum,
    byteSize: foreignPayloadBytes.byteLength,
  });

  await assert.rejects(
    staging.find(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_RECEIPT_INVALID"
      && /Attempt Context Pack/i.test(error.message),
  );
  const scan = await (staging as unknown as ReceiptScanner).scanReceipts({
    limit: 10,
    signal: new AbortController().signal,
  });
  assert.deepEqual(scan.receipts, []);
  assert.deepEqual(scan.invalidReceiptPaths, [relativePath]);
});

test("keeps the ordinary 8 MiB verifier boundary for non-Moodboard JSON", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-large-json-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 123_875,
  });
  const input = stageInput({
    taskId: "task-owned-large-research-json",
    inputHash: "c".repeat(64),
    resourceId: "resource-owned-large-research-json",
    revisionId: "9ae98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: {
      id: "dezin.resource-adapter.external-reference",
      version: 1,
      kind: "external-reference",
    },
    maxOutputBytes: 48 * MEBIBYTE,
    bytes: largeJsonPayload(),
    mimeType: "application/json",
  });

  await assert.rejects(
    staging.stage(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
      && /8 MiB|text Resource/i.test(String((error.cause as Error | undefined)?.message ?? error.message)),
  );
  assert.equal(await staging.find(input), null);
});

test("rejects generated Moodboard bundles with MIME-incompatible embedded Asset bytes before committing a receipt", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-invalid-moodboard-image-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 123_900,
  });
  const input = stageInput({
    taskId: "task-owned-invalid-moodboard-image",
    inputHash: "d".repeat(64),
    resourceId: "resource-owned-invalid-moodboard-image",
    revisionId: "aae98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    bytes: moodboardWithInvalidEmbeddedPng(),
    mimeType: "application/json",
  });

  await assert.rejects(
    staging.stage(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
      && /Asset asset-invalid bytes do not match its declared MIME/i.test(
        String((error.cause as Error | undefined)?.message ?? error.message),
      ),
  );
  assert.equal(await staging.find(input), null);
});

test("stages and replays a generated Moodboard with one exact quality-repair lineage", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-reviewed-moodboard-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 123_925,
  });
  const fixture = reviewedMoodboardFixture();
  const input = stageInput({
    taskId: "task-owned-reviewed-moodboard",
    inputHash: "e".repeat(64),
    resourceId: "resource-owned-reviewed-moodboard",
    revisionId: "bae98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });

  const receipt = await staging.stage(input);

  assert.deepEqual(await staging.find(input), receipt);
});

test("strict production-v2 rejects missing exact Attempt Context Pack provenance", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-v2-missing-context-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
  });
  const fixture = reviewedMoodboardFixture();
  delete fixture.provenance.contextPackId;
  delete fixture.provenance.contextPackHash;
  const input = stageInput({
    taskId: "task-owned-reviewed-moodboard",
    inputHash: "e".repeat(64),
    resourceId: "resource-owned-reviewed-moodboard",
    revisionId: "cbe98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });

  await assert.rejects(
    staging.stage(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
      && /Context Pack/i.test(error.message),
  );
  assert.equal(await staging.find(input), null);
});

test("strict production-v2 rejects lineage from a foreign Attempt Context Pack", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-v2-foreign-context-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
  });
  const fixture = reviewedMoodboardFixture();
  const foreignHash = "f".repeat(64);
  fixture.provenance.contextPackId = `context-pack-${foreignHash}`;
  fixture.provenance.contextPackHash = foreignHash;
  const input = stageInput({
    taskId: "task-owned-reviewed-moodboard",
    inputHash: "e".repeat(64),
    resourceId: "resource-owned-reviewed-moodboard",
    revisionId: "dbe98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });

  await assert.rejects(
    staging.stage(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
      && /exact Attempt Context Pack/i.test(error.message),
  );
  assert.equal(await staging.find(input), null);
});

test("default production-v2 policy rejects sparse legacy lineage", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-v2-sparse-strict-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
  });
  const fixture = reviewedMoodboardFixture();
  fixture.provenance = {};
  fixture.evidence = {};
  const input = stageInput({
    taskId: "task-owned-reviewed-moodboard",
    inputHash: "e".repeat(64),
    resourceId: "resource-owned-reviewed-moodboard",
    revisionId: "ebe98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });

  await assert.rejects(
    staging.stage(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
      && /provenance/i.test(error.message),
  );
});

test("explicit allow-legacy-v2 policy preserves sparse legacy lineage compatibility", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-v2-sparse-legacy-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    moodboardV2LineagePolicy: "allow-legacy-v2",
  });
  const fixture = reviewedMoodboardFixture();
  fixture.provenance = {};
  fixture.evidence = {};
  const input = stageInput({
    taskId: "task-owned-reviewed-moodboard",
    inputHash: "e".repeat(64),
    resourceId: "resource-owned-reviewed-moodboard",
    revisionId: "fbe98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });

  const receipt = await staging.stage(input);
  assert.deepEqual(await staging.find(input), receipt);
});

test("stages and replays a v3 Moodboard whose immutable Assets are auditably bound one-to-one to Research directions", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-direction-bound-moodboard-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const fixture = directionBoundMoodboardFixture();
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 123_937,
    contextPacks: directionContextPacks(fixture),
  });
  const input = stageInput({
    taskId: "task-owned-direction-bound-moodboard",
    inputHash: "9".repeat(64),
    resourceId: "resource-owned-direction-bound-moodboard",
    revisionId: "fbe98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    contextPackId: fixture.provenance.contextPackId as string,
    contextPackHash: fixture.provenance.contextPackHash as string,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });

  const receipt = await staging.stage(input);

  assert.deepEqual(await staging.find(input), receipt);
});

test("rejects a fully rechecksummed v3 direction contract that substitutes its frozen Research authority", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-substituted-direction-authority-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const fixture = directionBoundMoodboardFixture();
  const contextPacks = directionContextPacks(fixture);
  substituteDirectionAndRechecksum(fixture);
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 123_939,
    contextPacks,
  });
  const input = stageInput({
    taskId: "task-owned-direction-bound-moodboard",
    inputHash: "9".repeat(64),
    resourceId: "resource-owned-direction-bound-moodboard",
    revisionId: "1ce98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    contextPackId: fixture.provenance.contextPackId as string,
    contextPackHash: fixture.provenance.contextPackHash as string,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });

  await assert.rejects(
    staging.stage(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
      && /Research|direction|authority/i.test(
        String((error.cause as Error | undefined)?.message ?? error.message),
      ),
  );
  assert.equal(await staging.find(input), null);
});

test("rejects v3 Moodboard lineage that omits its primary Context Pack provenance", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-missing-moodboard-context-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 123_941,
  });
  const fixture = directionBoundMoodboardFixture();
  delete fixture.provenance.contextPackId;
  delete fixture.provenance.contextPackHash;
  const input = stageInput({
    taskId: "task-owned-direction-bound-moodboard",
    inputHash: "9".repeat(64),
    resourceId: "resource-owned-direction-bound-moodboard",
    revisionId: "2ce98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });

  await assert.rejects(
    staging.stage(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
      && /Context Pack provenance/i.test(error.message),
  );
});

test("rejects internally consistent v3 Moodboard lineage from a different Attempt Context Pack", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-mismatched-moodboard-context-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 123_942,
  });
  const fixture = directionBoundMoodboardFixture();
  const expectedContextPackHash = "7".repeat(64);
  const input = stageInput({
    taskId: "task-owned-direction-bound-moodboard",
    inputHash: "9".repeat(64),
    resourceId: "resource-owned-direction-bound-moodboard",
    revisionId: "3ce98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    contextPackId: `context-pack-${expectedContextPackHash}`,
    contextPackHash: expectedContextPackHash,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });

  await assert.rejects(
    staging.stage(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
      && /Attempt Context Pack/i.test(error.message),
  );
});

test("rejects missing, duplicate, or foreign persisted v3 Moodboard direction assignments", async (t) => {
  const cases: ReadonlyArray<{
    name: string;
    mutate(fixture: ReturnType<typeof directionBoundMoodboardFixture>): void;
  }> = [{
    name: "missing directionId",
    mutate(fixture) {
      delete (fixture.bundle.assets[0]!.metadata as Partial<
        typeof fixture.bundle.assets[number]["metadata"]
      >).directionId;
    },
  }, {
    name: "duplicate directionId",
    mutate(fixture) {
      const first = fixture.bundle.assets[0]!.metadata;
      const second = fixture.bundle.assets[1]!.metadata;
      second.directionId = first.directionId;
      second.directionTitle = first.directionTitle;
      second.directionChecksum = first.directionChecksum;
    },
  }, {
    name: "foreign directionId",
    mutate(fixture) {
      fixture.bundle.assets[2]!.metadata.directionId = "direction-foreign";
    },
  }];

  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-invalid-direction-bound-moodboard-"));
      t.after(() => rm(storageRoot, { recursive: true, force: true }));
      const staging = new OwnedResourceTaskPayloadStaging({
        storageRoot,
        references: referenceGuard({ referenced: false, removals: 0 }),
        journal: journalDouble(),
        now: () => 123_943,
      });
      const fixture = structuredClone(directionBoundMoodboardFixture());
      item.mutate(fixture);
      const input = stageInput({
        taskId: "task-owned-direction-bound-moodboard",
        inputHash: "9".repeat(64),
        resourceId: "resource-owned-direction-bound-moodboard",
        revisionId: "0ce98395-aa2e-5a59-8f52-5df48f075d6e",
        adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
        maxOutputBytes: 48 * MEBIBYTE,
        bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
        mimeType: "application/json",
        metadata: fixture.metadata,
        provenance: fixture.provenance,
        evidence: fixture.evidence,
      });

      await assert.rejects(
        staging.stage(input),
        (error: unknown) => error instanceof ResourceTaskPayloadError
          && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
          && /direction|contract|assignment/i.test(
            String((error.cause as Error | undefined)?.message ?? error.message),
          ),
      );
      assert.equal(await staging.find(input), null);
    });
  }
});

test("rejects tampered Moodboard repair lineage before receipt publication", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-tampered-moodboard-lineage-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 123_950,
  });
  const cases: ReadonlyArray<{
    name: string;
    mutate(fixture: ReturnType<typeof reviewedMoodboardFixture>): void;
  }> = [{
    name: "accepted round",
    mutate(fixture) {
      (fixture.bundle.assets[0]!.metadata.qualityRepair as { acceptedRound: number }).acceptedRound = 0;
    },
  }, {
    name: "review round count",
    mutate(fixture) {
      (((fixture.evidence.qualityReviewHistory as Array<Record<string, unknown>>)[0]!
        .reviews as unknown[])!).pop();
    },
  }, {
    name: "accepted prompt checksum",
    mutate(fixture) {
      const history = (fixture.evidence.qualityReviewHistory as Array<Record<string, unknown>>)[0]!;
      ((history.reviews as Array<Record<string, unknown>>)[1]!).promptChecksum = "f".repeat(64);
    },
  }, {
    name: "accepted image checksum",
    mutate(fixture) {
      const history = (fixture.evidence.qualityReviewHistory as Array<Record<string, unknown>>)[0]!;
      ((history.reviews as Array<Record<string, unknown>>)[1]!).imageChecksum = "f".repeat(64);
    },
  }, {
    name: "global repair count",
    mutate(fixture) {
      (fixture.provenance.qualityRepair as Record<string, unknown>).usedRepairRounds = 0;
    },
  }, {
    name: "production lineage protocol and repair evidence downgrade",
    mutate(fixture) {
      fixture.provenance.protocol = "dezin.legacy-moodboard-generation.v1";
      for (const asset of fixture.bundle.assets) {
        delete (asset.metadata as Partial<typeof asset.metadata>).qualityRepair;
      }
    },
  }, {
    name: "per-round reviewer identity",
    mutate(fixture) {
      const history = (fixture.evidence.qualityReviewHistory as Array<Record<string, unknown>>)[0]!;
      ((history.reviews as Array<Record<string, unknown>>)[1]!).reviewer = { id: "substituted-reviewer" };
    },
  }, {
    name: "omitted frozen reviewer model",
    mutate(fixture) {
      ((fixture.evidence.qualityReviews as Array<Record<string, unknown>>)[0]!).reviewer = {
        id: "fixture-reviewer",
        model: "unfrozen-model",
      };
    },
  }, {
    name: "invalid nullable reviewer base URL",
    mutate(fixture) {
      (fixture.provenance.qualityReviewer as Record<string, unknown>).baseUrl = 42;
    },
  }, {
    name: "non-canonical reviewer base URL",
    mutate(fixture) {
      (fixture.provenance.qualityReviewer as Record<string, unknown>).baseUrl =
        "https://reviewer.example.test";
    },
  }, {
    name: "credential-bearing reviewer base URL",
    mutate(fixture) {
      (fixture.provenance.qualityReviewer as Record<string, unknown>).baseUrl =
        "https://user:secret@reviewer.example.test/";
    },
  }];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixture = structuredClone(reviewedMoodboardFixture());
      item.mutate(fixture);
      const input = stageInput({
        taskId: "task-owned-reviewed-moodboard",
        inputHash: "e".repeat(64),
        resourceId: "resource-owned-reviewed-moodboard",
        revisionId: "cae98395-aa2e-5a59-8f52-5df48f075d6e",
        adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
        maxOutputBytes: 48 * MEBIBYTE,
        bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
        mimeType: "application/json",
        metadata: fixture.metadata,
        provenance: fixture.provenance,
        evidence: fixture.evidence,
      });
      await assert.rejects(
        staging.stage(input),
        (error: unknown) => error instanceof ResourceTaskPayloadError
          && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED"
          && /repair|review|prompt|lineage|provenance/i.test(error.message),
      );
      assert.equal(await staging.find(input), null);
    });
  }
});

test("replay and receipt scan reject self-consistent receipt bytes with tampered Moodboard reviewer lineage", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-replay-moodboard-lineage-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const journal = journalDouble();
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: true, removals: 0 }),
    journal,
    now: () => 123_975,
  });
  const fixture = reviewedMoodboardFixture();
  const input = stageInput({
    taskId: "task-owned-reviewed-moodboard",
    inputHash: "e".repeat(64),
    resourceId: "resource-owned-reviewed-moodboard",
    revisionId: "dae98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });
  await staging.stage(input);
  const relativePath = resourceTaskReceiptRelativePath(input.workspaceId, input.revisionId);
  const receiptPath = join(storageRoot, ...relativePath.split("/"));
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  const evidence = receipt.evidence as Record<string, unknown>;
  const history = (evidence.qualityReviewHistory as Array<Record<string, unknown>>)[0]!;
  const accepted = (history.reviews as Array<Record<string, unknown>>)[1]!;
  accepted.reviewer = { id: "substituted-reviewer" };
  const tamperedBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  const replacementPath = `${receiptPath}.replacement`;
  await writeFile(replacementPath, tamperedBytes);
  await rename(replacementPath, receiptPath);
  journal.replaceReceiptChecksum(
    input.revisionId,
    createHash("sha256").update(tamperedBytes).digest("hex"),
  );

  await assert.rejects(
    staging.find(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_RECEIPT_INVALID"
      && /reviewer/i.test(error.message),
  );
  const scan = await (staging as unknown as ReceiptScanner).scanReceipts({
    limit: 10,
    signal: new AbortController().signal,
  });
  assert.deepEqual(scan.receipts, []);
  assert.deepEqual(scan.invalidReceiptPaths, [relativePath]);
});

test("replay and receipt scan reject a fully rechecksummed production-v2 lineage downgrade", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-replay-moodboard-downgrade-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const journal = journalDouble();
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: true, removals: 0 }),
    journal,
    now: () => 123_976,
  });
  const fixture = reviewedMoodboardFixture();
  const input = stageInput({
    taskId: "task-owned-reviewed-moodboard",
    inputHash: "e".repeat(64),
    resourceId: "resource-owned-reviewed-moodboard",
    revisionId: "ece98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });
  await staging.stage(input);

  const relativePath = resourceTaskReceiptRelativePath(input.workspaceId, input.revisionId);
  const receiptPath = join(storageRoot, ...relativePath.split("/"));
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  const manifestPath = join(storageRoot, ...(receipt.manifestPath as string).split("/"));
  const payloadPath = join(dirname(manifestPath), "payload.bin");
  const bundle = JSON.parse(await readFile(payloadPath, "utf8")) as {
    assets: Array<{ metadata: Record<string, unknown> }>;
  };
  for (const asset of bundle.assets) delete asset.metadata.qualityRepair;
  const payloadBytes = Buffer.from(JSON.stringify(bundle), "utf8");
  const payloadChecksum = createHash("sha256").update(payloadBytes).digest("hex");

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    payload: { byteLength: number; checksum: string };
  };
  manifest.payload.byteLength = payloadBytes.byteLength;
  manifest.payload.checksum = payloadChecksum;
  const manifestBytes = Buffer.from(`${stableStringify(manifest)}\n`, "utf8");
  const manifestChecksum = createHash("sha256").update(manifestBytes).digest("hex");

  const provenance = receipt.provenance as Record<string, unknown>;
  provenance.protocol = "dezin.legacy-moodboard-generation.v1";
  delete provenance.qualityRepair;
  receipt.payloadChecksum = payloadChecksum;
  receipt.manifestChecksum = manifestChecksum;
  receipt.byteSize = payloadBytes.byteLength;
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  const receiptChecksum = createHash("sha256").update(receiptBytes).digest("hex");

  for (const [path, bytes] of [
    [payloadPath, payloadBytes],
    [manifestPath, manifestBytes],
    [receiptPath, receiptBytes],
  ] as const) {
    const replacementPath = `${path}.replacement`;
    await writeFile(replacementPath, bytes);
    await rename(replacementPath, path);
  }
  journal.replacePayloadChecksums(input.revisionId, {
    payloadChecksum,
    manifestChecksum,
    receiptChecksum,
    byteSize: payloadBytes.byteLength,
  });

  await assert.rejects(
    staging.find(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_RECEIPT_INVALID"
      && /lineage|provenance|repair/i.test(error.message),
  );
  const scan = await (staging as unknown as ReceiptScanner).scanReceipts({
    limit: 10,
    signal: new AbortController().signal,
  });
  assert.deepEqual(scan.receipts, []);
  assert.deepEqual(scan.invalidReceiptPaths, [relativePath]);
});

test("strict production-v2 replay and scan reject fully rechecksummed foreign Context Pack lineage", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-replay-v2-context-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const journal = journalDouble();
  const fixture = reviewedMoodboardFixture();
  const authorityCalls: unknown[] = [];
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: true, removals: 0 }),
    journal,
    now: () => 123_976,
    attemptContextAuthority: {
      resolveMoodboardAttemptContext(input) {
        authorityCalls.push(input);
        return {
          contextPackId: fixture.provenance.contextPackId as string,
          contextPackHash: fixture.provenance.contextPackHash as string,
        };
      },
    },
  });
  const input = stageInput({
    taskId: "task-owned-reviewed-moodboard",
    inputHash: "e".repeat(64),
    resourceId: "resource-owned-reviewed-moodboard",
    revisionId: "fce98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });
  await staging.stage(input);

  const relativePath = resourceTaskReceiptRelativePath(input.workspaceId, input.revisionId);
  const receiptPath = join(storageRoot, ...relativePath.split("/"));
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  const manifestPath = join(storageRoot, ...(receipt.manifestPath as string).split("/"));
  const payloadPath = join(dirname(manifestPath), "payload.bin");
  const bundle = JSON.parse(await readFile(payloadPath, "utf8")) as {
    board: { name: string };
  };
  bundle.board.name = "Foreign but fully rechecksummed production-v2 board";
  const payloadBytes = Buffer.from(JSON.stringify(bundle), "utf8");
  const payloadChecksum = createHash("sha256").update(payloadBytes).digest("hex");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    payload: { byteLength: number; checksum: string };
  };
  manifest.payload.byteLength = payloadBytes.byteLength;
  manifest.payload.checksum = payloadChecksum;
  const manifestBytes = Buffer.from(`${stableStringify(manifest)}\n`, "utf8");
  const manifestChecksum = createHash("sha256").update(manifestBytes).digest("hex");
  const foreignHash = "f".repeat(64);
  const provenance = receipt.provenance as Record<string, unknown>;
  provenance.contextPackId = `context-pack-${foreignHash}`;
  provenance.contextPackHash = foreignHash;
  receipt.summary = "Self-consistent foreign production-v2 Context Pack substitution";
  receipt.payloadChecksum = payloadChecksum;
  receipt.manifestChecksum = manifestChecksum;
  receipt.byteSize = payloadBytes.byteLength;
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  const receiptChecksum = createHash("sha256").update(receiptBytes).digest("hex");

  for (const [path, bytes] of [
    [payloadPath, payloadBytes],
    [manifestPath, manifestBytes],
    [receiptPath, receiptBytes],
  ] as const) {
    const replacementPath = `${path}.replacement`;
    await writeFile(replacementPath, bytes);
    await rename(replacementPath, path);
  }
  journal.replacePayloadChecksums(input.revisionId, {
    payloadChecksum,
    manifestChecksum,
    receiptChecksum,
    byteSize: payloadBytes.byteLength,
  });

  await assert.rejects(
    staging.find(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_RECEIPT_INVALID"
      && /exact Attempt Context Pack/i.test(error.message),
  );
  const scan = await (staging as unknown as ReceiptScanner).scanReceipts({
    limit: 10,
    signal: new AbortController().signal,
  });
  assert.deepEqual(scan.receipts, []);
  assert.deepEqual(scan.invalidReceiptPaths, [relativePath]);
  assert.deepEqual(authorityCalls, [{
    taskId: input.taskId,
    attempt: input.attempt,
    inputHash: input.inputHash,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    planId: "plan-owned-resource-stage",
  }]);
});

test("replay and receipt scan reject a fully rechecksummed v3 bundle that self-reports a foreign Context Pack", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-replay-moodboard-context-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const journal = journalDouble();
  const fixture = directionBoundMoodboardFixture();
  const foreignFixture = structuredClone(fixture);
  moveDirectionsToForeignContextPackAndRechecksum(foreignFixture, "7".repeat(64));
  const originalContextPacks = directionContextPacks(fixture);
  const foreignContextPacks = directionContextPacks(foreignFixture);
  const authorityCalls: unknown[] = [];
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: true, removals: 0 }),
    journal,
    now: () => 123_976,
    contextPacks: {
      get(workspaceId, contextPackId) {
        return originalContextPacks.get(workspaceId, contextPackId)
          ?? foreignContextPacks.get(workspaceId, contextPackId);
      },
    },
    attemptContextAuthority: {
      resolveMoodboardAttemptContext(input) {
        authorityCalls.push(input);
        return {
          contextPackId: fixture.provenance.contextPackId as string,
          contextPackHash: fixture.provenance.contextPackHash as string,
        };
      },
    },
  });
  const input = stageInput({
    taskId: "task-owned-direction-bound-moodboard",
    inputHash: "9".repeat(64),
    resourceId: "resource-owned-direction-bound-moodboard",
    revisionId: "4ce98395-aa2e-5a59-8f52-5df48f075d6e",
    adapter: { id: "dezin.resource-adapter.moodboard", version: 1, kind: "moodboard" },
    maxOutputBytes: 48 * MEBIBYTE,
    contextPackId: fixture.provenance.contextPackId as string,
    contextPackHash: fixture.provenance.contextPackHash as string,
    bytes: Buffer.from(JSON.stringify(fixture.bundle), "utf8"),
    mimeType: "application/json",
    metadata: fixture.metadata,
    provenance: fixture.provenance,
    evidence: fixture.evidence,
  });
  await staging.stage(input);
  const relativePath = resourceTaskReceiptRelativePath(input.workspaceId, input.revisionId);
  const receiptPath = join(storageRoot, ...relativePath.split("/"));
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  const manifestPath = join(storageRoot, ...(receipt.manifestPath as string).split("/"));
  const payloadPath = join(dirname(manifestPath), "payload.bin");
  const payloadBytes = Buffer.from(JSON.stringify(foreignFixture.bundle), "utf8");
  const payloadChecksum = createHash("sha256").update(payloadBytes).digest("hex");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    payload: { byteLength: number; checksum: string };
  };
  manifest.payload.byteLength = payloadBytes.byteLength;
  manifest.payload.checksum = payloadChecksum;
  const manifestBytes = Buffer.from(`${stableStringify(manifest)}\n`, "utf8");
  const manifestChecksum = createHash("sha256").update(manifestBytes).digest("hex");
  receipt.summary = "Self-consistent foreign Context Pack substitution";
  receipt.metadata = foreignFixture.metadata;
  receipt.provenance = foreignFixture.provenance;
  receipt.evidence = foreignFixture.evidence;
  receipt.payloadChecksum = payloadChecksum;
  receipt.manifestChecksum = manifestChecksum;
  receipt.byteSize = payloadBytes.byteLength;
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  const receiptChecksum = createHash("sha256").update(receiptBytes).digest("hex");

  for (const [path, bytes] of [
    [payloadPath, payloadBytes],
    [manifestPath, manifestBytes],
    [receiptPath, receiptBytes],
  ] as const) {
    const replacementPath = `${path}.replacement`;
    await writeFile(replacementPath, bytes);
    await rename(replacementPath, path);
  }
  journal.replacePayloadChecksums(input.revisionId, {
    payloadChecksum,
    manifestChecksum,
    receiptChecksum,
    byteSize: payloadBytes.byteLength,
  });

  await assert.rejects(
    staging.find(input),
    (error: unknown) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_RECEIPT_INVALID"
      && /Attempt Context Pack/i.test(error.message),
  );
  const scan = await (staging as unknown as ReceiptScanner).scanReceipts({
    limit: 10,
    signal: new AbortController().signal,
  });
  assert.deepEqual(scan.receipts, []);
  assert.deepEqual(scan.invalidReceiptPaths, [relativePath]);
  assert.deepEqual(authorityCalls, [{
    taskId: input.taskId,
    attempt: input.attempt,
    inputHash: input.inputHash,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    planId: "plan-owned-resource-stage",
  }]);
});

test("scans receipts with a bounded stable cursor that advances across every path", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-scan-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: true, removals: 0 }),
    journal: journalDouble(),
  });
  for (let index = 1; index <= 3; index += 1) {
    await staging.stage(stageInput({
      taskId: `task-owned-resource-scan-${index}`,
      inputHash: String(index).repeat(64),
      revisionId: `7ae98395-aa2e-5a59-8f52-5df48f075d6${index}`,
      summary: `Owned generated scan payload ${index}`,
    }));
  }
  const scanner = staging as unknown as ReceiptScanner;
  assert.equal(typeof scanner.scanReceipts, "function");
  const seenPaths: string[] = [];
  let cursor: ReceiptScanCursor | null = null;
  do {
    const page = await scanner.scanReceipts({
      cursor,
      limit: 1,
      signal: new AbortController().signal,
    });
    assert.ok(page.scanned <= 1);
    assert.ok(page.receipts.length <= 1);
    assert.equal(page.invalidReceiptPaths.length, 0);
    seenPaths.push(...page.receipts.map((entry) => entry.relativePath));
    cursor = page.nextCursor;
  } while (cursor !== null);

  assert.equal(seenPaths.length, 3);
  assert.equal(new Set(seenPaths).size, 3);
  assert.deepEqual(seenPaths, [...seenPaths].sort());
});

test("recovers when payload sealing committed before the attempt receipt", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-seal-crash-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const input = stageInput();
  await sealResourceRevisionPayload({
    storageRoot,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    mimeType: input.mimeType,
    bytes: input.bytes,
  });
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 124_000,
  });

  assert.equal(await staging.find(input), null);
  const staged = await staging.stage(input);
  assert.deepEqual(await staging.find(input), staged);
  assert.equal(await staging.cleanupIfUnreferenced(staged), true);
  assert.equal(await staging.find(input), null);
  assert.equal(lstatSync(join(storageRoot, ...staged.manifestPath.split("/"))).isFile(), true);
  assert.equal(lstatSync(join(
    storageRoot,
    ...`${dirname(staged.manifestPath)}/payload.bin`.split("/"),
  )).isFile(), true);
});

test("converges concurrent identical staging races on one immutable receipt", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-race-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  let timestamp = 130_000;
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => timestamp++,
  });
  const input = stageInput();

  const settled = await Promise.allSettled(
    Array.from({ length: 64 }, () => staging.stage(input)),
  );
  const rejected = settled.filter((result) => result.status === "rejected");
  assert.equal(
    rejected.length,
    0,
    rejected.map((result) => String(result.reason?.stack ?? result.reason)).join("\n\n"),
  );
  const receipts = settled
    .filter((result): result is PromiseFulfilledResult<ResourceTaskPayloadReceipt> => result.status === "fulfilled")
    .map((result) => result.value);

  for (const receipt of receipts.slice(1)) {
    assert.deepEqual(receipt, receipts[0]);
  }
  assert.deepEqual(await staging.find(input), receipts[0]);
});

test("recovers its own interrupted receipt publication hardlink before replay", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-receipt-recovery-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 130_500,
  });
  const input = stageInput();
  const committed = await staging.stage(input);
  const receiptPath = join(storageRoot, ...resourceTaskReceiptRelativePath(
    input.workspaceId,
    input.revisionId,
  ).split("/"));
  const staleTemporary = join(
    dirname(receiptPath),
    ".generation-receipt-00000000-0000-4000-8000-000000000001.tmp",
  );
  await link(receiptPath, staleTemporary);
  assert.equal((await lstat(receiptPath)).nlink, 2);

  assert.deepEqual(await staging.stage(input), committed);
  await assert.rejects(() => lstat(staleTemporary), /ENOENT/);
  assert.equal((await lstat(receiptPath)).nlink, 1);
});

test("rejects a receipt with an unowned hardlink", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-receipt-hardlink-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: true, removals: 0 }),
    journal: journalDouble(),
    now: () => 130_750,
  });
  const input = stageInput();
  await staging.stage(input);
  const receiptPath = join(storageRoot, ...resourceTaskReceiptRelativePath(
    input.workspaceId,
    input.revisionId,
  ).split("/"));
  const foreignHardlink = join(storageRoot, "foreign-receipt-hardlink.json");
  await link(receiptPath, foreignHardlink);

  await assert.rejects(
    staging.find(input),
    (error) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_RECEIPT_INVALID"
      && /hardlink/.test(error.message),
  );
  assert.equal((await lstat(foreignHardlink)).isFile(), true);
});

test("rejects an immutable revision collision without changing the committed payload", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-collision-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const state = { referenced: false, removals: 0 };
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard(state),
    journal: journalDouble(),
    now: () => 131_000,
  });
  const input = stageInput();
  const committed = await staging.stage(input);

  await assert.rejects(
    staging.stage({
      ...input,
      bytes: new TextEncoder().encode("different bytes for the same revision"),
      summary: "Conflicting generated payload",
    }),
    (error) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_STAGE_FAILED",
  );

  assert.deepEqual(await staging.find(input), committed);
  assert.equal(state.removals, 0);
});

test("deletes owned files only inside an atomic no-reference guard", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-cleanup-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const state = { referenced: true, removals: 0 };
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard(state),
    journal: journalDouble(),
    now: () => 125_000,
  });
  const input = stageInput();
  const receipt = await staging.stage(input);

  assert.equal(await staging.cleanupIfUnreferenced(receipt), false);
  assert.deepEqual(await staging.find(input), receipt);
  state.referenced = false;
  assert.equal(await staging.cleanupIfUnreferenced(receipt), true);
  assert.equal(state.removals, 1);
  assert.equal(await staging.find(input), null);
});

test("pins the durable reference guard method at staging construction", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-guard-pin-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const state = { referenced: false, removals: 0 };
  const guard = referenceGuard(state);
  let substitutedCalls = 0;
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: guard,
    journal: journalDouble(),
  });
  const receipt = await staging.stage(stageInput());
  (guard as { removeIfUnreferenced: ResourceTaskPayloadReferenceGuard["removeIfUnreferenced"] })
    .removeIfUnreferenced = async () => {
      substitutedCalls += 1;
      return false;
    };

  assert.equal(await staging.cleanupIfUnreferenced(receipt), true);
  assert.equal(state.removals, 1);
  assert.equal(substitutedCalls, 0);
});

test("rejects MIME-incompatible bytes without leaving a replay receipt", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-mime-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 126_000,
  });
  const input = stageInput({ mimeType: "image/png" });

  await assert.rejects(staging.stage(input));
  assert.equal(await staging.find(input), null);
});

test("refuses a symlink-substituted receipt during replay", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-symlink-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: false, removals: 0 }),
    journal: journalDouble(),
    now: () => 127_000,
  });
  const input = stageInput();
  await staging.stage(input);
  const receiptPath = join(storageRoot, ...resourceTaskReceiptRelativePath(
    input.workspaceId,
    input.revisionId,
  ).split("/"));
  const moved = `${receiptPath}.moved`;
  await rename(receiptPath, moved);
  await symlink(moved, receiptPath);

  await assert.rejects(
    staging.find(input),
    (error) => error instanceof ResourceTaskPayloadError
      && error.failureClass === "storage",
  );
});

test("refuses a linked receipt parent even when the receipt is missing", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "dezin-resource-stage-parent-link-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot,
    references: referenceGuard({ referenced: true, removals: 0 }),
    journal: journalDouble(),
    now: () => 127_500,
  });
  const input = stageInput();
  await staging.stage(input);
  const receiptPath = join(storageRoot, ...resourceTaskReceiptRelativePath(
    input.workspaceId,
    input.revisionId,
  ).split("/"));
  const revisionDirectory = dirname(receiptPath);
  const movedDirectory = `${revisionDirectory}.moved`;
  await rename(revisionDirectory, movedDirectory);
  await rm(join(movedDirectory, "generation-receipt.json"));
  await symlink(movedDirectory, revisionDirectory);

  await assert.rejects(
    staging.find(input),
    (error) => error instanceof ResourceTaskPayloadError
      && error.code === "RESOURCE_PAYLOAD_RECEIPT_INVALID",
  );
});
