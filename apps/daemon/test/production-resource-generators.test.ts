import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { Store } from "../../../packages/core/src/index.ts";
import {
  checksumBytes,
  estimateContextTokens,
  stableStringify,
  type ContextPack,
} from "../src/context/context-types.ts";
import type { ResourceGenerationAdapterInput } from "../src/orchestration/resource-task-executor.ts";
import {
  ProductionResourceGenerationError,
  createProductionResourceGenerationImplementations,
  type ProductionResourceAgentRequest,
  type ProductionResearchEvidencePort,
  type ProductionResearchGroundednessPort,
  type ProductionSharinganCaptureExportRequest,
} from "../src/orchestration/production-resource-generators.ts";
import { freezeResourceExecutionProfile } from "../src/orchestration/production-generation-context.ts";
import { createProductionResourceRuntimePorts } from "../src/orchestration/production-resource-runtime.ts";
import { decodeSharinganCaptureResourceBundle } from "../src/orchestration/sharingan-capture-resource-bundle.ts";
import { createProductionSafeBoundedExternalFetcher } from "../src/production-safe-external-fetch.ts";
import {
  ResearchResourceRevisionError,
  selectResearchRevisionDirection,
} from "../src/research-resource-revision.ts";
import { semanticSharinganCaptureFiles } from "./support/sharingan-capture-fixture.ts";

const CONTEXT_CONTENT = "Create a rigorous editorial design direction for a climate data product.";
const CONTEXT_EXCERPT = "rigorous editorial design direction";
const WEB_EXCERPT_1 = "Accessible alternatives and meaningful image treatment.";
const WEB_EXCERPT_2 = "Legible chart selection and annotation.";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.from(data);
  const chunk = Buffer.alloc(12 + body.byteLength);
  chunk.writeUInt32BE(body.byteLength, 0);
  typeBytes.copy(chunk, 4);
  body.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, body])), 8 + body.byteLength);
  return chunk;
}

