import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  stableStringify,
  type ContextPack,
} from "../src/context/context-types.ts";
import {
  ResearchResourceRevisionError,
  selectResearchRevisionDirection,
} from "../src/research-resource-revision.ts";
import { createResearchRevisionFixture } from "./support/research-resource-fixture.ts";

const WORKSPACE_ID = "workspace-research-selector";
const RESOURCE_ID = "resource-research-selector";
const CONTEXT_PACK = {
  id: "context-research-selector",
  workspaceId: WORKSPACE_ID,
  hash: "b".repeat(64),
  graphRevision: 1,
  target: { type: "resource", id: RESOURCE_ID },
  intent: "generate",
  messageChecksum: "c".repeat(64),
  items: [],
  omissions: [],
  tokenEstimate: 0,
} as unknown as ContextPack;

type Fixture = ReturnType<typeof createResearchRevisionFixture>;
type BindingReason = "binding-unavailable" | "binding-rejected" | "binding-invalid";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalReceipt(
  prefix: "research-evidence" | "research-support",
  payload: Record<string, unknown>,
): Record<string, unknown> & { id: string; checksum: string } {
  const digest = sha256(stableStringify(payload));
  return { ...payload, id: `${prefix}-${digest}`, checksum: digest };
}

function fixture(): Fixture {
  const value = createResearchRevisionFixture({
    workspaceId: WORKSPACE_ID,
    resourceId: RESOURCE_ID,
    contextPack: CONTEXT_PACK,
  });
  const receipts = value.bundle.receipts as any[];
  const supportReceipts = value.bundle.supportReceipts as any[];
  const source = value.bundle.sources.find((candidate) => candidate.id === "source-study");
  const receiptIndex = receipts.findIndex(
    (candidate) => candidate.sourceId === "source-study",
  );
  assert.ok(source);
  assert.ok(receiptIndex >= 0);
  const canonicalText = source.excerpt;
  const sourceBytes = Buffer.from(`<main>${canonicalText}</main>`, "utf8");
  const canonicalBytes = Buffer.from(canonicalText, "utf8");
  const upgradedReceipt = canonicalReceipt("research-evidence", {
    protocol: "dezin.research-evidence-receipt.v2",
    sourceId: source.id,
    sourceKind: "web",
    verification: "verified",
    requestedUrl: source.locator,
    canonicalUrl: source.locator,
    retrievedAt: 1,
    status: 200,
    source: {
      mimeType: "text/html",
      byteLength: sourceBytes.byteLength,
      checksum: sha256(sourceBytes.toString("utf8")),
    },
    canonicalText: {
      mimeType: "text/plain; charset=utf-8",
      byteLength: canonicalBytes.byteLength,
      checksum: sha256(canonicalText),
      extractor: { id: "dezin.html-visible-text", version: 1 },
    },
    excerpt: {
      text: canonicalText,
      utf8Start: 0,
      utf8End: canonicalBytes.byteLength,
    },
  });
  receipts[receiptIndex] = upgradedReceipt;
  source.receiptId = upgradedReceipt.id;

  for (const [supportIndex, oldSupport] of supportReceipts.entries()) {
    if (oldSupport.sourceId !== source.id) continue;
    const {
      id: _oldSupportId,
      checksum: _oldSupportChecksum,
      quote: _oldQuote,
      ...oldSupportPayload
    } = oldSupport;
    const upgradedSupport = canonicalReceipt("research-support", {
      ...oldSupportPayload,
      sourceReceiptId: upgradedReceipt.id,
      verification: "verified",
      quote: {
        text: canonicalText,
        utf8Start: 0,
        utf8End: canonicalBytes.byteLength,
      },
    });
    supportReceipts[supportIndex] = upgradedSupport;
    const finding = value.bundle.findings.find(
      (candidate) => candidate.id === oldSupport.findingId,
    );
    assert.ok(finding);
    finding.supportReceiptIds = finding.supportReceiptIds.map((receiptId) =>
      receiptId === oldSupport.id ? upgradedSupport.id : receiptId);
    finding.groundedness.supportReceiptIds = finding.groundedness.supportReceiptIds.map(
      (receiptId) => receiptId === oldSupport.id ? upgradedSupport.id : receiptId,
    );
  }
  value.provenance.adapterProvenance.researchEvidence.receiptIds =
    receipts.map((candidate) => candidate.id);
  value.provenance.adapterProvenance.researchEvidence.supportReceiptIds =
    supportReceipts.map((candidate) => candidate.id);
  enableDecisionGradeGate(value);
  return value;
}

