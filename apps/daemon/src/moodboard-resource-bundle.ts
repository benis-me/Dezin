import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  MAX_MOODBOARD_EMBEDDED_ASSET_BYTES,
  MAX_MOODBOARD_EMBEDDED_ASSET_TOTAL_BYTES,
  MAX_MOODBOARD_RESOURCE_BUNDLE_BYTES,
  ResourceRevisionPayloadError,
  verifyBoundedResourcePayloadBytes,
} from "./resource-revision-payload.ts";
import { stableStringify } from "./context/context-types.ts";
import type { FrozenMoodboardResearchAuthority } from "./moodboard-direction-authority.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTEXT_PACK_ID = /^context-pack-([a-f0-9]{64})$/;
const MAX_MOODBOARD_ASSETS = 1_024;
const MAX_MOODBOARD_NODES = 100_000;
const MAX_MOODBOARD_MESSAGES = 100_000;
const MAX_EMBEDDED_ASSET_BASE64_CODE_UNITS =
  4 * Math.ceil(MAX_MOODBOARD_EMBEDDED_ASSET_BYTES / 3);

export class MoodboardResourceBundleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MoodboardResourceBundleError";
  }
}

export interface ValidatedMoodboardResourceAsset {
  readonly id: string;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly checksum: string;
  readonly retainedBytes: Buffer | null;
  readonly directionId: string | null;
  readonly directionTitle: string | null;
  readonly directionChecksum: string | null;
}

export interface ValidatedMoodboardDirectionContractEntry {
  readonly resourceId: string;
  readonly revisionId: string;
  readonly id: string;
  readonly title: string;
  readonly thesis: string;
  readonly visualLanguage: readonly string[];
  readonly interactionPrinciples: readonly string[];
  readonly risks: readonly string[];
  readonly checksum: string;
}

export interface ValidatedMoodboardDirectionContract {
  readonly protocol: "dezin.moodboard-direction-contract.v1";
  readonly contextPackId: string;
  readonly directions: readonly ValidatedMoodboardDirectionContractEntry[];
  readonly checksum: string;
}

export interface ValidatedMoodboardResourceBundle {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly version: 1 | 2 | 3;
  readonly board: Readonly<Record<string, unknown>>;
  readonly nodes: readonly unknown[];
  readonly messages: readonly unknown[];
  readonly assets: readonly ValidatedMoodboardResourceAsset[];
  readonly directionContract: ValidatedMoodboardDirectionContract | null;
}

export interface MoodboardResourceGenerationLineage {
  readonly taskId: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface MoodboardExpectedContextPackIdentity {
  readonly contextPackId: string;
  readonly contextPackHash: string;
}

/**
 * This policy is daemon-owned configuration, never Resource output. The
 * compatibility value exists only for explicitly wired legacy v2 adapters.
 */
export type MoodboardV2LineagePolicy =
  | "require-production-lineage"
  | "allow-legacy-v2";

function fail(message: string, cause?: unknown): never {
  throw new MoodboardResourceBundleError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    return fail(`${label} is invalid`);
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const item = record(value, label);
  const actual = Object.keys(item).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return fail(`${label} fields are invalid`);
  }
  return item;
}

function boundedString(value: unknown, label: string, maximum = 8_192): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    return fail(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return fail(`${label} is invalid`);
  }
  return Number(value);
}