function pngDocument(width: number, height: number, scanlines: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pack(
  resourceId = "resource-1",
  kind: ResourceGenerationAdapterInput["resourceKind"] = "research",
  imageConfigured = true,
): ContextPack {
  const title = kind === "research" ? "Climate product research" : kind === "moodboard" ? "Editorial moodboard" : "Exact capture";
  const executionProfile = freezeResourceExecutionProfile({
    ownership: {
      projectId: "project-1",
      workspaceId: "workspace-1",
      planId: "plan-1",
      taskId: "task-1",
      targetResourceId: resourceId,
    },
    resourceKind: kind,
    adapter: { id: `dezin.resource-adapter.${kind}`, version: 1, kind },
    settings: {
      agentCommand: "claude", model: "", apiBaseUrl: "", apiKey: "",
      defaultDesignSystemId: "modern-minimal", customInstructions: "", imageApiBaseUrl: "",
      imageApiKey: imageConfigured ? "moodboard-image-secret" : "",
      imageApiKeyConfigured: imageConfigured,
      imageModel: imageConfigured ? "fal-ai/flux/dev" : "",
      removeBackgroundModel: "", editRegionModel: "",
      extractLayerModel: "", videoApiBaseUrl: "", videoApiKey: "", videoModel: "",
      aiProviderId: "fal", aiProviderEnabled: true, aiProviderModels: "fal-ai/flux/dev",
      aiProviderOrganization: "", aiProviderProfiles: "", visualQaEnabled: false,
      autoFixLiveRuntimeErrors: false, sharinganAffirmed: false, visualQaAgentCommand: "",
      visualQaModel: "", researchEnabled: true, researchAgentCommand: "", researchModel: "",
      autoImproveEnabled: true, autoImproveMaxRounds: 2,
    },
  });
  const targetContent = stableStringify({
    protocol: "dezin.generation-target-context.v2",
    projectId: "project-1",
    workspaceId: "workspace-1",
    planId: "plan-1",
    taskId: "task-1",
    taskKind: "resource",
    target: { type: "resource", workspaceId: "workspace-1", id: resourceId },
    payload: {
      version: 2,
      operation: {
        operation: "revise", nodeId: "node-resource-1", resourceId, kind, title,
        revisionPolicy: { kind: "generate" },
      },
      brief: {
        proposalRationale: "Build one evidence-led, reusable direction before producing pages.",
        assumptions: ["The audience needs dense information without visual noise."],
        targetInstructions: { operation: "revise", kind, title },
      },
      capabilityDescriptors: [{ id: "browser", kind: "browser", required: true }],
      adapter: executionProfile.adapter,
    },
    capabilities: ["browser"],
    qaProfile: {
      requiredFrameIds: [], blockingSeverities: [], requireRuntimeChecks: false, requireVisualReview: false,
    },
    resourceLimits: {
      timeoutMs: 60_000, maxAgentTurns: 1, maxRepairRounds: 0, maxOutputBytes: 8 * 1024 * 1024,
      capacityClasses: kind === "sharingan-capture" ? ["browser"] : ["agent"],
    },
    expectedSnapshotId: "snapshot-1",
    graphRevision: 7,
    kernelRevisionId: "kernel-1",
    resourceExecutionProfile: executionProfile,
  });
  const contextItem = {
    ordinal: 0,
    contextClass: "explicit" as const,
    ref: { kind: "inline" as const, id: "approved-context" },
    resolvedKind: "inline" as const,
    content: CONTEXT_CONTENT,
    checksum: sha256(CONTEXT_CONTENT),
    reason: "approved context",
    trustLevel: "untrusted" as const,
    capabilities: [],
    boundary: { source: "fixture:approved-context", readOnly: true as const, mayGrantCapabilities: false as const },
    tokenEstimate: 18,
    provenance: { fixture: true },
    provided: true as const,
  };
  const targetItem = {
    ordinal: 1,
    contextClass: "target" as const,
    ref: { kind: "inline" as const, id: resourceId },
    resolvedKind: "inline" as const,
    content: targetContent,
    checksum: checksumBytes(targetContent),
    reason: "exact immutable Generation Task target contract and Resource execution profile",
    trustLevel: "trusted" as const,
    capabilities: [],
    boundary: { source: "generation-task:task-1", readOnly: true as const, mayGrantCapabilities: false as const },
    tokenEstimate: estimateContextTokens(targetContent),
    provenance: {
      projectId: "project-1", workspaceId: "workspace-1", planId: "plan-1", taskId: "task-1",
      targetResourceId: resourceId, resourceExecutionProfileChecksum: executionProfile.checksum,
      expectedSnapshotId: "snapshot-1", graphRevision: 7, kernelRevisionId: "kernel-1",
    },
    provided: true as const,
  };
  const body = {
    protocol: "dezin-context-pack-v1" as const,
    workspaceId: "workspace-1",
    graphRevision: 7,
    target: { type: "resource" as const, id: resourceId },
    intent: "generate",
    messageChecksum: "b".repeat(64),
    items: [contextItem, targetItem],
    omissions: [],
    tokenEstimate: contextItem.tokenEstimate + targetItem.tokenEstimate,
  };
  const hash = checksumBytes(stableStringify(body));
  return {
    ...body,
    intent: "generate",
    id: `context-pack-${hash}`,
    manifestPath: `context-packs/${hash}.json`,
    hash,
    createdAt: 1,
  };
}

const HASH = pack().hash;

function exactPackForId(_workspaceId: string, id: string): ContextPack | null {
  for (const kind of [
    "research", "moodboard", "sharingan-capture", "file", "asset", "effect", "external-reference",
  ] as const) {
    const candidate = pack("resource-1", kind);
    if (candidate.id === id) return candidate;
  }
  return null;
}

function input(kind: ResourceGenerationAdapterInput["resourceKind"]): ResourceGenerationAdapterInput {
  return {
    taskId: "task-1",
    planId: "plan-1",
    attempt: 2,
    inputHash: "d".repeat(64),
    workspaceId: "workspace-1",
    resourceId: "resource-1",
    parentRevisionId: "resource-revision-0",
    contextPackId: pack("resource-1", kind).id,
    operation: "revise",
    nodeId: "node-resource-1",
    title: kind === "research" ? "Climate product research" : kind === "moodboard" ? "Editorial moodboard" : "Exact capture",
    resourceKind: kind,
    brief: {
      proposalRationale: "Build one evidence-led, reusable direction before producing pages.",
      assumptions: ["The audience needs dense information without visual noise."],
      targetInstructions: { operation: "revise", kind, title: "ignored by fixture typing" },
    },
    capabilityDescriptors: [{ id: "browser", kind: "browser", required: true }],
    signal: new AbortController().signal,
  } as ResourceGenerationAdapterInput;
}

function scopeOf(request: ProductionResourceAgentRequest | ProductionSharinganCaptureExportRequest) {
  return request.scope;
}

function researchDraft() {
  return {
    protocol: "dezin.research-generation.v3",
    executiveSummary: "Decision-grade evidence favors a calm editorial system that makes provenance visible.",
    sources: [
      {
        id: "source-context",
        kind: "context",
        title: "Approved product context",
        locator: `context-pack:context-pack-${HASH}#item:0`,
        excerpt: CONTEXT_EXCERPT,
        binding: {
          contextPackId: `context-pack-${HASH}`,
          contextPackHash: HASH,
          itemOrdinal: 0,
          itemChecksum: sha256(CONTEXT_CONTENT),
        },
        notes: "Frozen project assumptions.",
      },
      {
        id: "source-web-1",
        kind: "web",
        title: "W3C data visualization accessibility",
        locator: "https://www.w3.org/WAI/tutorials/images/",
        excerpt: WEB_EXCERPT_1,
        binding: null,
        notes: "Accessible alternatives and meaningful image treatment.",
      },
      {
        id: "source-web-2",
        kind: "web",
        title: "GOV.UK data visualisation guidance",
        locator: "https://analysisfunction.civilservice.gov.uk/policy-store/data-visualisation-charts/",
        excerpt: WEB_EXCERPT_2,
        binding: null,
        notes: "Legible chart selection and annotation.",
      },
    ],
    findings: [
      { id: "finding-1", statement: "Readers need source and update recency near each metric.", implication: "Pair each chart with compact provenance instead of a distant methodology page.", confidence: "high", supports: [{ sourceId: "source-context", quote: CONTEXT_EXCERPT }, { sourceId: "source-web-2", quote: WEB_EXCERPT_2 }] },
      { id: "finding-2", statement: "Color alone cannot carry state or series identity.", implication: "Use labels, shape, line style, and contrast together.", confidence: "high", supports: [{ sourceId: "source-web-1", quote: WEB_EXCERPT_1 }, { sourceId: "source-web-2", quote: WEB_EXCERPT_2 }] },
      { id: "finding-3", statement: "Dense evidence benefits from an editorial reading sequence.", implication: "Establish one primary takeaway and progressively disclose detail.", confidence: "medium", supports: [{ sourceId: "source-context", quote: CONTEXT_EXCERPT }, { sourceId: "source-web-2", quote: WEB_EXCERPT_2 }] },
    ],
    designPrinciples: [
      { id: "principle-1", title: "Provenance in the reading flow", rationale: "Trust should be inspectable at the point of interpretation.", findingIds: ["finding-1"] },
      { id: "principle-2", title: "Redundant visual encoding", rationale: "Every state remains legible without hue perception.", findingIds: ["finding-2"] },
      { id: "principle-3", title: "One narrative, layered detail", rationale: "Scanning and close reading must both work.", findingIds: ["finding-3"] },
    ],
    directions: [
      { id: "direction-1", title: "Field Journal", thesis: "A measured editorial report with annotated evidence bands.", visualLanguage: ["warm paper ground", "ink-led hierarchy", "precise rule lines"], interactionPrinciples: ["stable scroll narrative", "details expand in place"], risks: ["Can feel too archival if motion and live status are absent."], findingIds: ["finding-1", "finding-3"] },
      { id: "direction-2", title: "Signal Desk", thesis: "A compact operational surface that foregrounds change and confidence.", visualLanguage: ["cool neutral canvas", "high-contrast signal marks", "tabular typography"], interactionPrinciples: ["keyboard-first comparison", "persistent provenance drawer"], risks: ["Can become dashboard-like without a strong editorial lead."], findingIds: ["finding-1", "finding-2"] },
    ],
    openQuestions: ["Which metrics have stable update cadences?", "Which claims need downloadable source tables?"],
  };
}

function groundedResearchVerifier(supported = true): ProductionResearchGroundednessPort {
  return {
    async verifyClaims(request) {
      return {
        protocol: "dezin.research-groundedness-result.v1",
        scope: request.scope,
        verifier: { id: "claude", model: "claude-sonnet" },
        verdicts: request.claims.map((claim) => ({
          findingId: claim.findingId,
          supported: supported && claim.supports.length > 0,
          supportReceiptIds: supported ? claim.supports.map((support) => support.supportReceiptId) : [],
          rationale: supported ? "The exact quotes directly support this statement." : "The quotes are adjacent but do not directly support this statement.",
        })),
      };
    },
  };
}

function verifiedResearchEvidence(overrides: Record<string, unknown> = {}): ProductionResearchEvidencePort {
  return {
    async retrieveWebEvidence(request) {
      const bytes = Buffer.from(`Before. ${request.excerpt} After.`, "utf8");
      assert.ok(bytes.byteLength <= request.maxBytes);
      return {
        protocol: "dezin.research-web-evidence-representation.v1" as const,
        scope: request.scope,
        sourceId: request.sourceId,
        requestedUrl: request.requestedUrl,
        finalUrl: request.requestedUrl,
        retrievedAt: 1_000,
        status: 200,
        mimeType: "text/html",
        bytes,
        ...overrides,
      } as any;
    },
  };
}

function moodboardDraft() {
  return {
    protocol: "dezin.moodboard-generation.v2",
    concept: "A field notebook for live climate evidence: tactile, restrained, and exact.",
    designThesis: "Use editorial pacing and physical-material cues while keeping every number machine-clean.",
    palette: [
      { name: "Paper", value: "#F3F0E8", role: "canvas" },
      { name: "Carbon", value: "#171916", role: "primary text" },
      { name: "Lichen", value: "#6E7F51", role: "positive signal" },
      { name: "Ember", value: "#B64B35", role: "warning signal" },
    ],
    typography: [
      { role: "display", family: "Newsreader", treatment: "Tight editorial headlines with optical sizing." },
      { role: "data", family: "IBM Plex Mono", treatment: "Tabular figures, timestamps, and provenance labels." },
    ],
    composition: ["One dominant evidence story per viewport.", "Use asymmetrical margins to create annotation space.", "Keep charts aligned to a visible baseline grid."],
    motion: ["Reveal annotations in reading order.", "Use short linear transitions for live metric changes."],
    avoid: ["Generic glass cards", "Decorative gradients", "Color-only status"],
    references: [
      { id: "reference-1", title: "Field report paper texture", locator: "generated:field-report-paper", notes: "Material and lighting reference." },
      { id: "reference-2", title: "Editorial data spread", locator: "context-pack:editorial-spread", notes: "Hierarchy and annotation reference." },
    ],
    assetSpecs: [{
      id: "asset-1",
      fileName: "field-report.png",
      prompt: "Editorial still life of a field research notebook, warm paper, precise ink annotations, soft natural side light, restrained lichen and ember accents, no text or logos.",
      caption: "A restrained paper and ink material reference.",
      aspectRatio: "3:2" as const,
      referenceIds: ["reference-1", "reference-2"],
    }],
  };
}

const MOODBOARD_PNG = pngDocument(512, 512, Buffer.alloc(512 * (1 + 512 * 4)));

function moodboardImplementation(
  draft: ReturnType<typeof moodboardDraft>,
  bytes: Buffer = MOODBOARD_PNG,
  review: "pass" | "fail" = "pass",
) {
  return createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: {
      async generateStructured(request) {
        return {
          protocol: "dezin.resource-agent-result.v1",
          scope: request.scope,
          generator: { id: "claude" },
          output: draft,
        };
      },
    },
    moodboardImages: {
      async generateImage(request) {
        const profile = request.executionProfile.imageGeneration!;
        return {
          protocol: "dezin.moodboard-image-result.v1",
          scope: request.scope,
          assetId: request.asset.id,
          generator: {
            providerId: profile.providerId,
            model: profile.model,
            baseUrl: profile.baseUrl,
            apiVersion: profile.apiVersion,
          },
          mimeType: "image/png",
          bytes,
        };
      },
    },
    moodboardQuality: {
      async reviewImage(request) {
        return {
          protocol: "dezin.moodboard-quality-result.v1",
          scope: request.scope,
          assetId: request.asset.id,
          checksum: request.image.checksum,
          decision: review,
          semanticMatch: review === "pass",
          visualQuality: review,
          findings: review === "pass" ? [] : ["The image is generic and does not express the specified material system."],
        };
      },
    },
  });
}