function verifiedSelectorSpanId(value: Fixture, sourceId: string, text: string): string {
  const receipt = (value.bundle.receipts as any[]).find(
    (candidate) => candidate.sourceId === sourceId,
  );
  assert.equal(receipt?.protocol, "dezin.research-evidence-receipt.v2");
  return `research-evidence-span-${sha256(stableStringify({
    protocol: "dezin.research-evidence-span.v1",
    scope: value.bundle.scope,
    sourceId,
    requestedUrl: receipt.requestedUrl,
    canonicalUrl: receipt.canonicalUrl,
    canonicalTextChecksum: receipt.canonicalText.checksum,
    utf8Start: receipt.excerpt.utf8Start,
    utf8End: receipt.excerpt.utf8End,
    textChecksum: sha256(text),
  }))}`;
}

function selectorAuthority(
  value: Fixture,
  selectedSpanIds: readonly (string | null)[] | undefined = undefined,
  sourceId = "source-study",
  queries: {
    findingId: string;
    supportIndex: number;
    statement: string;
  }[] = [
    {
      findingId: "finding-comparison",
      supportIndex: 0,
      statement: "People compare delivery timing and final cost before payment.",
    },
    {
      findingId: "finding-summary",
      supportIndex: 0,
      statement: "A persistent order summary reduces comparison effort.",
    },
  ],
) {
  const protocol = "dezin.research-evidence-span-catalog.v1" as const;
  const primarySpanText =
    "Participants compared delivery and total cost before committing.";
  const primarySpanId = sourceId === "source-study"
    ? verifiedSelectorSpanId(value, sourceId, primarySpanText)
    : `research-evidence-span-${"1".repeat(64)}`;
  const effectiveSelectedSpanIds = selectedSpanIds ?? [primarySpanId, primarySpanId];
  const spans = [
    {
      spanId: primarySpanId,
      text: primarySpanText,
    },
    {
      spanId: `research-evidence-span-${"2".repeat(64)}`,
      text: "A second bounded passage must never be mixed into the same source selection.",
    },
  ];
  const sources = [{
    sourceId,
    queries,
    spans,
  }];
  const catalogHash = sha256(stableStringify({
    protocol,
    scope: value.bundle.scope,
    sources,
  }));
  return {
    id: "verifier-one",
    model: "test-verifier",
    catalogHash,
    catalog: {
      protocol,
      catalogHash,
      sources,
    },
    decisions: sources[0]!.queries.map((query, index) => ({
      findingId: query.findingId,
      supportIndex: query.supportIndex,
      sourceId: sources[0]!.sourceId,
      selectedSpanId: effectiveSelectedSpanIds[index] ?? null,
    })),
  };
}

function rehashSelectorAuthority(
  value: Fixture,
  authority: ReturnType<typeof selectorAuthority>,
): void {
  const catalogHash = sha256(stableStringify({
    protocol: authority.catalog.protocol,
    scope: value.bundle.scope,
    sources: authority.catalog.sources,
  }));
  authority.catalogHash = catalogHash;
  authority.catalog.catalogHash = catalogHash;
}

function interviewSelectorAuthority(
  value: Fixture,
  selectedSpanId: string | null,
) {
  return selectorAuthority(
    value,
    [selectedSpanId],
    "source-interview",
    [{
      findingId: "finding-celebration",
      supportIndex: 0,
      statement: "A more expressive confirmation may increase perceived reward.",
    }],
  );
}

function writeV3Provenance(
  value: Fixture,
  evidenceSelector: ReturnType<typeof selectorAuthority> | null,
): void {
  Object.assign(value.provenance.adapterProvenance.researchEvidence, {
    protocol: "dezin.research-evidence-provenance.v3",
    evidenceSelector,
  });
}

function enableDecisionGradeGate(value: Fixture): void {
  Object.assign(value.metadata.adapter, {
    qualityState: "needs-review",
    decisionGradeGate: {
      protocol: "dezin.research-decision-grade-gate.v2",
      criteria: {
        minimumVerifiedWebSourceCount: 2,
        minimumEvidenceFindingCount: 2,
        minimumEvidenceDirectionCount: 1,
        requiresGroundednessVerifier: true,
      },
      observed: {
        verifiedWebSourceCount: 1,
        evidenceFindingCount: 2,
        evidenceDirectionCount: 0,
        groundednessVerifierAvailable: true,
      },
      accepted: false,
      blockers: [
        "insufficient-verified-web-sources",
        "insufficient-evidence-directions",
      ],
    },
  });
}

