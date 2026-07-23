import { createHash } from "node:crypto";

import type { Store } from "../../../../packages/core/src/index.ts";
import {
  checksumBytes,
  estimateContextTokens,
  stableStringify,
  type ContextPack,
} from "../../src/context/context-types.ts";
import {
  ContextPackStore,
  createWorkspaceContextPackRepository,
} from "../../src/context/context-pack-store.ts";

const checksum = (value: string): string => createHash("sha256").update(value).digest("hex");

function receipt(prefix: "research-evidence" | "research-support", payload: Record<string, unknown>) {
  const digest = checksum(stableStringify(payload));
  return { ...payload, id: `${prefix}-${digest}`, checksum: digest };
}

export function createResearchRevisionFixture(input: {
  workspaceId: string;
  resourceId: string;
  parentRevisionId?: string | null;
  verifiedLocator?: string;
  contextPack?: Pick<ContextPack, "id" | "hash" | "graphRevision">;
}) {
  const taskId = "task-research-fixture";
  const planId = "plan-research-fixture";
  const inputHash = "a".repeat(64);
  const contextPackId = input.contextPack?.id ?? "context-research-fixture";
  const contextPackHash = input.contextPack?.hash ?? "b".repeat(64);
  const contextPackGraphRevision = input.contextPack?.graphRevision ?? 1;
  const verifiedLocator = input.verifiedLocator ?? "https://example.test/checkout-study";
  const verifiedExcerpt = "Participants compared delivery and total cost before committing.";
  const unverifiedExcerpt = "One participant may prefer a more expressive confirmation moment.";
  const verifier = { id: "verifier-one", model: "test-verifier" };
  const verifiedReceipt = receipt("research-evidence", {
    protocol: "dezin.research-evidence-receipt.v1",
    sourceId: "source-study",
    sourceKind: "web",
    verification: "verified",
    requestedUrl: verifiedLocator,
    canonicalUrl: verifiedLocator,
    retrievedAt: 1,
    status: 200,
    mimeType: "text/html",
    contentChecksum: checksum(verifiedExcerpt),
    excerpt: { text: verifiedExcerpt, utf8Start: 0, utf8End: Buffer.byteLength(verifiedExcerpt, "utf8") },
  });
  const unverifiedReceipt = receipt("research-evidence", {
    protocol: "dezin.research-evidence-receipt.v1",
    sourceId: "source-interview",
    sourceKind: "web",
    verification: "unverified",
    requestedUrl: "https://example.test/interview-note-7",
    reason: "retriever-unavailable",
    excerpt: { text: unverifiedExcerpt },
  });
  const findingInputs = [
    {
      id: "finding-comparison",
      statement: "People compare delivery timing and final cost before payment.",
      implication: "Keep both values persistent beside the primary action.",
      confidence: "high" as const,
      agentConfidence: "high" as const,
      sourceId: "source-study",
      sourceReceiptId: verifiedReceipt.id,
      quote: verifiedExcerpt,
      verification: "verified" as const,
      evidenceStatus: "evidence" as const,
    },
    {
      id: "finding-celebration",
      statement: "A more expressive confirmation may increase perceived reward.",
      implication: "Explore celebration carefully without delaying completion.",
      confidence: "low" as const,
      agentConfidence: "medium" as const,
      sourceId: "source-interview",
      sourceReceiptId: unverifiedReceipt.id,
      quote: unverifiedExcerpt,
      verification: "unverified" as const,
      evidenceStatus: "hypothesis" as const,
    },
    {
      id: "finding-summary",
      statement: "A persistent order summary reduces comparison effort.",
      implication: "Keep the summary visible through commitment.",
      confidence: "medium" as const,
      agentConfidence: "medium" as const,
      sourceId: "source-study",
      sourceReceiptId: verifiedReceipt.id,
      quote: "delivery and total cost",
      verification: "verified" as const,
      evidenceStatus: "evidence" as const,
    },
  ];
  const supportReceipts = findingInputs.map((finding) => {
    const start = finding.verification === "verified"
      ? Buffer.byteLength(verifiedExcerpt.slice(0, verifiedExcerpt.indexOf(finding.quote)), "utf8")
      : null;
    return receipt("research-support", {
      protocol: "dezin.research-support-receipt.v1",
      findingId: finding.id,
      statementChecksum: checksum(finding.statement),
      sourceId: finding.sourceId,
      sourceReceiptId: finding.sourceReceiptId,
      verification: finding.verification,
      ...(start === null
        ? {
            quote: { text: finding.quote },
            reason: "quote-not-bound-to-verified-source-excerpt",
          }
        : {
            quote: {
              text: finding.quote,
              utf8Start: start,
              utf8End: start + Buffer.byteLength(finding.quote, "utf8"),
            },
          }),
    });
  });
  const findings = findingInputs.map((finding, index) => {
    const supportReceipt = supportReceipts[index]!;
    const evidence = finding.evidenceStatus === "evidence";
    return {
      id: finding.id,
      statement: finding.statement,
      implication: finding.implication,
      confidence: finding.confidence,
      agentConfidence: finding.agentConfidence,
      evidenceStatus: finding.evidenceStatus,
      sourceIds: [finding.sourceId],
      verifiedSourceIds: finding.verification === "verified" ? [finding.sourceId] : [],
      unverifiedSourceIds: finding.verification === "unverified" ? [finding.sourceId] : [],
      supportReceiptIds: [supportReceipt.id],
      groundedness: {
        verified: evidence,
        verifier,
        rationale: evidence
          ? "The independently verified source support directly binds this claim."
          : "The claim remains an explicitly unverified hypothesis.",
        supportReceiptIds: evidence ? [supportReceipt.id] : [],
      },
    };
  });
  const designPrinciples = [
    {
      id: "principle-visible-total",
      title: "Keep the decision total visible",
      rationale: "Persistent totals reduce comparison effort at commitment.",
      findingIds: ["finding-comparison"],
      evidenceStatus: "evidence",
      evidenceFindingIds: ["finding-comparison"],
      hypothesisFindingIds: [],
    },
    {
      id: "principle-stable-summary",
      title: "Keep the summary stable",
      rationale: "A stable summary preserves context through commitment.",
      findingIds: ["finding-summary"],
      evidenceStatus: "evidence",
      evidenceFindingIds: ["finding-summary"],
      hypothesisFindingIds: [],
    },
    {
      id: "principle-test-celebration",
      title: "Test celebration separately",
      rationale: "The expressive idea is useful but remains hypothetical.",
      findingIds: ["finding-celebration"],
      evidenceStatus: "hypothesis",
      evidenceFindingIds: [],
      hypothesisFindingIds: ["finding-celebration"],
    },
  ];
  const directions = [
    {
      id: "quiet-confidence",
      title: "Quiet confidence",
      thesis: "Use restrained editorial hierarchy and a persistent order rail.",
      visualLanguage: ["warm neutrals", "precise hierarchy"],
      interactionPrinciples: ["keep totals persistent"],
      risks: ["Restraint can hide urgency"],
      findingIds: ["finding-comparison", "finding-summary"],
      evidenceStatus: "evidence",
      evidenceFindingIds: ["finding-comparison", "finding-summary"],
      hypothesisFindingIds: [],
    },
    {
      id: "expressive-confirmation",
      title: "Expressive confirmation",
      thesis: "Make completion feel rewarding with a richer confirmation beat.",
      visualLanguage: ["bold success color", "kinetic confirmation"],
      interactionPrinciples: ["celebrate after commitment"],
      risks: ["Celebration may distract from the receipt"],
      findingIds: ["finding-celebration"],
      evidenceStatus: "hypothesis",
      evidenceFindingIds: [],
      hypothesisFindingIds: ["finding-celebration"],
    },
  ];
  const scope = {
    taskId,
    planId,
    attempt: 1,
    inputHash,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    parentRevisionId: input.parentRevisionId ?? null,
    contextPackId,
    operation: (input.parentRevisionId ?? null) === null ? "create" as const : "revise" as const,
    nodeId: "node-research-fixture",
    title: "Checkout decision research",
    resourceKind: "research" as const,
  };
  const receipts = [verifiedReceipt, unverifiedReceipt];
  const bundle = {
    format: "dezin-research-resource-bundle",
    version: 3,
    scope,
    contextPack: { id: contextPackId, hash: contextPackHash, graphRevision: contextPackGraphRevision },
    brief: {
      proposalRationale: "Ground the checkout direction in immutable evidence.",
      assumptions: [],
      targetInstructions: { operation: scope.operation, kind: "research", title: scope.title },
    },
    executiveSummary: "Checkout confidence should be quiet, explicit, and easy to verify.",
    sources: [
      {
        id: "source-study",
        kind: "web",
        title: "Checkout usability study",
        locator: verifiedLocator,
        excerpt: verifiedExcerpt,
        binding: null,
        notes: "",
        verification: "verified",
        receiptId: verifiedReceipt.id,
      },
      {
        id: "source-interview",
        kind: "web",
        title: "Unverified interview note",
        locator: "https://example.test/interview-note-7",
        excerpt: unverifiedExcerpt,
        binding: null,
        notes: "Needs a broader sample.",
        verification: "unverified",
        receiptId: unverifiedReceipt.id,
      },
    ],
    receipts,
    supportReceipts,
    findings,
    designPrinciples,
    directions,
    openQuestions: ["Does expressive confirmation hold across a broader sample?"],
  };
  const adapterMetadata = {
    format: bundle.format,
    version: bundle.version,
    qualityState: "grounded",
    requiresHypothesisConfirmation: true,
    groundednessVerifierAvailable: true,
    sourceCount: 2,
    verifiedSourceCount: 1,
    unverifiedSourceCount: 1,
    supportReceiptCount: 3,
    findingCount: 3,
    evidenceFindingCount: 2,
    hypothesisFindingCount: 1,
    principleCount: 3,
    directionCount: 2,
    evidenceDirectionCount: 1,
    hypothesisDirectionCount: 1,
  };
  const adapterProvenance = {
    protocol: "dezin.production-resource-generation.v1",
    taskId,
    attempt: 1,
    inputHash,
    contextPackId,
    contextPackHash,
    generatorId: "test-generator",
    model: "test-model",
    researchEvidence: {
      protocol: "dezin.research-evidence-provenance.v2",
      verifiedSourceCount: 1,
      unverifiedSourceCount: 1,
      evidenceFindingCount: 2,
      hypothesisFindingCount: 1,
      receiptIds: receipts.map((item) => item.id),
      supportReceiptIds: supportReceipts.map((item) => item.id),
      groundednessVerifier: verifier,
    },
  };
  return {
    bundle,
    metadata: { adapter: adapterMetadata },
    provenance: {
      kind: "generation-task-resource",
      planId,
      taskId,
      attempt: 1,
      inputHash,
      adapter: { id: "dezin.resource-adapter.research", version: 1, kind: "research" },
      adapterProvenance,
    },
  };
}