function captureFiles(
  marker = "old",
  overrides: Omit<Parameters<typeof semanticSharinganCaptureFiles>[0], "marker"> = {},
) {
  return semanticSharinganCaptureFiles({ marker, ...overrides });
}

test("Research generation consumes one exact Context Pack and emits structured traceable owned JSON", async () => {
  const requests: ProductionResourceAgentRequest[] = [];
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: {
      async generateStructured(request) {
        requests.push(request);
        return {
          protocol: "dezin.resource-agent-result.v1",
          scope: scopeOf(request),
          generator: { id: "claude" },
          output: researchDraft(),
        };
      },
    },
    researchEvidence: verifiedResearchEvidence(),
    researchGroundedness: groundedResearchVerifier(),
  });

  const result = await implementations.research!(input("research"));
  assert.equal(result.mimeType, "application/json");
  const bundle = JSON.parse(Buffer.from(result.bytes).toString("utf8")) as any;
  assert.equal(bundle.format, "dezin-research-resource-bundle");
  assert.equal(bundle.version, 3);
  assert.equal(bundle.scope.taskId, "task-1");
  assert.equal(bundle.contextPack.id, `context-pack-${HASH}`);
  assert.equal(bundle.sources.length, 3);
  assert.equal(bundle.findings.length, 3);
  assert.equal(bundle.designPrinciples.length, 3);
  assert.equal(bundle.directions.length, 2);
  assert.equal(bundle.receipts.length, 3);
  assert.equal(bundle.supportReceipts.length, 6);
  assert.equal(bundle.sources[0].verification, "verified");
  assert.equal(bundle.sources[0].receiptId, bundle.receipts[0].id);
  assert.deepEqual(bundle.receipts[0], {
    protocol: "dezin.research-evidence-receipt.v1",
    id: bundle.receipts[0].id,
    checksum: bundle.receipts[0].checksum,
    sourceId: "source-context",
    sourceKind: "context",
    verification: "verified",
    contextPackId: `context-pack-${HASH}`,
    contextPackHash: HASH,
    contextItemOrdinal: 0,
    contextItemChecksum: sha256(CONTEXT_CONTENT),
    excerpt: {
      text: CONTEXT_EXCERPT,
      utf8Start: 9,
      utf8End: 44,
    },
  });
  assert.match(bundle.receipts[0].id, /^research-evidence-[a-f0-9]{64}$/);
  assert.match(bundle.receipts[0].checksum, /^[a-f0-9]{64}$/);
  assert.equal(bundle.receipts[1].requestedUrl, bundle.sources[1].locator);
  assert.equal(bundle.receipts[1].canonicalUrl, bundle.sources[1].locator);
  assert.equal(bundle.receipts[1].contentChecksum, sha256(Buffer.from(`Before. ${WEB_EXCERPT_1} After.`)));
  assert.deepEqual(bundle.receipts[1].excerpt, {
    text: WEB_EXCERPT_1,
    utf8Start: 8,
    utf8End: 63,
  });
  assert.equal(bundle.findings.every((finding: any) => finding.evidenceStatus === "evidence"), true);
  assert.equal(bundle.findings.every((finding: any) => finding.groundedness.verified === true), true);
  assert.equal(bundle.designPrinciples.every((principle: any) => principle.evidenceStatus === "evidence"), true);
  assert.equal(bundle.directions.every((direction: any) => direction.evidenceStatus === "evidence"), true);
  assert.deepEqual(result.metadata, {
    format: "dezin-research-resource-bundle",
    version: 3,
    qualityState: "grounded",
    requiresHypothesisConfirmation: false,
    groundednessVerifierAvailable: true,
    sourceCount: 3,
    verifiedSourceCount: 3,
    unverifiedSourceCount: 0,
    supportReceiptCount: 6,
    findingCount: 3,
    evidenceFindingCount: 3,
    hypothesisFindingCount: 0,
    principleCount: 3,
    directionCount: 2,
    evidenceDirectionCount: 2,
    hypothesisDirectionCount: 0,
  });
  assert.equal(result.provenance.contextPackHash, HASH);
  assert.equal(result.provenance.generatorId, "claude");
  assert.deepEqual(result.evidence.verifiedSourceIds, ["source-context", "source-web-1", "source-web-2"]);
  assert.deepEqual(result.evidence.unverifiedSourceIds, []);
  assert.deepEqual(result.evidence.receiptChecksums, bundle.receipts.map((receipt: any) => receipt.checksum));
  assert.deepEqual(result.provenance.researchEvidence, {
    protocol: "dezin.research-evidence-provenance.v2",
    verifiedSourceCount: 3,
    unverifiedSourceCount: 0,
    evidenceFindingCount: 3,
    hypothesisFindingCount: 0,
    receiptIds: bundle.receipts.map((receipt: any) => receipt.id),
    supportReceiptIds: bundle.supportReceipts.map((receipt: any) => receipt.id),
    groundednessVerifier: { id: "claude", model: "claude-sonnet" },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.protocol, "dezin.resource-agent-request.v1");
  assert.equal(requests[0]!.scope.inputHash, "d".repeat(64));
  assert.equal(requests[0]!.contextPack.hash, HASH);
  assert.equal(requests[0]!.executionProfile.ownership.projectId, "project-1");
  assert.equal(requests[0]!.executionProfile.resource.kind, "research");
  assert.deepEqual(requests[0]!.executionProfile.adapter, {
    id: "dezin.resource-adapter.research", version: 1, kind: "research",
  });
  assert.equal(requests[0]!.executionProfile.agent.providerId, "claude");
  assert.equal(JSON.parse(requests[0]!.message).protocol, "dezin.research-generation-prompt.v3");
  assert.ok(requests[0]!.maxOutputBytes >= result.bytes.byteLength);
  assert.equal(requests[0]!.signal.aborted, false);

  const authority = pack("resource-1", "research");
  const validationBundle = structuredClone(bundle);
  validationBundle.brief.targetInstructions.title = validationBundle.scope.title;
  const validationInput = {
    bytes: Buffer.from(stableStringify(validationBundle), "utf8"),
    directionId: "direction-1",
    workspaceId: "workspace-1",
    resourceId: "resource-1",
    parentRevisionId: "resource-revision-0",
    revisionMetadata: { adapter: result.metadata },
    revisionProvenance: {
      kind: "generation-task-resource",
      planId: "plan-1",
      taskId: "task-1",
      attempt: 2,
      inputHash: "d".repeat(64),
      adapter: { id: "dezin.resource-adapter.research", version: 1, kind: "research" },
      adapterProvenance: result.provenance,
    },
    contextPack: authority,
  } as const;
  assert.equal(selectResearchRevisionDirection(validationInput).id, "direction-1");
  for (const mutate of [
    (candidate: any) => { candidate.graphRevision += 1; },
    (candidate: any) => { candidate.items[0].ordinal = 1; },
    (candidate: any) => { candidate.items[0].checksum = "f".repeat(64); },
  ]) {
    const changedAuthority = structuredClone(authority) as any;
    mutate(changedAuthority);
    assert.throws(
      () => selectResearchRevisionDirection({ ...validationInput, contextPack: changedAuthority }),
      (error: unknown) => error instanceof ResearchResourceRevisionError
        && /immutable authority|Context item/i.test(error.message),
    );
  }
});