function setBindingFailureReason(
  value: Fixture,
  reason: BindingReason,
  sourceId = "source-interview",
  findingId = "finding-celebration",
): void {
  const source = value.bundle.sources.find((candidate) => candidate.id === sourceId);
  const finding = value.bundle.findings.find(
    (candidate) => candidate.id === findingId,
  );
  assert.ok(source);
  assert.ok(finding);
  const receiptIndex = value.bundle.receipts.findIndex(
    (candidate) => candidate.id === source.receiptId,
  );
  const supportIndex = value.bundle.supportReceipts.findIndex(
    (candidate) => finding.supportReceiptIds.includes(candidate.id),
  );
  assert.ok(receiptIndex >= 0);
  assert.ok(supportIndex >= 0);

  const {
    id: _oldReceiptId,
    checksum: _oldReceiptChecksum,
    ...oldReceiptPayload
  } = value.bundle.receipts[receiptIndex]!;
  const newReceipt = canonicalReceipt("research-evidence", {
    ...oldReceiptPayload,
    protocol: "dezin.research-evidence-receipt.v2",
    reason,
  });
  value.bundle.receipts[receiptIndex] = newReceipt as typeof value.bundle.receipts[number];
  source.receiptId = newReceipt.id;

  const {
    id: _oldSupportId,
    checksum: _oldSupportChecksum,
    ...oldSupportPayload
  } = value.bundle.supportReceipts[supportIndex]!;
  const newSupport = canonicalReceipt("research-support", {
    ...oldSupportPayload,
    sourceReceiptId: newReceipt.id,
  });
  value.bundle.supportReceipts[supportIndex] =
    newSupport as typeof value.bundle.supportReceipts[number];
  finding.supportReceiptIds = [newSupport.id];

  value.provenance.adapterProvenance.researchEvidence.receiptIds =
    value.bundle.receipts.map((candidate) => candidate.id);
  value.provenance.adapterProvenance.researchEvidence.supportReceiptIds =
    value.bundle.supportReceipts.map((candidate) => candidate.id);
  enableDecisionGradeGate(value);
}

function select(value: Fixture) {
  return selectResearchRevisionDirection({
    bytes: Buffer.from(stableStringify(value.bundle), "utf8"),
    directionId: "quiet-confidence",
    workspaceId: WORKSPACE_ID,
    resourceId: RESOURCE_ID,
    parentRevisionId: null,
    revisionMetadata: value.metadata,
    revisionProvenance: value.provenance,
    contextPack: CONTEXT_PACK,
  });
}

test("Research decoder accepts exact v3 selector provenance and preserves exact v2 compatibility", () => {
  const selected = fixture();
  writeV3Provenance(selected, selectorAuthority(selected));
  assert.equal(select(selected).id, "quiet-confidence");

  const unused = fixture();
  writeV3Provenance(unused, null);
  assert.equal(select(unused).id, "quiet-confidence");

  assert.equal(select(fixture()).id, "quiet-confidence");
});

test("Research decoder keeps v2 and v3 evidence provenance field sets exact", () => {
  const v2Extra = fixture();
  Object.assign(v2Extra.provenance.adapterProvenance.researchEvidence, {
    evidenceSelector: null,
  });

  const v3Missing = fixture();
  v3Missing.provenance.adapterProvenance.researchEvidence.protocol =
    "dezin.research-evidence-provenance.v3";

  const malformedSelector = fixture();
  writeV3Provenance(malformedSelector, {
    ...selectorAuthority(malformedSelector),
    catalogHash: "d".repeat(63),
  });

  for (const { name, value } of [
    { name: "v2 extra selector field", value: v2Extra },
    { name: "v3 missing selector field", value: v3Missing },
    { name: "v3 malformed selector hash", value: malformedSelector },
  ]) {
    assert.throws(
      () => select(value),
      (error: unknown) => error instanceof ResearchResourceRevisionError
        && /evidence provenance|selector/i.test(error.message),
      name,
    );
  }
});