function credentialFreeBaseUrl(value: unknown, label: string): string | null {
  // Legacy sealed receipts used null for CLI/session reviewers with no HTTP
  // endpoint. Current FrozenResourceExecutionProfile canonicalizes that state
  // to the empty string, so both representations mean exactly “no base URL”.
  if (value === null || value === "") return value;
  if (typeof value !== "string" || value.length > 4_096 || value.includes("\0")) {
    return fail(`${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    return fail(`${label} is invalid`, error);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || value !== url.href) {
    return fail(`${label} must be canonical and credential-free`);
  }
  return value;
}

interface ReviewerIdentity {
  readonly id: string;
  readonly model?: string;
}

function reviewerIdentity(value: unknown, label: string): ReviewerIdentity {
  const item = record(value, label);
  const keys = Object.keys(item).sort();
  const expected = item.model === undefined ? ["id"] : ["id", "model"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return fail(`${label} fields are invalid`);
  }
  const id = boundedString(item.id, `${label} id`, 512);
  if (item.model === undefined) return Object.freeze({ id });
  return Object.freeze({ id, model: boundedString(item.model, `${label} model`, 512) });
}

function sameReviewer(
  actual: ReviewerIdentity,
  expected: ReviewerIdentity,
  label: string,
): void {
  if (actual.id !== expected.id || (actual.model ?? null) !== (expected.model ?? null)) {
    return fail(`${label} does not match the frozen quality reviewer`);
  }
}

function checksum(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) return fail(`${label} is invalid`);
  return value;
}

function boundedStringArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return fail(`${label} is invalid or unbounded`);
  }
  const result = value.map((item, index) => boundedString(item, `${label} ${index}`, 8_192));
  if (new Set(result).size !== result.length) return fail(`${label} contains duplicates`);
  return Object.freeze(result);
}

function stableChecksum(value: unknown): string {
  return sha256(Buffer.from(stableStringify(value), "utf8"));
}

function validateMoodboardDirectionContract(
  board: Record<string, unknown>,
  assets: readonly ValidatedMoodboardResourceAsset[],
): {
  readonly contract: ValidatedMoodboardDirectionContract;
  readonly assignments: ReadonlyMap<string, ValidatedMoodboardDirectionContractEntry>;
} {
  const rawContract = exactRecord(
    board.directionContract,
    ["protocol", "contextPackId", "directions", "checksum"],
    "Moodboard direction contract",
  );
  if (rawContract.protocol !== "dezin.moodboard-direction-contract.v1") {
    return fail("Moodboard direction contract protocol is unsupported");
  }
  const contextPackId = identifier(
    rawContract.contextPackId,
    "Moodboard direction contract Context Pack id",
  );
  if (!Array.isArray(rawContract.directions)
    || rawContract.directions.length < 1
    || rawContract.directions.length > MAX_MOODBOARD_ASSETS
    || rawContract.directions.length !== assets.length) {
    return fail("Moodboard direction contract cardinality does not match its Assets");
  }
  const directionIds = new Set<string>();
  const directions = rawContract.directions.map((rawDirection, index) => {
    const label = `Moodboard direction contract entry ${index}`;
    const item = exactRecord(
      rawDirection,
      [
        "resourceId",
        "revisionId",
        "id",
        "title",
        "thesis",
        "visualLanguage",
        "interactionPrinciples",
        "risks",
        "checksum",
      ],
      label,
    );
    const body = {
      resourceId: identifier(item.resourceId, `${label} Research Resource id`),
      revisionId: identifier(item.revisionId, `${label} Research Revision id`),
      id: identifier(item.id, `${label} id`),
      title: boundedString(item.title, `${label} title`, 8_192),
      thesis: boundedString(item.thesis, `${label} thesis`, 32_000),
      visualLanguage: boundedStringArray(item.visualLanguage, `${label} visual language`, 1, 16),
      interactionPrinciples: boundedStringArray(
        item.interactionPrinciples,
        `${label} interaction principles`,
        1,
        16,
      ),
      risks: boundedStringArray(item.risks, `${label} risks`, 1, 16),
    };
    if (directionIds.has(body.id)) {
      return fail(`Moodboard direction contract id ${body.id} is duplicated`);
    }
    directionIds.add(body.id);
    const expectedChecksum = checksum(item.checksum, `${label} checksum`);
    if (expectedChecksum !== stableChecksum(body)) {
      return fail(`Moodboard direction contract entry ${body.id} checksum is invalid`);
    }
    return Object.freeze({ ...body, checksum: expectedChecksum });
  });
  const contractBody = {
    protocol: "dezin.moodboard-direction-contract.v1" as const,
    contextPackId,
    directions,
  };
  const contractChecksum = checksum(
    rawContract.checksum,
    "Moodboard direction contract checksum",
  );
  if (contractChecksum !== stableChecksum(contractBody)) {
    return fail("Moodboard direction contract checksum is invalid");
  }
  const byId = new Map(directions.map((direction) => [direction.id, direction] as const));
  const assigned = new Set<string>();
  const assignments = new Map<string, ValidatedMoodboardDirectionContractEntry>();
  for (const asset of assets) {
    if (asset.mimeType !== "image/png" || asset.metadata.kind !== "image") {
      return fail(`Moodboard Asset ${asset.id} assigned to a Research direction must be an exact PNG image`);
    }
    const directionId = identifier(
      asset.metadata.directionId,
      `Moodboard Asset ${asset.id} direction assignment`,
    );
    if (assigned.has(directionId)) {
      return fail(`Moodboard direction assignment ${directionId} is duplicated`);
    }
    const direction = byId.get(directionId);
    if (direction === undefined) {
      return fail(`Moodboard Asset ${asset.id} has a foreign direction assignment`);
    }
    const title = boundedString(
      asset.metadata.directionTitle,
      `Moodboard Asset ${asset.id} direction title`,
      8_192,
    );
    const directionChecksum = checksum(
      asset.metadata.directionChecksum,
      `Moodboard Asset ${asset.id} direction checksum`,
    );
    if (title !== direction.title || directionChecksum !== direction.checksum) {
      return fail(`Moodboard Asset ${asset.id} direction assignment does not match its contract`);
    }
    assigned.add(directionId);
    assignments.set(asset.id, direction);
  }
  if (assigned.size !== directions.length) {
    return fail("Moodboard direction contract is missing an Asset assignment");
  }
  return {
    contract: Object.freeze({ ...contractBody, checksum: contractChecksum }),
    assignments,
  };
}

/**
 * Binds a self-consistent generated v3 contract to the daemon-resolved frozen
 * Research Revision content. Recomputing every bundle/receipt checksum cannot
 * substitute a direction field or reorder the authority.
 */
export function validateMoodboardDirectionAuthority(
  bundle: ValidatedMoodboardResourceBundle,
  authority: FrozenMoodboardResearchAuthority,
): void {
  if (bundle.version !== 3 || bundle.directionContract === null) {
    return fail("Moodboard Research direction authority requires a v3 direction contract");
  }
  const contract = bundle.directionContract;
  if (contract.contextPackId !== authority.contextPackId
    || contract.directions.length !== authority.directions.length) {
    return fail("Generated Moodboard direction contract does not match its frozen Research authority");
  }
  for (const [index, direction] of contract.directions.entries()) {
    const expected = authority.directions[index];
    if (expected === undefined || !isDeepStrictEqual({
      resourceId: direction.resourceId,
      revisionId: direction.revisionId,
      id: direction.id,
      title: direction.title,
      thesis: direction.thesis,
      visualLanguage: direction.visualLanguage,
      interactionPrinciples: direction.interactionPrinciples,
      risks: direction.risks,
    }, expected)) {
      return fail(
        `Generated Moodboard direction contract entry ${direction.id} does not match its frozen Research authority`,
      );
    }
  }
}

function reviewVerdict(value: Record<string, unknown>, label: string): {
  decision: "pass" | "fail";
  semanticMatch: boolean;
  visualQuality: "pass" | "fail";
} {
  if ((value.decision !== "pass" && value.decision !== "fail")
    || typeof value.semanticMatch !== "boolean"
    || (value.visualQuality !== "pass" && value.visualQuality !== "fail")
    || (value.decision === "pass")
      !== (value.semanticMatch === true && value.visualQuality === "pass")) {
    return fail(`${label} verdict is invalid`);
  }
  return {
    decision: value.decision,
    semanticMatch: value.semanticMatch,
    visualQuality: value.visualQuality,
  };
}

/**
 * Cross-check the generated v2/v3 bundle with the attempt receipt's immutable
 * metadata/provenance/evidence. This is intentionally separate from the byte
 * decoder so imported v1 Moodboards remain readable while generated output
 * cannot shed or rewrite its independent-review/repair lineage.
 */
export function validateGeneratedMoodboardResourceLineage(
  bundle: ValidatedMoodboardResourceBundle,
  lineage: MoodboardResourceGenerationLineage,
  expectedContextPack: MoodboardExpectedContextPackIdentity | null = null,
  v2LineagePolicy: MoodboardV2LineagePolicy = "require-production-lineage",
): void {
  if (bundle.version !== 2 && bundle.version !== 3) {
    return fail("Generated Moodboard bundle must use version 2 or 3");
  }

  if (bundle.version === 2 && v2LineagePolicy === "allow-legacy-v2") {
    if (lineage.metadata.format !== "dezin-moodboard-resource-bundle"
      || lineage.metadata.version !== 2
      || (lineage.metadata.assetCount !== undefined
        && lineage.metadata.assetCount !== bundle.assets.length)
      || (lineage.metadata.nodeCount !== undefined
        && lineage.metadata.nodeCount !== bundle.nodes.length)) {
      return fail("Generated legacy Moodboard receipt metadata does not match its bundle");
    }
    return;
  }

  if (lineage.metadata.format !== "dezin-moodboard-resource-bundle"
    || lineage.metadata.version !== bundle.version
    || lineage.metadata.assetCount !== bundle.assets.length
    || lineage.metadata.nodeCount !== bundle.nodes.length) {
    return fail("Generated Moodboard receipt metadata does not match its bundle");
  }
  if (lineage.provenance.protocol !== "dezin.production-resource-generation.v1"
    || lineage.provenance.taskId !== lineage.taskId
    || lineage.provenance.attempt !== lineage.attempt
    || lineage.provenance.inputHash !== lineage.inputHash) {
    return fail("Generated Moodboard provenance does not match its attempt identity");
  }
  const provenanceContextPackId = identifier(
    lineage.provenance.contextPackId,
    "Generated Moodboard primary Context Pack provenance id",
  );
  const provenanceContextPackHash = checksum(
    lineage.provenance.contextPackHash,
    "Generated Moodboard primary Context Pack provenance hash",
  );
  const contextPackMatch = CONTEXT_PACK_ID.exec(provenanceContextPackId);
  if (contextPackMatch?.[1] !== provenanceContextPackHash) {
    return fail("Generated Moodboard primary Context Pack provenance is invalid");
  }
  if (expectedContextPack === null) {
    return fail("Generated Moodboard has no exact Attempt Context Pack authority");
  }
  const expectedContextPackId = identifier(
    expectedContextPack.contextPackId,
    "Generated Moodboard Attempt Context Pack id",
  );
  const expectedContextPackHash = checksum(
    expectedContextPack.contextPackHash,
    "Generated Moodboard Attempt Context Pack hash",
  );
  const expectedMatch = CONTEXT_PACK_ID.exec(expectedContextPackId);
  if (expectedMatch?.[1] !== expectedContextPackHash
    || provenanceContextPackId !== expectedContextPackId
    || provenanceContextPackHash !== expectedContextPackHash) {
    return fail("Generated Moodboard lineage does not match its exact Attempt Context Pack");
  }
  if (bundle.version === 3) {
    const directionContract = bundle.directionContract;
    if (directionContract === null) {
      return fail("Generated Moodboard v3 direction contract is unavailable");
    }
    if (provenanceContextPackId !== directionContract.contextPackId) {
      return fail("Generated Moodboard primary Context Pack provenance does not match its direction contract");
    }
    const provenanceContract = exactRecord(
      lineage.provenance.directionContract,
      ["protocol", "contextPackId", "checksum", "directionCount"],
      "Generated Moodboard direction contract provenance",
    );
    if (provenanceContract.protocol !== directionContract.protocol
      || provenanceContract.contextPackId !== directionContract.contextPackId
      || checksum(
        provenanceContract.checksum,
        "Generated Moodboard direction contract provenance checksum",
      ) !== directionContract.checksum
      || boundedInteger(
        provenanceContract.directionCount,
        "Generated Moodboard direction contract provenance count",
        1,
        MAX_MOODBOARD_ASSETS,
      ) !== directionContract.directions.length) {
      return fail("Generated Moodboard direction contract provenance does not match its bundle");
    }
    if (!Array.isArray(lineage.evidence.directionAssignments)
      || lineage.evidence.directionAssignments.length !== bundle.assets.length) {
      return fail("Generated Moodboard direction assignment evidence is incomplete");
    }
    for (const [index, asset] of bundle.assets.entries()) {
      const assignment = exactRecord(
        lineage.evidence.directionAssignments[index],
        ["assetId", "directionId", "directionTitle", "directionChecksum"],
        `Generated Moodboard Asset ${asset.id} direction assignment evidence`,
      );
      if (assignment.assetId !== asset.id
        || assignment.directionId !== asset.directionId
        || assignment.directionTitle !== asset.directionTitle
        || checksum(
          assignment.directionChecksum,
          `Generated Moodboard Asset ${asset.id} direction assignment evidence checksum`,
        ) !== asset.directionChecksum) {
        return fail(`Generated Moodboard Asset ${asset.id} direction assignment evidence is invalid`);
      }
    }
  } else if (bundle.directionContract !== null) {
    return fail("Generated Moodboard v2 cannot carry a v3 direction contract");
  }

  const frozenReviewer = exactRecord(
    lineage.provenance.qualityReviewer,
    ["providerId", "model", "baseUrl"],
    "Generated Moodboard quality reviewer provenance",
  );
  const reviewerProviderId = boundedString(
    frozenReviewer.providerId,
    "Generated Moodboard quality reviewer provider",
    512,
  );
  const reviewerModel = frozenReviewer.model === null
    ? null
    : boundedString(frozenReviewer.model, "Generated Moodboard quality reviewer model", 512);
  credentialFreeBaseUrl(
    frozenReviewer.baseUrl,
    "Generated Moodboard quality reviewer base URL",
  );
  const expectedReviewer: ReviewerIdentity = reviewerModel === null
    ? Object.freeze({ id: reviewerProviderId })
    : Object.freeze({ id: reviewerProviderId, model: reviewerModel });

  const repair = exactRecord(
    lineage.provenance.qualityRepair,
    ["maxRepairRounds", "usedRepairRounds", "assetRounds"],
    "Generated Moodboard repair provenance",
  );
  const maxRepairRounds = boundedInteger(
    repair.maxRepairRounds,
    "Generated Moodboard maximum repair rounds",
    0,
    1,
  );
  const usedRepairRounds = boundedInteger(
    repair.usedRepairRounds,
    "Generated Moodboard used repair rounds",
    0,
    maxRepairRounds,
  );
  if (!Array.isArray(repair.assetRounds) || repair.assetRounds.length !== bundle.assets.length) {
    return fail("Generated Moodboard per-Asset repair provenance is incomplete");
  }
  if (!Array.isArray(lineage.evidence.assetChecksums)
    || lineage.evidence.assetChecksums.length !== bundle.assets.length
    || !Array.isArray(lineage.evidence.qualityReviews)
    || lineage.evidence.qualityReviews.length !== bundle.assets.length
    || !Array.isArray(lineage.evidence.qualityReviewHistory)
    || lineage.evidence.qualityReviewHistory.length !== bundle.assets.length) {
    return fail("Generated Moodboard quality evidence is incomplete");
  }

  let summedRepairRounds = 0;
  for (const [index, asset] of bundle.assets.entries()) {
    const repairEntry = exactRecord(
      repair.assetRounds[index],
      ["id", "roundsApplied"],
      `Generated Moodboard Asset ${asset.id} repair provenance`,
    );
    if (repairEntry.id !== asset.id) {
      return fail(`Generated Moodboard Asset ${asset.id} repair identity is invalid`);
    }
    const roundsApplied = boundedInteger(
      repairEntry.roundsApplied,
      `Generated Moodboard Asset ${asset.id} repair rounds`,
      0,
      maxRepairRounds,
    );
    summedRepairRounds += roundsApplied;

    const assetRepair = exactRecord(
      asset.metadata.qualityRepair,
      bundle.version === 3
        ? [
            "roundsApplied",
            "acceptedRound",
            "agentPromptChecksum",
            "originalPromptChecksum",
            "acceptedPromptChecksum",
          ]
        : ["roundsApplied", "acceptedRound", "originalPromptChecksum", "acceptedPromptChecksum"],
      `Generated Moodboard Asset ${asset.id} repair metadata`,
    );
    const acceptedRound = boundedInteger(
      assetRepair.acceptedRound,
      `Generated Moodboard Asset ${asset.id} accepted round`,
      0,
      maxRepairRounds,
    );
    if (assetRepair.roundsApplied !== roundsApplied || acceptedRound !== roundsApplied) {
      return fail(`Generated Moodboard Asset ${asset.id} accepted repair round is inconsistent`);
    }
    const originalPrompt = boundedString(
      asset.metadata.originalPrompt,
      `Generated Moodboard Asset ${asset.id} original prompt`,
      64 * 1024,
    );
    const acceptedPrompt = boundedString(
      asset.metadata.prompt,
      `Generated Moodboard Asset ${asset.id} accepted prompt`,
      64 * 1024,
    );
    const agentPrompt = bundle.version === 3
      ? boundedString(
          asset.metadata.agentPrompt,
          `Generated Moodboard Asset ${asset.id} Agent prompt`,
          64 * 1024,
        )
      : originalPrompt;
    const originalPromptChecksum = checksum(
      assetRepair.originalPromptChecksum,
      `Generated Moodboard Asset ${asset.id} original prompt checksum`,
    );
    const agentPromptChecksum = bundle.version === 3
      ? checksum(
          assetRepair.agentPromptChecksum,
          `Generated Moodboard Asset ${asset.id} Agent prompt checksum`,
        )
      : originalPromptChecksum;
    const acceptedPromptChecksum = checksum(
      assetRepair.acceptedPromptChecksum,
      `Generated Moodboard Asset ${asset.id} accepted prompt checksum`,
    );
    if (agentPromptChecksum !== sha256(Buffer.from(agentPrompt, "utf8"))
      || originalPromptChecksum !== sha256(Buffer.from(originalPrompt, "utf8"))
      || acceptedPromptChecksum !== sha256(Buffer.from(acceptedPrompt, "utf8"))) {
      return fail(`Generated Moodboard Asset ${asset.id} prompt lineage is invalid`);
    }

    const checksumEvidence = exactRecord(
      lineage.evidence.assetChecksums[index],
      ["id", "checksum"],
      `Generated Moodboard Asset ${asset.id} checksum evidence`,
    );
    if (checksumEvidence.id !== asset.id
      || checksum(checksumEvidence.checksum, `Generated Moodboard Asset ${asset.id} evidence checksum`)
        !== asset.checksum) {
      return fail(`Generated Moodboard Asset ${asset.id} checksum evidence is invalid`);
    }

    const finalReview = exactRecord(
      lineage.evidence.qualityReviews[index],
      ["id", "checksum", "reviewer", "decision", "semanticMatch", "visualQuality"],
      `Generated Moodboard Asset ${asset.id} final quality review`,
    );
    if (finalReview.id !== asset.id
      || checksum(finalReview.checksum, `Generated Moodboard Asset ${asset.id} final review checksum`)
        !== asset.checksum) {
      return fail(`Generated Moodboard Asset ${asset.id} final review identity is invalid`);
    }
    sameReviewer(
      reviewerIdentity(finalReview.reviewer, `Generated Moodboard Asset ${asset.id} final reviewer`),
      expectedReviewer,
      `Generated Moodboard Asset ${asset.id} final reviewer`,
    );
    const finalVerdict = reviewVerdict(
      finalReview,
      `Generated Moodboard Asset ${asset.id} final quality review`,
    );
    if (finalVerdict.decision !== "pass") {
      return fail(`Generated Moodboard Asset ${asset.id} final quality review did not pass`);
    }

    const history = exactRecord(
      lineage.evidence.qualityReviewHistory[index],
      ["id", "reviewer", "reviews"],
      `Generated Moodboard Asset ${asset.id} quality review history`,
    );
    if (history.id !== asset.id || !Array.isArray(history.reviews)
      || history.reviews.length !== roundsApplied + 1) {
      return fail(`Generated Moodboard Asset ${asset.id} quality review history is incomplete`);
    }
    sameReviewer(
      reviewerIdentity(history.reviewer, `Generated Moodboard Asset ${asset.id} history reviewer`),
      expectedReviewer,
      `Generated Moodboard Asset ${asset.id} history reviewer`,
    );
    for (const [round, rawReview] of history.reviews.entries()) {
      const review = exactRecord(
        rawReview,
        [
          "round",
          "reviewer",
          "promptChecksum",
          "imageChecksum",
          "decision",
          "semanticMatch",
          "visualQuality",
          "findings",
        ],
        `Generated Moodboard Asset ${asset.id} review round ${round}`,
      );
      if (review.round !== round) {
        return fail(`Generated Moodboard Asset ${asset.id} review rounds are not contiguous`);
      }
      sameReviewer(
        reviewerIdentity(review.reviewer, `Generated Moodboard Asset ${asset.id} round ${round} reviewer`),
        expectedReviewer,
        `Generated Moodboard Asset ${asset.id} round ${round} reviewer`,
      );
      const promptChecksum = checksum(
        review.promptChecksum,
        `Generated Moodboard Asset ${asset.id} round ${round} prompt checksum`,
      );
      const imageChecksum = checksum(
        review.imageChecksum,
        `Generated Moodboard Asset ${asset.id} round ${round} image checksum`,
      );
      const verdict = reviewVerdict(
        review,
        `Generated Moodboard Asset ${asset.id} review round ${round}`,
      );
      if (!Array.isArray(review.findings) || review.findings.length > 16
        || review.findings.some((finding) => typeof finding !== "string"
          || finding.length === 0 || finding.length > 8_192 || finding.includes("\0"))) {
        return fail(`Generated Moodboard Asset ${asset.id} round ${round} findings are invalid`);
      }
      if ((round === 0 && promptChecksum !== originalPromptChecksum)
        || (round === acceptedRound && promptChecksum !== acceptedPromptChecksum)
        || (round < acceptedRound && verdict.decision !== "fail")
        || (round === acceptedRound
          && (imageChecksum !== asset.checksum
            || verdict.decision !== finalVerdict.decision
            || verdict.semanticMatch !== finalVerdict.semanticMatch
            || verdict.visualQuality !== finalVerdict.visualQuality))) {
        return fail(`Generated Moodboard Asset ${asset.id} review round ${round} lineage is invalid`);
      }
    }
  }
  if (summedRepairRounds !== usedRepairRounds || summedRepairRounds > 1) {
    return fail("Generated Moodboard global repair count is inconsistent");
  }
}

export async function validateMoodboardEmbeddedAssetBytes(input: {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  input.signal?.throwIfAborted();
  if (!(input.bytes instanceof Uint8Array)) {
    return fail(`Moodboard Asset ${input.id} is missing its exact bytes`);
  }
  if (input.bytes.byteLength > MAX_MOODBOARD_EMBEDDED_ASSET_BYTES) {
    return fail(`Moodboard Asset ${input.id} exceeds its byte limit`);
  }
  try {
    await verifyBoundedResourcePayloadBytes(input.bytes, input.mimeType, input.signal);
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    if (error instanceof ResourceRevisionPayloadError) {
      return fail(`Moodboard Asset ${input.id} bytes do not match its declared MIME`, error);
    }
    throw error;
  }
}

export async function decodeMoodboardResourceBundle(
  bytes: Uint8Array,
  options: {
    readonly retainAssetId?: string | null;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ValidatedMoodboardResourceBundle> {
  options.signal?.throwIfAborted();
  if (!(bytes instanceof Uint8Array)) return fail("Moodboard Resource bundle bytes are invalid");
  if (bytes.byteLength > MAX_MOODBOARD_RESOURCE_BUNDLE_BYTES) {
    return fail("Moodboard Resource bundle exceeds the 48 MiB decode boundary");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return fail("Moodboard Resource bundle is not valid UTF-8 JSON", error);
  }
  const bundle = record(parsed, "Moodboard Resource bundle");
  if (bundle.format !== "dezin-moodboard-resource-bundle"
    || (bundle.version !== 1 && bundle.version !== 2 && bundle.version !== 3)
    || !Array.isArray(bundle.nodes) || bundle.nodes.length > MAX_MOODBOARD_NODES
    || !Array.isArray(bundle.messages) || bundle.messages.length > MAX_MOODBOARD_MESSAGES
    || !Array.isArray(bundle.assets) || bundle.assets.length > MAX_MOODBOARD_ASSETS) {
    return fail("Moodboard Resource bundle protocol is unsupported or unbounded");
  }
  const version = bundle.version;
  const board = record(bundle.board, "Moodboard Resource board");
  const ids = new Set<string>();
  const assets: ValidatedMoodboardResourceAsset[] = [];
  let totalAssetBytes = 0;
  for (const [index, rawAsset] of bundle.assets.entries()) {
    options.signal?.throwIfAborted();
    const asset = record(rawAsset, `Moodboard Asset ${index}`);
    const id = identifier(asset.id, `Moodboard Asset ${index} id`);
    if (ids.has(id)) return fail(`Moodboard Asset ${id} is duplicated`);
    ids.add(id);
    const metadata = record(asset.metadata, `Moodboard Asset ${id} metadata`);
    const mimeType = metadata.mimeType;
    if (typeof mimeType !== "string"
      || typeof asset.bytesBase64 !== "string"
      || asset.bytesBase64.length > MAX_EMBEDDED_ASSET_BASE64_CODE_UNITS
      || !Number.isSafeInteger(asset.byteLength)
      || Number(asset.byteLength) < 0
      || Number(asset.byteLength) > MAX_MOODBOARD_EMBEDDED_ASSET_BYTES
      || typeof asset.checksum !== "string"
      || !SHA256.test(asset.checksum)) {
      return fail(`Moodboard Asset ${id} immutable metadata is invalid`);
    }
    const assetBytes = Buffer.from(asset.bytesBase64, "base64");
    if (assetBytes.toString("base64") !== asset.bytesBase64
      || assetBytes.byteLength !== asset.byteLength
      || sha256(assetBytes) !== asset.checksum) {
      return fail(`Moodboard Asset ${id} checksum or bytes are invalid`);
    }
    totalAssetBytes += assetBytes.byteLength;
    if (totalAssetBytes > MAX_MOODBOARD_EMBEDDED_ASSET_TOTAL_BYTES) {
      return fail("Moodboard embedded Asset bytes exceed their aggregate bound");
    }
    await validateMoodboardEmbeddedAssetBytes({
      id,
      bytes: assetBytes,
      mimeType,
      signal: options.signal,
    });
    assets.push(Object.freeze({
      id,
      raw: asset,
      metadata,
      mimeType,
      byteLength: assetBytes.byteLength,
      checksum: asset.checksum,
      retainedBytes: options.retainAssetId === id ? assetBytes : null,
      directionId: null,
      directionTitle: null,
      directionChecksum: null,
    }));
  }
  let directionContract: ValidatedMoodboardDirectionContract | null = null;
  let validatedAssets = assets;
  if (version === 3) {
    const validation = validateMoodboardDirectionContract(board, assets);
    directionContract = validation.contract;
    validatedAssets = assets.map((asset) => {
      const direction = validation.assignments.get(asset.id);
      if (direction === undefined) {
        return fail(`Moodboard Asset ${asset.id} direction assignment is unavailable`);
      }
      return Object.freeze({
        ...asset,
        directionId: direction.id,
        directionTitle: direction.title,
        directionChecksum: direction.checksum,
      });
    });
  }
  return Object.freeze({
    raw: bundle,
    version,
    board,
    nodes: bundle.nodes,
    messages: bundle.messages,
    assets: Object.freeze(validatedAssets),
    directionContract,
  });
}