test("legacy Research v1/v2 directions remain selectable but cross the v3 boundary only as hypotheses", () => {
  const baseDirection = {
    id: "legacy-direction",
    title: "Legacy direction",
    thesis: "Preserve an already approved direction while requiring new evidence for future claims.",
    visualLanguage: ["measured hierarchy", "restrained contrast"],
    interactionPrinciples: ["keep the primary action stable"],
    risks: ["Legacy evidence cannot be independently replayed."],
    findingIds: ["legacy-finding"],
  };
  for (const version of [1, 2] as const) {
    const direction = version === 1
      ? baseDirection
      : {
          ...baseDirection,
          evidenceStatus: "evidence",
          evidenceFindingIds: ["legacy-finding"],
          hypothesisFindingIds: [],
        };
    const selected = selectResearchRevisionDirection({
      bytes: Buffer.from(JSON.stringify({
        format: "dezin-research-resource-bundle",
        version,
        scope: { workspaceId: "workspace-1", resourceId: "resource-1" },
        directions: [direction],
      }), "utf8"),
      directionId: direction.id,
      workspaceId: "workspace-1",
      resourceId: "resource-1",
      parentRevisionId: null,
      revisionMetadata: {},
      revisionProvenance: {},
      contextPack: null,
    });
    assert.deepEqual(selected, {
      ...baseDirection,
      evidenceStatus: "hypothesis",
      evidenceFindingIds: [],
      hypothesisFindingIds: ["legacy-finding"],
    });
  }
});