test("Research decoder recomputes the bounded selector catalog and enforces an exhaustive single-span decision bijection", () => {
  const catalogMutation = fixture();
  const mutatedCatalogAuthority = selectorAuthority(catalogMutation);
  mutatedCatalogAuthority.catalog.sources[0]!.spans[0]!.text += " Mutated after hashing.";
  writeV3Provenance(catalogMutation, mutatedCatalogAuthority);

  const arbitraryHash = fixture();
  const arbitraryHashAuthority = selectorAuthority(arbitraryHash);
  arbitraryHashAuthority.catalogHash = "d".repeat(64);
  arbitraryHashAuthority.catalog.catalogHash = "d".repeat(64);
  writeV3Provenance(arbitraryHash, arbitraryHashAuthority);

  const duplicatedDecision = fixture();
  const duplicatedDecisionAuthority = selectorAuthority(duplicatedDecision);
  duplicatedDecisionAuthority.decisions[1] = {
    ...duplicatedDecisionAuthority.decisions[0]!,
  };
  writeV3Provenance(duplicatedDecision, duplicatedDecisionAuthority);

  const outsideCatalog = fixture();
  const outsideCatalogAuthority = selectorAuthority(outsideCatalog);
  outsideCatalogAuthority.decisions[0]!.selectedSpanId =
    `research-evidence-span-${"f".repeat(64)}`;
  writeV3Provenance(outsideCatalog, outsideCatalogAuthority);

  const multiplePassages = fixture();
  const multiplePassagesAuthority = selectorAuthority(multiplePassages, [
    `research-evidence-span-${"1".repeat(64)}`,
    `research-evidence-span-${"2".repeat(64)}`,
  ]);
  writeV3Provenance(multiplePassages, multiplePassagesAuthority);

  const malformedSpanId = fixture();
  const malformedSpanIdAuthority = selectorAuthority(malformedSpanId);
  malformedSpanIdAuthority.catalog.sources[0]!.spans[0]!.spanId = "forged-span-id";
  malformedSpanIdAuthority.decisions[0]!.selectedSpanId = "forged-span-id";
  malformedSpanIdAuthority.decisions[1]!.selectedSpanId = "forged-span-id";
  rehashSelectorAuthority(malformedSpanId, malformedSpanIdAuthority);
  writeV3Provenance(malformedSpanId, malformedSpanIdAuthority);

  const duplicateGlobalSpan = fixture();
  const duplicateGlobalSpanAuthority = selectorAuthority(duplicateGlobalSpan);
  duplicateGlobalSpanAuthority.catalog.sources.push({
    sourceId: "source-interview",
    queries: [{
      findingId: "finding-celebration",
      supportIndex: 0,
      statement: "A more expressive confirmation may increase perceived reward.",
    }],
    spans: [{ ...duplicateGlobalSpanAuthority.catalog.sources[0]!.spans[0]! }],
  });
  duplicateGlobalSpanAuthority.decisions.push({
    findingId: "finding-celebration",
    supportIndex: 0,
    sourceId: "source-interview",
    selectedSpanId: null,
  });
  rehashSelectorAuthority(duplicateGlobalSpan, duplicateGlobalSpanAuthority);
  writeV3Provenance(duplicateGlobalSpan, duplicateGlobalSpanAuthority);

  const outOfRangeSupportIndex = fixture();
  const outOfRangeSupportIndexAuthority = selectorAuthority(outOfRangeSupportIndex);
  outOfRangeSupportIndexAuthority.catalog.sources[0]!.queries[0]!.supportIndex = 8;
  outOfRangeSupportIndexAuthority.decisions[0]!.supportIndex = 8;
  rehashSelectorAuthority(outOfRangeSupportIndex, outOfRangeSupportIndexAuthority);
  writeV3Provenance(outOfRangeSupportIndex, outOfRangeSupportIndexAuthority);

  const inconsistentFindingStatement = fixture();
  const inconsistentFindingStatementAuthority = selectorAuthority(inconsistentFindingStatement);
  inconsistentFindingStatementAuthority.catalog.sources.push({
    sourceId: "source-interview",
    queries: [{
      findingId: "finding-comparison",
      supportIndex: 0,
      statement: "A conflicting statement cannot share the same finding identity.",
    }],
    spans: [{
      spanId: `research-evidence-span-${"3".repeat(64)}`,
      text: "A separate canonical passage.",
    }],
  });
  inconsistentFindingStatementAuthority.decisions.push({
    findingId: "finding-comparison",
    supportIndex: 0,
    sourceId: "source-interview",
    selectedSpanId: null,
  });
  rehashSelectorAuthority(inconsistentFindingStatement, inconsistentFindingStatementAuthority);
  writeV3Provenance(inconsistentFindingStatement, inconsistentFindingStatementAuthority);

  const oversizedUtf8Span = fixture();
  const oversizedUtf8SpanAuthority = selectorAuthority(oversizedUtf8Span);
  oversizedUtf8SpanAuthority.catalog.sources[0]!.spans[0]!.text = "界".repeat(342);
  rehashSelectorAuthority(oversizedUtf8Span, oversizedUtf8SpanAuthority);
  writeV3Provenance(oversizedUtf8Span, oversizedUtf8SpanAuthority);

  const oversizedUtf8Statement = fixture();
  const oversizedUtf8StatementAuthority = selectorAuthority(oversizedUtf8Statement);
  oversizedUtf8StatementAuthority.catalog.sources[0]!.queries[0]!.statement = "界".repeat(2_731);
  rehashSelectorAuthority(oversizedUtf8Statement, oversizedUtf8StatementAuthority);
  writeV3Provenance(oversizedUtf8Statement, oversizedUtf8StatementAuthority);

  const selectedSpanTextMismatch = fixture();
  const selectedSpanTextMismatchAuthority = selectorAuthority(selectedSpanTextMismatch);
  selectedSpanTextMismatchAuthority.catalog.sources[0]!.spans[0]!.text =
    "A forged passage cannot replace the selected verified receipt excerpt.";
  rehashSelectorAuthority(selectedSpanTextMismatch, selectedSpanTextMismatchAuthority);
  writeV3Provenance(selectedSpanTextMismatch, selectedSpanTextMismatchAuthority);

  const queryStatementMismatch = fixture();
  const queryStatementMismatchAuthority = selectorAuthority(queryStatementMismatch);
  queryStatementMismatchAuthority.catalog.sources[0]!.queries[0]!.statement =
    "A forged statement cannot replace the immutable finding statement.";
  rehashSelectorAuthority(queryStatementMismatch, queryStatementMismatchAuthority);
  writeV3Provenance(queryStatementMismatch, queryStatementMismatchAuthority);

  const querySupportMismatch = fixture();
  const querySupportMismatchAuthority = selectorAuthority(querySupportMismatch);
  querySupportMismatchAuthority.catalog.sources[0]!.queries[0]!.supportIndex = 1;
  querySupportMismatchAuthority.decisions[0]!.supportIndex = 1;
  rehashSelectorAuthority(querySupportMismatch, querySupportMismatchAuthority);
  writeV3Provenance(querySupportMismatch, querySupportMismatchAuthority);

  for (const { name, value } of [
    { name: "catalog mutation", value: catalogMutation },
    { name: "arbitrary catalog hash", value: arbitraryHash },
    { name: "duplicated decision", value: duplicatedDecision },
    { name: "outside-catalog span", value: outsideCatalog },
    { name: "multiple passages for one source", value: multiplePassages },
    { name: "malformed span id", value: malformedSpanId },
    { name: "duplicate span id across sources", value: duplicateGlobalSpan },
    { name: "support index outside runtime bound", value: outOfRangeSupportIndex },
    { name: "inconsistent statement for one finding", value: inconsistentFindingStatement },
    { name: "span beyond UTF-8 byte bound", value: oversizedUtf8Span },
    { name: "statement beyond UTF-8 byte bound", value: oversizedUtf8Statement },
    { name: "selected span text differs from verified receipt", value: selectedSpanTextMismatch },
    { name: "selector query statement differs from finding", value: queryStatementMismatch },
    { name: "selector query points outside exact finding support", value: querySupportMismatch },
  ]) {
    assert.throws(
      () => select(value),
      (error: unknown) => error instanceof ResearchResourceRevisionError
        && /selector|catalog|decision|passages|finding|support|binding/i.test(error.message),
      name,
    );
  }
});

