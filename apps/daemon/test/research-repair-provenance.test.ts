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

const WORKSPACE_ID = "workspace-research-repair";
const RESOURCE_ID = "resource-research-repair";
const CONTEXT_PACK = {
  id: "context-research-repair",
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function repairAudit(input: {
  findingIds?: string[];
  evidenceFindingIds?: string[];
  hypothesisFindingIds?: string[];
  changedDirectionOriginalFindingIds?: string[];
} = {}) {
  const evidenceFindingIds = input.evidenceFindingIds
    ?? ["finding-comparison", "finding-summary"];
  const hypothesisFindingIds = input.hypothesisFindingIds
    ?? ["finding-celebration"];
  return {
    protocol: "dezin.research-direction-only-first-candidate-audit.v1",
    findingIds: input.findingIds
      ?? ["finding-comparison", "finding-celebration", "finding-summary"],
    evidenceFindingIds,
    hypothesisFindingIds,
    directionIds: ["quiet-confidence", "expressive-confirmation"],
    directionMappings: [
      {
        directionId: "quiet-confidence",
        findingIds: input.changedDirectionOriginalFindingIds ?? ["finding-celebration"],
      },
      {
        directionId: "expressive-confirmation",
        findingIds: ["finding-celebration"],
      },
    ],
    changedDirectionOriginalFindingIds: input.changedDirectionOriginalFindingIds
      ?? ["finding-celebration"],
  };
}

function revisionWithRepair(input: {
  selectedEvidenceFindingIds?: string[];
  revalidatedEvidenceFindingIds?: string[];
  droppedFindingIds?: string[];
  audit?: ReturnType<typeof repairAudit>;
} = {}) {
  const fixture = createResearchRevisionFixture({
    workspaceId: WORKSPACE_ID,
    resourceId: RESOURCE_ID,
    contextPack: CONTEXT_PACK,
  });
  const audit = input.audit ?? repairAudit();
  const researchRepair = {
    protocol: "dezin.research-direction-only-repair.v1",
    firstCandidateAudit: audit,
    firstCandidateChecksum: sha256(stableStringify(audit)),
    gateBlockers: ["insufficient-evidence-directions"],
    changedDirectionId: "quiet-confidence",
    selectedEvidenceFindingIds: input.selectedEvidenceFindingIds
      ?? ["finding-comparison", "finding-summary"],
    revalidatedEvidenceFindingIds: input.revalidatedEvidenceFindingIds
      ?? ["finding-comparison", "finding-summary"],
    droppedFindingIds: input.droppedFindingIds ?? [],
  };
  const repairAuthority = {
    protocol: "dezin.research-direction-only-repair-authority.v1",
    firstCandidateAudit: structuredClone(audit),
    firstCandidateChecksum: sha256(stableStringify(audit)),
  };
  Object.assign(fixture.provenance.adapterProvenance, { researchRepair });
  fixture.bundle.version = 4;
  fixture.metadata.adapter.version = 4;
  Object.assign(fixture.bundle, { repairAuthority });
  return fixture as typeof fixture & {
    bundle: {
      repairAuthority: typeof repairAuthority;
    };
    provenance: {
      adapterProvenance: {
        researchRepair: typeof researchRepair;
      };
    };
  };
}

function select(fixture: ReturnType<typeof createResearchRevisionFixture>) {
  return selectResearchRevisionDirection({
    bytes: Buffer.from(stableStringify(fixture.bundle), "utf8"),
    directionId: "quiet-confidence",
    workspaceId: WORKSPACE_ID,
    resourceId: RESOURCE_ID,
    parentRevisionId: null,
    revisionMetadata: fixture.metadata,
    revisionProvenance: fixture.provenance,
    contextPack: CONTEXT_PACK,
  });
}

function demoteFinding(
  fixture: ReturnType<typeof revisionWithRepair>,
  findingId: string,
): void {
  const finding = fixture.bundle.findings.find((item) => item.id === findingId);
  assert.ok(finding);
  finding.evidenceStatus = "hypothesis";
  finding.confidence = "low";
  finding.groundedness.verified = false;
  finding.groundedness.supportReceiptIds = [];
}

function setRepairOutcome(
  fixture: ReturnType<typeof revisionWithRepair>,
  input: {
    revalidatedEvidenceFindingIds: string[];
    droppedFindingIds: string[];
    grounded: boolean;
  },
): void {
  const repair = fixture.provenance.adapterProvenance.researchRepair;
  repair.revalidatedEvidenceFindingIds = input.revalidatedEvidenceFindingIds;
  repair.droppedFindingIds = input.droppedFindingIds;
  const changedDirection = fixture.bundle.directions.find(
    (direction) => direction.id === repair.changedDirectionId,
  );
  assert.ok(changedDirection);
  changedDirection.findingIds = input.grounded
    ? [...input.revalidatedEvidenceFindingIds]
    : [...repair.selectedEvidenceFindingIds];
  changedDirection.evidenceStatus = input.grounded ? "evidence" : "hypothesis";
  changedDirection.evidenceFindingIds = [...input.revalidatedEvidenceFindingIds];
  changedDirection.hypothesisFindingIds = input.grounded ? [] : [...input.droppedFindingIds];

  const findingStatus = new Map(fixture.bundle.findings.map(
    (finding) => [finding.id, finding.evidenceStatus] as const,
  ));
  for (const principle of fixture.bundle.designPrinciples) {
    principle.evidenceFindingIds = principle.findingIds.filter(
      (findingId) => findingStatus.get(findingId) === "evidence",
    );
    principle.hypothesisFindingIds = principle.findingIds.filter(
      (findingId) => findingStatus.get(findingId) === "hypothesis",
    );
    principle.evidenceStatus = principle.hypothesisFindingIds.length === 0
      ? "evidence"
      : "hypothesis";
  }
  for (const direction of fixture.bundle.directions) {
    if (direction.id === repair.changedDirectionId) continue;
    direction.evidenceFindingIds = direction.findingIds.filter(
      (findingId) => findingStatus.get(findingId) === "evidence",
    );
    direction.hypothesisFindingIds = direction.findingIds.filter(
      (findingId) => findingStatus.get(findingId) === "hypothesis",
    );
    direction.evidenceStatus = direction.hypothesisFindingIds.length === 0
      ? "evidence"
      : "hypothesis";
  }
  const evidenceFindingCount = fixture.bundle.findings.filter(
    (finding) => finding.evidenceStatus === "evidence",
  ).length;
  const evidenceDirectionCount = fixture.bundle.directions.filter(
    (direction) => direction.evidenceStatus === "evidence",
  ).length;
  fixture.metadata.adapter.qualityState = input.grounded ? "grounded" : "needs-review";
  fixture.metadata.adapter.evidenceFindingCount = evidenceFindingCount;
  fixture.metadata.adapter.hypothesisFindingCount = fixture.bundle.findings.length - evidenceFindingCount;
  fixture.metadata.adapter.evidenceDirectionCount = evidenceDirectionCount;
  fixture.metadata.adapter.hypothesisDirectionCount = fixture.bundle.directions.length - evidenceDirectionCount;
  fixture.metadata.adapter.requiresHypothesisConfirmation = evidenceDirectionCount !== fixture.bundle.directions.length;
  fixture.provenance.adapterProvenance.researchEvidence.evidenceFindingCount = evidenceFindingCount;
  fixture.provenance.adapterProvenance.researchEvidence.hypothesisFindingCount =
    fixture.bundle.findings.length - evidenceFindingCount;
}

test("Research decoder accepts a repair lineage whose sealed first-candidate audit is recomputable", () => {
  assert.equal(select(revisionWithRepair()).id, "quiet-confidence");
});

test("Research decoder rejects a syntactically valid checksum that does not seal the first-candidate audit", () => {
  const fixture = revisionWithRepair();
  fixture.provenance.adapterProvenance.researchRepair.firstCandidateChecksum = "f".repeat(64);
  assert.throws(
    () => select(fixture),
    (error: unknown) => error instanceof ResearchResourceRevisionError
      && /first candidate audit checksum/i.test(error.message),
  );
});

test("Research decoder binds every selected repair finding to the sealed first-pass evidence partition", () => {
  const cases = [
    {
      name: "ghost selected finding",
      fixture: revisionWithRepair({
        selectedEvidenceFindingIds: ["finding-comparison", "finding-summary", "finding-ghost"],
        revalidatedEvidenceFindingIds: ["finding-comparison", "finding-summary"],
        droppedFindingIds: ["finding-ghost"],
      }),
    },
    {
      name: "first-pass hypothesis selected as evidence",
      fixture: revisionWithRepair({
        selectedEvidenceFindingIds: ["finding-comparison", "finding-summary", "finding-celebration"],
        revalidatedEvidenceFindingIds: ["finding-comparison", "finding-summary"],
        droppedFindingIds: ["finding-celebration"],
      }),
    },
    {
      name: "first-pass audit classifications do not partition its findings",
      fixture: revisionWithRepair({
        audit: repairAudit({
          evidenceFindingIds: ["finding-comparison", "finding-summary"],
          hypothesisFindingIds: [],
        }),
      }),
    },
  ];
  cases[2]!.fixture.provenance.adapterProvenance.researchRepair.firstCandidateAudit.findingIds = [
    "finding-comparison",
    "finding-summary",
    "finding-celebration",
  ];
  cases[2]!.fixture.provenance.adapterProvenance.researchRepair.firstCandidateChecksum = sha256(stableStringify(
    cases[2]!.fixture.provenance.adapterProvenance.researchRepair.firstCandidateAudit,
  ));

  for (const { name, fixture } of cases) {
    assert.throws(
      () => select(fixture),
      (error: unknown) => error instanceof ResearchResourceRevisionError
        && /first candidate|selected.*finding|repair provenance/i.test(error.message),
      name,
    );
  }
});

test("Research decoder rejects ghost and misclassified repair ids even when the audit checksum is internally valid", () => {
  const ghost = revisionWithRepair({
    audit: repairAudit({
      findingIds: [
        "finding-comparison",
        "finding-celebration",
        "finding-summary",
        "finding-ghost",
      ],
      evidenceFindingIds: ["finding-comparison", "finding-summary", "finding-ghost"],
    }),
    selectedEvidenceFindingIds: ["finding-comparison", "finding-summary", "finding-ghost"],
    revalidatedEvidenceFindingIds: ["finding-comparison", "finding-summary"],
    droppedFindingIds: ["finding-ghost"],
  });
  const droppedStillEvidence = revisionWithRepair({
    revalidatedEvidenceFindingIds: ["finding-comparison"],
    droppedFindingIds: ["finding-summary"],
  });
  setRepairOutcome(droppedStillEvidence, {
    revalidatedEvidenceFindingIds: ["finding-comparison"],
    droppedFindingIds: ["finding-summary"],
    grounded: true,
  });

  for (const { name, fixture } of [
    { name: "ghost immutable finding", fixture: ghost },
    { name: "dropped id remains final evidence", fixture: droppedStillEvidence },
  ]) {
    assert.throws(
      () => select(fixture),
      (error: unknown) => error instanceof ResearchResourceRevisionError
        && /repair provenance|immutable finding|dropped/i.test(error.message),
      name,
    );
  }
});

test("Research decoder accepts fail-closed needs-review lineage with zero or one revalidated finding", () => {
  for (const revalidatedCount of [0, 1]) {
    const fixture = revisionWithRepair();
    if (revalidatedCount === 0) demoteFinding(fixture, "finding-comparison");
    demoteFinding(fixture, "finding-summary");
    const revalidatedEvidenceFindingIds = revalidatedCount === 0 ? [] : ["finding-comparison"];
    const droppedFindingIds = revalidatedCount === 0
      ? ["finding-comparison", "finding-summary"]
      : ["finding-summary"];
    setRepairOutcome(fixture, {
      revalidatedEvidenceFindingIds,
      droppedFindingIds,
      grounded: false,
    });

    assert.equal(
      select(fixture).evidenceStatus,
      "hypothesis",
      `${revalidatedCount} surviving findings must remain an explicit needs-review hypothesis`,
    );
  }
});

test("Research decoder rejects grounded repair lineage with fewer than two revalidated findings", () => {
  const fixture = revisionWithRepair();
  demoteFinding(fixture, "finding-summary");
  setRepairOutcome(fixture, {
    revalidatedEvidenceFindingIds: ["finding-comparison"],
    droppedFindingIds: ["finding-summary"],
    grounded: true,
  });

  assert.throws(
    () => select(fixture),
    (error: unknown) => error instanceof ResearchResourceRevisionError
      && /grounded repair.*two|revalidated/i.test(error.message),
  );
});

test("Research decoder never permits a sealed first-pass hypothesis to become final evidence", () => {
  const fixture = revisionWithRepair({
    audit: repairAudit({
      evidenceFindingIds: ["finding-comparison", "finding-celebration"],
      hypothesisFindingIds: ["finding-summary"],
    }),
    selectedEvidenceFindingIds: ["finding-comparison", "finding-celebration"],
    revalidatedEvidenceFindingIds: ["finding-comparison"],
    droppedFindingIds: ["finding-celebration"],
  });
  setRepairOutcome(fixture, {
    revalidatedEvidenceFindingIds: ["finding-comparison"],
    droppedFindingIds: ["finding-celebration"],
    grounded: false,
  });

  assert.throws(
    () => select(fixture),
    (error: unknown) => error instanceof ResearchResourceRevisionError
      && /first-pass hypothesis.*final evidence|hypothesis promotion/i.test(error.message),
  );
});

test("Research decoder rejects a coordinated provenance remap that is not anchored by the immutable payload", () => {
  const fixture = revisionWithRepair();
  const repair = fixture.provenance.adapterProvenance.researchRepair;
  repair.firstCandidateAudit.changedDirectionOriginalFindingIds = ["finding-comparison"];
  repair.firstCandidateAudit.directionMappings[0]!.findingIds = ["finding-comparison"];
  repair.firstCandidateChecksum = sha256(stableStringify(repair.firstCandidateAudit));

  assert.throws(
    () => select(fixture),
    (error: unknown) => error instanceof ResearchResourceRevisionError
      && /immutable payload.*repair authority|repair authority.*immutable payload/i.test(error.message),
  );
});

test("Research decoder rejects payload/provenance repair-authority mismatch in either direction", () => {
  const payloadTampered = revisionWithRepair();
  payloadTampered.bundle.repairAuthority.firstCandidateAudit
    .changedDirectionOriginalFindingIds = ["finding-comparison"];
  payloadTampered.bundle.repairAuthority.firstCandidateAudit
    .directionMappings[0]!.findingIds = ["finding-comparison"];
  payloadTampered.bundle.repairAuthority.firstCandidateChecksum = sha256(stableStringify(
    payloadTampered.bundle.repairAuthority.firstCandidateAudit,
  ));

  const legacyRepair = revisionWithRepair();
  legacyRepair.bundle.version = 3;
  legacyRepair.metadata.adapter.version = 3;
  delete (legacyRepair.bundle as unknown as { repairAuthority?: unknown }).repairAuthority;

  for (const { name, fixture } of [
    { name: "payload authority differs from provenance", fixture: payloadTampered },
    { name: "v3 repair has no payload authority", fixture: legacyRepair },
  ]) {
    assert.throws(
      () => select(fixture),
      (error: unknown) => error instanceof ResearchResourceRevisionError
        && /immutable payload.*repair authority|repair authority.*immutable payload|v3.*repair/i.test(error.message),
      name,
    );
  }
});