test("production Research composition promotes safe HTTP evidence to verified receipts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-research-fetch-"));
  const store = new Store();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const fetchExternal = createProductionSafeBoundedExternalFetcher({
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    requestHop: async (hop) => ({
      status: 200,
      mimeType: "text/html; charset=utf-8",
      bytes: Buffer.from(hop.url.hostname === "www.w3.org"
        ? `Before. ${WEB_EXCERPT_1} After.`
        : `Before. ${WEB_EXCERPT_2} After.`, "utf8"),
      location: null,
      remoteAddress: hop.pinnedAddress.address,
    }),
  });
  const runtime = createProductionResourceRuntimePorts({
    store,
    dataDir: root,
    researchExternalFetch: fetchExternal,
    now: () => 1_234,
  });
  assert.ok(runtime.researchEvidence);
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: {
      async generateStructured(request) {
        return {
          protocol: "dezin.resource-agent-result.v1",
          scope: scopeOf(request),
          generator: { id: "claude" },
          output: researchDraft(),
        };
      },
    },
    researchEvidence: runtime.researchEvidence,
    researchGroundedness: groundedResearchVerifier(),
  });

  const result = await implementations.research!(input("research"));
  const bundle = JSON.parse(Buffer.from(result.bytes).toString("utf8")) as {
    sources: Array<{ id: string; verification: string }>;
    receipts: Array<{ sourceId: string; verification: string; retrievedAt?: number }>;
  };
  assert.deepEqual(bundle.sources.map((source) => [source.id, source.verification]), [
    ["source-context", "verified"],
    ["source-web-1", "verified"],
    ["source-web-2", "verified"],
  ]);
  assert.deepEqual(bundle.receipts.slice(1).map((receipt) => [
    receipt.sourceId,
    receipt.verification,
    receipt.retrievedAt,
  ]), [
    ["source-web-1", "verified", 1_234],
    ["source-web-2", "verified", 1_234],
  ]);
});

test("Research generation keeps unverifiable web citations explicit and downgrades every dependent claim", async () => {
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: {
      async generateStructured(request) {
        return {
          protocol: "dezin.resource-agent-result.v1",
          scope: request.scope,
          generator: { id: "claude" },
          output: researchDraft(),
        };
      },
    },
  });

  const result = await implementations.research!(input("research"));
  const bundle = JSON.parse(Buffer.from(result.bytes).toString("utf8")) as any;
  assert.deepEqual(bundle.sources.map((source: any) => source.verification), ["verified", "unverified", "unverified"]);
  assert.deepEqual(bundle.receipts.slice(1).map((receipt: any) => receipt.reason), [
    "retriever-unavailable",
    "retriever-unavailable",
  ]);
  assert.equal(bundle.findings.every((finding: any) => finding.evidenceStatus === "hypothesis"), true);
  assert.equal(bundle.findings.every((finding: any) => finding.confidence === "low"), true);
  assert.deepEqual(bundle.findings.map((finding: any) => finding.agentConfidence), ["high", "high", "medium"]);
  assert.equal(bundle.designPrinciples.every((principle: any) => principle.evidenceStatus === "hypothesis"), true);
  assert.equal(bundle.directions.every((direction: any) => direction.evidenceStatus === "hypothesis"), true);
  assert.equal(result.metadata.verifiedSourceCount, 1);
  assert.equal(result.metadata.unverifiedSourceCount, 2);
  assert.equal(result.metadata.hypothesisFindingCount, 3);
  assert.equal(result.metadata.qualityState, "needs-review");
  assert.equal(result.metadata.requiresHypothesisConfirmation, true);
  assert.equal(result.metadata.groundednessVerifierAvailable, false);
  assert.equal(result.metadata.evidenceDirectionCount, 0);
  assert.equal(result.metadata.hypothesisDirectionCount, 2);
  assert.deepEqual(result.evidence.quality, {
    state: "needs-review",
    requiresHypothesisConfirmation: true,
    groundednessVerifierAvailable: false,
    evidenceDirectionCount: 0,
    hypothesisDirectionCount: 2,
  });
});

test("Research keeps an exact but unrelated receipt excerpt as hypothesis when groundedness rejects it", async () => {
  const draft = researchDraft();
  draft.findings[0]!.statement = "The product must use a neon purple visual language.";
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: {
      async generateStructured(request) {
        return { protocol: "dezin.resource-agent-result.v1", scope: request.scope, generator: { id: "claude" }, output: draft };
      },
    },
    researchEvidence: verifiedResearchEvidence(),
    researchGroundedness: groundedResearchVerifier(false),
  });
  const result = await implementations.research!(input("research"));
  const bundle = JSON.parse(Buffer.from(result.bytes).toString("utf8")) as any;
  assert.equal(bundle.supportReceipts[0].verification, "verified");
  assert.equal(bundle.findings[0].evidenceStatus, "hypothesis");
  assert.equal(bundle.findings[0].confidence, "low");
  assert.equal(bundle.findings[0].groundedness.verified, false);
});

test("Research never promotes exact verified receipts without the independent groundedness verifier", async () => {
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: {
      async generateStructured(request) {
        return {
          protocol: "dezin.resource-agent-result.v1",
          scope: request.scope,
          generator: { id: "claude" },
          output: researchDraft(),
        };
      },
    },
    researchEvidence: verifiedResearchEvidence(),
  });
  const result = await implementations.research!(input("research"));
  const bundle = JSON.parse(Buffer.from(result.bytes).toString("utf8")) as any;
  assert.equal(bundle.receipts.every((receipt: any) => receipt.verification === "verified"), true);
  assert.equal(bundle.supportReceipts.every((receipt: any) => receipt.verification === "verified"), true);
  assert.equal(bundle.findings.every((finding: any) => finding.evidenceStatus === "hypothesis"), true);
  assert.equal(bundle.findings.every((finding: any) => finding.confidence === "low"), true);
  assert.equal(bundle.findings.every((finding: any) => finding.groundedness.verifier === null), true);
});