test("Research decoder binds selector and groundedness evidence to one reviewer principal independent from the generator", () => {
  const generatorCollision = fixture();
  generatorCollision.provenance.adapterProvenance.generatorId = "verifier-one";
  writeV3Provenance(generatorCollision, selectorAuthority(generatorCollision));

  const reviewerMismatch = fixture();
  writeV3Provenance(reviewerMismatch, {
    ...selectorAuthority(reviewerMismatch),
    id: "selector-two",
  });

  for (const { name, value } of [
    { name: "generator and reviewer collision", value: generatorCollision },
    { name: "selector and verifier mismatch", value: reviewerMismatch },
  ]) {
    assert.throws(
      () => select(value),
      (error: unknown) => error instanceof ResearchResourceRevisionError
        && /independent reviewer principal/i.test(error.message),
      name,
    );
  }
});

test("Research decoder accepts selector binding reasons only with matching durable v3 authority", () => {
  for (const reason of [
    "binding-unavailable",
    "binding-rejected",
    "binding-invalid",
  ] satisfies BindingReason[]) {
    const value = fixture();
    setBindingFailureReason(value, reason);
    writeV3Provenance(
      value,
      reason === "binding-unavailable"
        ? null
        : interviewSelectorAuthority(
            value,
            reason === "binding-rejected"
              ? null
              : `research-evidence-span-${"1".repeat(64)}`,
          ),
    );
    assert.equal(select(value).id, "quiet-confidence", reason);
  }
});