export function persistResearchRevisionFixtureContextPack(input: {
  store: Store;
  manifestRoot: string;
  workspaceId: string;
  resourceId: string;
  graphRevision: number;
}): ContextPack {
  const systemContent = "Research fixture system Kernel";
  const targetContent = "Generate the exact Research Resource fixture";
  const tokenEstimate = estimateContextTokens(systemContent) + estimateContextTokens(targetContent);
  const repository = createWorkspaceContextPackRepository(input.store.workspace, {
    manifestRoot: input.manifestRoot,
  });
  return new ContextPackStore({ manifestRoot: input.manifestRoot, repository }).persist({
    workspaceId: input.workspaceId,
    graphRevision: input.graphRevision,
    target: { type: "resource", id: input.resourceId },
    intent: "generate",
    messageChecksum: checksumBytes("Research fixture Context Pack"),
    items: [
      {
        ordinal: 0,
        contextClass: "system-kernel",
        ref: { kind: "inline", id: "research-fixture-system-kernel" },
        resolvedKind: "inline",
        content: systemContent,
        checksum: checksumBytes(systemContent),
        reason: "Fixture system Kernel",
        trustLevel: "system",
        boundary: { source: "system-kernel:research-fixture", readOnly: true, mayGrantCapabilities: false },
        capabilities: [],
        tokenEstimate: estimateContextTokens(systemContent),
        provenance: { protocol: "dezin.research-fixture-context.v1" },
        provided: true,
      },
      {
        ordinal: 1,
        contextClass: "target",
        ref: { kind: "inline", id: input.resourceId },
        resolvedKind: "inline",
        content: targetContent,
        checksum: checksumBytes(targetContent),
        reason: "Fixture Research target",
        trustLevel: "trusted",
        boundary: { source: "generation-task:research-fixture", readOnly: true, mayGrantCapabilities: false },
        capabilities: [],
        tokenEstimate: estimateContextTokens(targetContent),
        provenance: { protocol: "dezin.research-fixture-context.v1" },
        provided: true,
      },
    ],
    omissions: [],
    tokenEstimate,
  });
}