test("Research generation converts retrieval failures, excerpt mismatches, and substituted representations into unverified receipts", async () => {
  for (const [label, researchEvidence] of [
    ["fetch failure", { async retrieveWebEvidence() { throw new Error("network failed"); } }],
    ["excerpt mismatch", verifiedResearchEvidence({ bytes: Buffer.from("different page content", "utf8") })],
    ["source substitution", verifiedResearchEvidence({ sourceId: "source-substituted" })],
    ["requested URL substitution", verifiedResearchEvidence({ requestedUrl: "https://attacker.invalid/" })],
    ["canonical URL substitution", verifiedResearchEvidence({ finalUrl: "https://user:secret@example.com/" })],
    ["content substitution", verifiedResearchEvidence({
      bytes: Buffer.from(`${WEB_EXCERPT_1} only`, "utf8"),
      contentChecksum: "0".repeat(64),
    })],
  ] as const) {
    const implementations = createProductionResourceGenerationImplementations({
      contextPacks: { get: exactPackForId },
      agent: {
        async generateStructured(request) {
          return {
            protocol: "dezin.resource-agent-result.v1",
            scope: request.scope,
            generator: { id: "claude" },
            output: researchDraft(),
          };
        },
      },
      researchEvidence: researchEvidence as any,
    });

    const result = await implementations.research!(input("research"));
    const bundle = JSON.parse(Buffer.from(result.bytes).toString("utf8")) as any;
    assert.equal(bundle.sources[1].verification, "unverified", label);
    assert.equal(bundle.receipts[1].reason, "retrieval-failed", label);
    assert.equal(bundle.findings[1].evidenceStatus, "hypothesis", label);
    assert.equal(bundle.findings[1].confidence, "low", label);
  }
});

test("Research generation binds context and user evidence to one exact Context Pack item", async () => {
  const exact = researchDraft();
  exact.sources[0]!.kind = "user";
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: {
      async generateStructured(request) {
        return { protocol: "dezin.resource-agent-result.v1", scope: request.scope, generator: { id: "claude" }, output: exact };
      },
    },
  });
  const result = await implementations.research!(input("research"));
  const bundle = JSON.parse(Buffer.from(result.bytes).toString("utf8")) as any;
  assert.equal(bundle.receipts[0].sourceKind, "user");
  assert.equal(bundle.receipts[0].contextItemOrdinal, 0);
  assert.equal(bundle.receipts[0].contextItemChecksum, sha256(CONTEXT_CONTENT));

  for (const mutate of [
    (draft: ReturnType<typeof researchDraft>) => { draft.sources[0]!.binding!.itemOrdinal = 1; },
    (draft: ReturnType<typeof researchDraft>) => { draft.sources[0]!.binding!.itemChecksum = "d".repeat(64); },
    (draft: ReturnType<typeof researchDraft>) => { draft.sources[0]!.excerpt = "not present in the item"; },
  ]) {
    const substituted = researchDraft();
    mutate(substituted);
    const invalid = createProductionResourceGenerationImplementations({
      contextPacks: { get: exactPackForId },
      agent: {
        async generateStructured(request) {
          return { protocol: "dezin.resource-agent-result.v1", scope: request.scope, generator: { id: "claude" }, output: substituted };
        },
      },
    });
    await assert.rejects(
      () => invalid.research!(input("research")),
      (error: unknown) => error instanceof ProductionResourceGenerationError
        && error.code === "RESOURCE_GENERATOR_OUTPUT_INVALID",
    );
  }
});

test("Research evidence retrieval preserves the exact cancellation reason", async () => {
  const controller = new AbortController();
  const reason = new Error("stop trusted research retrieval");
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: {
      async generateStructured(request) {
        return { protocol: "dezin.resource-agent-result.v1", scope: request.scope, generator: { id: "claude" }, output: researchDraft() };
      },
    },
    researchEvidence: {
      async retrieveWebEvidence() {
        return await new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        });
      },
    } as any,
  });
  const execution = implementations.research!({ ...input("research"), signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(execution, (error: unknown) => error === reason);
});

test("Research generation rejects low-quality, untraceable output and substituted Context scope", async () => {
  let called = 0;
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: (_workspaceId, _id) => ({ ...pack(), target: { type: "resource", id: "other" } }) },
    agent: { async generateStructured() { called += 1; throw new Error("must not run"); } },
  });
  await assert.rejects(
    () => implementations.research!(input("research")),
    (error: unknown) => error instanceof ProductionResourceGenerationError
      && error.code === "RESOURCE_CONTEXT_PACK_SUBSTITUTED",
  );
  assert.equal(called, 0);

  const legacy = researchDraft();
  legacy.protocol = "dezin.research-generation.v2";
  const legacyImplementation = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: {
      async generateStructured(request) {
        return { protocol: "dezin.resource-agent-result.v1", scope: request.scope, generator: { id: "claude" }, output: legacy };
      },
    },
  });
  await assert.rejects(
    () => legacyImplementation.research!(input("research")),
    (error: unknown) => error instanceof ProductionResourceGenerationError
      && error.code === "RESOURCE_GENERATOR_OUTPUT_INVALID",
  );

  const bad = researchDraft();
  bad.findings[0]!.supports = [{ sourceId: "invented-source", quote: "invented support" }];
  const lowQuality = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: {
      async generateStructured(request) {
        return { protocol: "dezin.resource-agent-result.v1", scope: request.scope, generator: { id: "claude" }, output: bad };
      },
    },
  });
  await assert.rejects(
    () => lowQuality.research!(input("research")),
    (error: unknown) => error instanceof ProductionResourceGenerationError
      && error.code === "RESOURCE_GENERATOR_OUTPUT_INVALID",
  );
});

test("Research generation bounds the persisted receipt set below candidate-evidence limits", async () => {
  const unbounded = researchDraft();
  while (unbounded.sources.length < 65) {
    const index = unbounded.sources.length;
    unbounded.sources.push({
      ...unbounded.sources[0]!,
      id: `source-context-${index}`,
      title: `Context source ${index}`,
    });
  }
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: {
      async generateStructured(request) {
        return { protocol: "dezin.resource-agent-result.v1", scope: request.scope, generator: { id: "claude" }, output: unbounded };
      },
    },
  });

  await assert.rejects(
    () => implementations.research!(input("research")),
    (error: unknown) => error instanceof ProductionResourceGenerationError
      && error.code === "RESOURCE_GENERATOR_OUTPUT_INVALID",
  );
});