test("Research decoder rejects selector binding reasons without matching durable authority", () => {
  const legacy = fixture();
  setBindingFailureReason(legacy, "binding-rejected");

  const rejectedWithoutSelector = fixture();
  setBindingFailureReason(rejectedWithoutSelector, "binding-rejected");
  writeV3Provenance(rejectedWithoutSelector, null);

  const unavailableWithSelector = fixture();
  setBindingFailureReason(
    unavailableWithSelector,
    "binding-unavailable",
  );
  writeV3Provenance(
    unavailableWithSelector,
    interviewSelectorAuthority(
      unavailableWithSelector,
      `research-evidence-span-${"1".repeat(64)}`,
    ),
  );

  const rejectedOutsideCatalog = fixture();
  setBindingFailureReason(rejectedOutsideCatalog, "binding-rejected");
  writeV3Provenance(rejectedOutsideCatalog, selectorAuthority(rejectedOutsideCatalog));

  const invalidOutsideCatalog = fixture();
  setBindingFailureReason(invalidOutsideCatalog, "binding-invalid");
  writeV3Provenance(invalidOutsideCatalog, selectorAuthority(invalidOutsideCatalog));

  const rejectedWithSelection = fixture();
  setBindingFailureReason(rejectedWithSelection, "binding-rejected");
  writeV3Provenance(
    rejectedWithSelection,
    interviewSelectorAuthority(
      rejectedWithSelection,
      `research-evidence-span-${"1".repeat(64)}`,
    ),
  );

  const invalidWithoutSelection = fixture();
  setBindingFailureReason(invalidWithoutSelection, "binding-invalid");
  writeV3Provenance(
    invalidWithoutSelection,
    interviewSelectorAuthority(invalidWithoutSelection, null),
  );

  const verifiedDespiteAllNull = fixture();
  writeV3Provenance(
    verifiedDespiteAllNull,
    selectorAuthority(verifiedDespiteAllNull, [null, null]),
  );

  const retrievalFailureDespiteSelection = fixture();
  writeV3Provenance(
    retrievalFailureDespiteSelection,
    interviewSelectorAuthority(
      retrievalFailureDespiteSelection,
      `research-evidence-span-${"1".repeat(64)}`,
    ),
  );

  for (const { name, value } of [
    { name: "v2 binding reason", value: legacy },
    { name: "rejected without selector authority", value: rejectedWithoutSelector },
    { name: "unavailable with selector authority", value: unavailableWithSelector },
    { name: "rejected source outside selector catalog", value: rejectedOutsideCatalog },
    { name: "invalid source outside selector catalog", value: invalidOutsideCatalog },
    { name: "rejected source with a selected span", value: rejectedWithSelection },
    { name: "invalid source without a selected span", value: invalidWithoutSelection },
    { name: "verified source despite all-null decisions", value: verifiedDespiteAllNull },
    { name: "retrieval failure despite selected span", value: retrievalFailureDespiteSelection },
  ]) {
    assert.throws(
      () => select(value),
      (error: unknown) => error instanceof ResearchResourceRevisionError
        && /selector|binding.*provenance|evidence provenance/i.test(error.message),
      name,
    );
  }
});