test("Moodboard Agent emits only Asset specs; daemon-generated reviewed PNGs own the immutable bundle", async () => {
  let agentRequest: ProductionResourceAgentRequest | undefined;
  let imageRequest: any;
  let qualityRequest: any;
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: {
      async generateStructured(request) {
        agentRequest = request;
        return { protocol: "dezin.resource-agent-result.v1", scope: request.scope, generator: { id: "claude" }, output: moodboardDraft() };
      },
    },
    moodboardImages: {
      async generateImage(request) {
        imageRequest = request;
        const profile = request.executionProfile.imageGeneration!;
        return {
          protocol: "dezin.moodboard-image-result.v1", scope: request.scope, assetId: request.asset.id,
          generator: { providerId: profile.providerId, model: profile.model, baseUrl: profile.baseUrl, apiVersion: profile.apiVersion },
          mimeType: "image/png", bytes: MOODBOARD_PNG,
        };
      },
    },
    moodboardQuality: {
      async reviewImage(request) {
        qualityRequest = request;
        return {
          protocol: "dezin.moodboard-quality-result.v1", scope: request.scope, assetId: request.asset.id,
          checksum: request.image.checksum, decision: "pass", semanticMatch: true, visualQuality: "pass", findings: [],
        };
      },
    },
  });
  const result = await implementations.moodboard!(input("moodboard"));
  const bundle = JSON.parse(Buffer.from(result.bytes).toString("utf8")) as any;
  assert.equal(bundle.format, "dezin-moodboard-resource-bundle");
  assert.equal(bundle.version, 2);
  assert.equal(bundle.assets.length, 1);
  assert.equal(Buffer.from(bundle.assets[0].bytesBase64, "base64").equals(MOODBOARD_PNG), true);
  assert.equal(bundle.assets[0].metadata.width, 512);
  assert.equal(bundle.assets[0].metadata.height, 512);
  assert.deepEqual(result.evidence.assetChecksums, [{ id: "asset-1", checksum: sha256(MOODBOARD_PNG) }]);
  assert.deepEqual(result.evidence.qualityReviews, [{
    id: "asset-1", checksum: sha256(MOODBOARD_PNG), decision: "pass", semanticMatch: true, visualQuality: "pass",
  }]);
  assert.match(agentRequest!.systemPrompt, /Never return pixels/i);
  assert.doesNotMatch(`${agentRequest!.systemPrompt}\n${agentRequest!.message}`, /bytesBase64|canonical base64/i);
  assert.equal(imageRequest.protocol, "dezin.moodboard-image-request.v1");
  assert.equal(imageRequest.scope.attempt, 2);
  assert.equal(imageRequest.asset.prompt, moodboardDraft().assetSpecs[0]!.prompt);
  assert.equal(qualityRequest.image.checksum, sha256(MOODBOARD_PNG));
});

test("Moodboard publication rejects 1x1, malformed, scope-substituted, and independently failed images", async () => {
  for (const [label, implementation, code] of [
    ["1x1", moodboardImplementation(moodboardDraft(), PNG), "RESOURCE_GENERATOR_OUTPUT_INVALID"],
    ["truncated", moodboardImplementation(moodboardDraft(), MOODBOARD_PNG.subarray(0, 32)), "RESOURCE_GENERATOR_OUTPUT_INVALID"],
    ["review fail", moodboardImplementation(moodboardDraft(), MOODBOARD_PNG, "fail"), "RESOURCE_QUALITY_REVIEW_FAILED"],
  ] as const) {
    await assert.rejects(
      () => implementation.moodboard!(input("moodboard")),
      (error: unknown) => error instanceof ProductionResourceGenerationError && error.code === code,
      label,
    );
  }

  const draft = moodboardDraft();
  draft.assetSpecs[0]!.fileName = "pixels.jpg";
  await assert.rejects(
    () => moodboardImplementation(draft).moodboard!(input("moodboard")),
    (error: unknown) => error instanceof ProductionResourceGenerationError
      && error.code === "RESOURCE_GENERATOR_OUTPUT_INVALID",
  );
});

test("Moodboard fails before the Agent turn when the frozen image provider is not configured", async () => {
  const disabledPack = pack("resource-1", "moodboard", false);
  let agentCalls = 0;
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: (_workspaceId, id) => id === disabledPack.id ? disabledPack : null },
    agent: {
      async generateStructured(request) {
        agentCalls += 1;
        return {
          protocol: "dezin.resource-agent-result.v1",
          scope: request.scope,
          generator: { id: "claude" },
          output: moodboardDraft(),
        };
      },
    },
    moodboardImages: { async generateImage() { return assert.fail("image provider must not run"); } },
    moodboardQuality: { async reviewImage() { return assert.fail("quality reviewer must not run"); } },
  });
  await assert.rejects(
    () => implementations.moodboard!({ ...input("moodboard"), contextPackId: disabledPack.id }),
    (error: unknown) => error instanceof ProductionResourceGenerationError
      && error.code === "RESOURCE_GENERATOR_CONFIGURATION_INVALID",
  );
  assert.equal(agentCalls, 0);
});

test("Sharingan generation accepts only an exact scoped capture export and produces a self-contained bundle", async () => {
  const exportRequests: ProductionSharinganCaptureExportRequest[] = [];
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: { async generateStructured() { throw new Error("not used"); } },
    sharinganCaptures: {
      async exportExactCapture(request) {
        exportRequests.push(request);
        return {
          protocol: "dezin.sharingan-capture-export.v1",
          scope: request.scope,
          exporter: { id: "dezin-sharingan-capture", version: 1 },
          source: { requestedUrl: "https://example.com/", finalUrl: "https://example.com/", capturedAt: 42 },
          files: captureFiles(),
        };
      },
    },
  });
  const result = await implementations["sharingan-capture"]!(input("sharingan-capture"));
  const bundle = JSON.parse(Buffer.from(result.bytes).toString("utf8")) as any;
  assert.equal(bundle.protocol, "dezin.sharingan-capture-resource-bundle.v2");
  assert.equal(result.metadata.version, 2);
  assert.deepEqual(bundle.roots, [".sharingan", "public/_assets"]);
  assert.equal(bundle.files.length, 8);
  assert.equal(bundle.files[0].path, ".sharingan/entry/assets.json");
  assert.ok(bundle.files.some((file: any) => file.path === ".sharingan/probe.mjs"));
  assert.ok(bundle.files.some((file: any) => file.path === "public/_assets/source.png"));
  assert.equal(result.provenance.exporterId, "dezin-sharingan-capture");
  assert.equal(result.evidence.bundleFileCount, 8);
  assert.deepEqual(result.evidence.semanticReceipt, {
    protocol: "dezin.sharingan-capture-semantic-receipt.v1",
    pageCount: 1,
    screenshotCount: 1,
    viewportCount: 1,
  });
  assert.equal(exportRequests[0]!.scope.contextPackId, pack("resource-1", "sharingan-capture").id);
  assert.equal(
    exportRequests[0]!.executionProfile.sharingan?.bundleProtocol,
    "dezin.sharingan-capture-resource-bundle.v2",
  );

  const substituted = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: { async generateStructured() { throw new Error("not used"); } },
    sharinganCaptures: {
      async exportExactCapture(request) {
        return {
          protocol: "dezin.sharingan-capture-export.v1",
          scope: { ...request.scope, resourceId: "newest-live-capture" },
          exporter: { id: "bad", version: 1 },
          source: { requestedUrl: "https://example.com/", finalUrl: "https://example.com/", capturedAt: 42 },
          files: captureFiles(),
        };
      },
    },
  });
  await assert.rejects(
    () => substituted["sharingan-capture"]!(input("sharingan-capture")),
    (error: unknown) => error instanceof ProductionResourceGenerationError
      && error.code === "SHARINGAN_CAPTURE_EXPORT_SUBSTITUTED",
  );
});

test("Sharingan generation rejects fake pixels, empty measured evidence, and viewport substitution before publication", async () => {
  const cases = [
    captureFiles("fake-png", { screenshotBytes: Buffer.from("not a PNG") }),
    captureFiles("fake-local-png", { assetBytes: Buffer.from("not a local PNG") }),
    captureFiles("empty-dom", { dom: [] }),
    captureFiles("empty-styles", { styles: { colors: [], fontFamilies: [], fontSizes: [], radii: [], shadows: [] } }),
    captureFiles("empty-render-map", { renderMap: {} }),
    captureFiles("viewport-mismatch", {
      renderMap: {
        viewport: { width: 1280, height: 720 },
        document: { width: 1280, height: 1800 },
        elements: [{ selector: "body", tag: "body", box: { x: 0, y: 0, w: 1280, h: 1800 }, style: { display: "block" } }],
      },
    }),
  ];
  for (const files of cases) {
    const implementation = createProductionResourceGenerationImplementations({
      contextPacks: { get: exactPackForId },
      agent: { async generateStructured() { throw new Error("not used"); } },
      sharinganCaptures: {
        async exportExactCapture(request) {
          return {
            protocol: "dezin.sharingan-capture-export.v1",
            scope: request.scope,
            exporter: { id: "dezin-sharingan-capture", version: 1 },
            source: { requestedUrl: "https://example.com/", finalUrl: "https://example.com/", capturedAt: 42 },
            files,
          };
        },
      },
    });
    await assert.rejects(
      () => implementation["sharingan-capture"]!(input("sharingan-capture")),
      (error: unknown) => error instanceof ProductionResourceGenerationError
        && error.code === "SHARINGAN_CAPTURE_EXPORT_INVALID",
    );
  }
});

test("Sharingan generation validates and packages one immutable export byte snapshot", async () => {
  const files = captureFiles("mutating-export") as Array<{
    path: string;
    bytes: Uint8Array;
    checksum: string;
  }>;
  const originalScreenshotChecksum = files.find((file) => file.path.endsWith("/shot.png"))!.checksum;
  const implementation = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: { async generateStructured() { throw new Error("not used"); } },
    sharinganCaptures: {
      async exportExactCapture(request) {
        setImmediate(() => {
          const screenshot = files.find((file) => file.path.endsWith("/shot.png"))!;
          screenshot.bytes = Buffer.from("post-validation fake pixels");
          screenshot.checksum = sha256(screenshot.bytes);
        });
        return {
          protocol: "dezin.sharingan-capture-export.v1",
          scope: request.scope,
          exporter: { id: "dezin-sharingan-capture", version: 1 },
          source: { requestedUrl: "https://example.com/", finalUrl: "https://example.com/", capturedAt: 42 },
          files,
        };
      },
    },
  });
  const result = await implementation["sharingan-capture"]!(input("sharingan-capture"));
  const decoded = decodeSharinganCaptureResourceBundle(result.bytes);
  const screenshot = decoded.files.find((file) => file.path.endsWith("/shot.png"))!;
  assert.equal(screenshot.checksum, originalScreenshotChecksum);
  assert.notEqual(Buffer.from(screenshot.bytes).toString("utf8"), "post-validation fake pixels");
});

test("Kinds without honest generation semantics fail closed with a typed design error", async () => {
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: { async generateStructured() { throw new Error("not used"); } },
  });
  for (const kind of ["file", "asset", "effect", "external-reference"] as const) {
    await assert.rejects(
      () => implementations[kind]!(input(kind)),
      (error: unknown) => error instanceof ProductionResourceGenerationError
        && error.code === "RESOURCE_KIND_REQUIRES_OWNED_SOURCE"
        && error.failureClass === "design",
    );
  }
  await assert.rejects(
    () => implementations["sharingan-capture"]!(input("sharingan-capture")),
    (error: unknown) => error instanceof ProductionResourceGenerationError
      && error.code === "SHARINGAN_CAPTURE_EXPORT_UNAVAILABLE",
  );
});

test("Abort wins over a late structured Agent result", async () => {
  const controller = new AbortController();
  let finish!: (value: any) => void;
  const late = new Promise<any>((resolve) => { finish = resolve; });
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: { get: exactPackForId },
    agent: { generateStructured: async () => late },
  });
  const execution = implementations.research!({ ...input("research"), signal: controller.signal });
  const reason = new Error("stop exact resource generation");
  controller.abort(reason);
  await assert.rejects(execution, (error: unknown) => error === reason);
  finish({ protocol: "dezin.resource-agent-result.v1", scope: {}, generator: { id: "claude" }, output: researchDraft() });
});
