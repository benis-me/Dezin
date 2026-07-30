import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import type {
  ResearchEvidenceStatus,
  ResearchResourceRevisionView,
  ResearchRevisionDirectionView,
  ResearchRevisionFindingView,
  ResearchRevisionPrincipleView,
  ResearchRevisionQualityState,
  ResearchRevisionSourceView,
  Store,
} from "../../../packages/core/src/index.ts";
import {
  isWellFormedContextText,
  stableStringify,
  type ContextPack,
} from "./context/context-types.ts";
import { createWorkspaceContextPackRepository } from "./context/context-pack-store.ts";
import {
  ResourceRevisionPayloadError,
  resolveResourceRevisionPayloadDescriptor,
  verifyResourceRevisionPayload,
} from "./resource-revision-payload.ts";
import { isCanonicalResearchHttpUrl } from "./research-canonical-url.ts";
import { countCanonicalResearchEvidenceComponents } from "./research-evidence-identity.ts";

const MAX_RESEARCH_VIEW_BYTES = 8 * 1024 * 1024;
const MAX_RESEARCH_SELECTOR_SOURCES = 16;
const MAX_RESEARCH_SELECTOR_QUERIES = 64;
const MAX_RESEARCH_SELECTOR_QUERIES_PER_SOURCE = 8;
const MAX_RESEARCH_SELECTOR_SPANS = 48;
const MAX_RESEARCH_SELECTOR_SPANS_PER_SOURCE = 6;
const MAX_RESEARCH_SELECTOR_CATALOG_BYTES = 256 * 1024;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const RESEARCH_EVIDENCE_SPAN_ID = /^research-evidence-span-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export class ResearchResourceRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchResourceRevisionError";
  }
}

function fail(message: string): never {
  throw new ResearchResourceRevisionError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  const item = record(value, label);
  const keys = Object.keys(item);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(item, key))
    || keys.some((key) => !allowed.has(key))) {
    return fail(`${label} fields are invalid`);
  }
  return item;
}

function array(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return fail(`${label} must contain ${minimum}-${maximum} items`);
  }
  return value;
}

function text(value: unknown, label: string, maximum = 32_000, minimum = 1): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < minimum || value.length > maximum) {
    return fail(`${label} is invalid`);
  }
  return value;
}

function boundedSelectorText(value: unknown, label: string, maximum: number): string {
  const normalized = text(value, label, maximum);
  if (normalized.includes("\0") || !isWellFormedContextText(normalized)
    || Buffer.byteLength(normalized, "utf8") > maximum) {
    return fail(`${label} is invalid`);
  }
  return normalized;
}

function identifier(value: unknown, label: string): string {
  const id = text(value, label, 256);
  if (!IDENTIFIER.test(id)) return fail(`${label} is not canonical`);
  return id;
}

function sha256(value: unknown, label: string): string {
  const checksum = text(value, label, 64);
  if (!SHA256.test(checksum)) return fail(`${label} is invalid`);
  return checksum;
}

function safeInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return fail(`${label} is invalid`);
  }
  return Number(value);
}

function canonicalHttpUrl(value: unknown, label: string): string {
  const raw = text(value, label, 16_384);
  if (!isCanonicalResearchHttpUrl(raw)) {
    return fail(`${label} must be a canonical credential-free HTTP(S) URL`);
  }
  return raw;
}

function verifier(value: unknown, label: string): { id: string; model?: string } | null {
  if (value === null) return null;
  const raw = exactRecord(value, ["id"], label, ["model"]);
  return {
    id: identifier(raw.id, `${label} id`),
    ...(raw.model === undefined ? {} : { model: text(raw.model, `${label} model`, 512) }),
  };
}

function sameVerifier(
  left: { id: string; model?: string } | null,
  right: { id: string; model?: string } | null,
): boolean {
  return left?.id === right?.id && (left?.model ?? null) === (right?.model ?? null);
}

interface DecodedResearchEvidenceSelectorProvenance {
  id: string;
  model?: string;
  catalogHash: string;
  catalog: {
    protocol: "dezin.research-evidence-span-catalog.v1";
    catalogHash: string;
    sources: Array<{
      sourceId: string;
      queries: Array<{
        findingId: string;
        supportIndex: number;
        statement: string;
      }>;
      spans: Array<{
        spanId: string;
        text: string;
      }>;
    }>;
  };
  decisions: Array<{
    findingId: string;
    supportIndex: number;
    sourceId: string;
    selectedSpanId: string | null;
  }>;
}

const RESEARCH_EVIDENCE_PROVENANCE_V2_FIELDS = [
  "protocol",
  "verifiedSourceCount",
  "unverifiedSourceCount",
  "evidenceFindingCount",
  "hypothesisFindingCount",
  "receiptIds",
  "supportReceiptIds",
  "groundednessVerifier",
] as const;

const RESEARCH_SELECTOR_BINDING_FAILURE_REASONS = new Set([
  "binding-unavailable",
  "binding-rejected",
  "binding-invalid",
]);

function exactResearchEvidenceProvenance(
  value: unknown,
): Record<string, unknown> {
  const base = record(value, "Research evidence provenance");
  if (base.protocol === "dezin.research-evidence-provenance.v2") {
    return exactRecord(
      base,
      RESEARCH_EVIDENCE_PROVENANCE_V2_FIELDS,
      "Research evidence provenance",
    );
  }
  if (base.protocol === "dezin.research-evidence-provenance.v3") {
    return exactRecord(
      base,
      [...RESEARCH_EVIDENCE_PROVENANCE_V2_FIELDS, "evidenceSelector"],
      "Research evidence provenance",
    );
  }
  return fail("Research evidence provenance protocol is unsupported");
}

function researchEvidenceSelectionDecisionKey(input: {
  findingId: string;
  supportIndex: number;
  sourceId: string;
}): string {
  return `${input.findingId}\0${input.sourceId}\0${input.supportIndex}`;
}

function researchEvidenceSelectorProvenance(
  value: unknown,
  scope: ResearchBundleScope,
): DecodedResearchEvidenceSelectorProvenance | null {
  if (value === null) return null;
  const selector = exactRecord(
    value,
    ["id", "catalogHash", "catalog", "decisions"],
    "Research evidence selector provenance",
    ["model"],
  );
  const catalog = exactRecord(
    selector.catalog,
    ["protocol", "catalogHash", "sources"],
    "Research evidence selector catalog",
  );
  if (catalog.protocol !== "dezin.research-evidence-span-catalog.v1") {
    return fail("Research evidence selector catalog protocol is unsupported");
  }
  const sourceIds = new Set<string>();
  const spanIds = new Set<string>();
  const statementsByFinding = new Map<string, string>();
  const expectedDecisions = new Map<string, ReadonlySet<string>>();
  let queryCount = 0;
  let spanCount = 0;
  const sources = array(
    catalog.sources,
    "Research evidence selector catalog sources",
    1,
    MAX_RESEARCH_SELECTOR_SOURCES,
  ).map((rawSource, sourceIndex) => {
    const source = exactRecord(
      rawSource,
      ["sourceId", "queries", "spans"],
      `Research evidence selector catalog source ${sourceIndex}`,
    );
    const sourceId = identifier(
      source.sourceId,
      `Research evidence selector catalog source ${sourceIndex} id`,
    );
    if (sourceIds.has(sourceId)) {
      return fail(`Research evidence selector catalog source ${sourceId} is duplicated`);
    }
    sourceIds.add(sourceId);
    const sourceSpanIds = new Set<string>();
    const spans = array(
      source.spans,
      `Research evidence selector catalog source ${sourceId} spans`,
      1,
      MAX_RESEARCH_SELECTOR_SPANS_PER_SOURCE,
    ).map((rawSpan, spanIndex) => {
      const span = exactRecord(
        rawSpan,
        ["spanId", "text"],
        `Research evidence selector catalog source ${sourceId} span ${spanIndex}`,
      );
      const spanId = identifier(
        span.spanId,
        `Research evidence selector catalog source ${sourceId} span ${spanIndex} id`,
      );
      if (!RESEARCH_EVIDENCE_SPAN_ID.test(spanId) || spanIds.has(spanId)) {
        return fail(`Research evidence selector catalog span ${spanId} identity is invalid or duplicated`);
      }
      spanIds.add(spanId);
      sourceSpanIds.add(spanId);
      spanCount += 1;
      return {
        spanId,
        text: boundedSelectorText(
          span.text,
          `Research evidence selector catalog source ${sourceId} span ${spanIndex} text`,
          1_024,
        ),
      };
    });
    const queries = array(
      source.queries,
      `Research evidence selector catalog source ${sourceId} queries`,
      1,
      MAX_RESEARCH_SELECTOR_QUERIES_PER_SOURCE,
    ).map((rawQuery, queryIndex) => {
      const query = exactRecord(
        rawQuery,
        ["findingId", "supportIndex", "statement"],
        `Research evidence selector catalog source ${sourceId} query ${queryIndex}`,
      );
      const normalized = {
        findingId: identifier(
          query.findingId,
          `Research evidence selector catalog source ${sourceId} query ${queryIndex} finding id`,
        ),
        supportIndex: safeInteger(
          query.supportIndex,
          `Research evidence selector catalog source ${sourceId} query ${queryIndex} support index`,
          0,
          MAX_RESEARCH_SELECTOR_QUERIES_PER_SOURCE - 1,
        ),
        statement: boundedSelectorText(
          query.statement,
          `Research evidence selector catalog source ${sourceId} query ${queryIndex} statement`,
          8_192,
        ),
      };
      const priorStatement = statementsByFinding.get(normalized.findingId);
      if (priorStatement !== undefined && priorStatement !== normalized.statement) {
        return fail("Research evidence selector catalog finding statement is inconsistent");
      }
      statementsByFinding.set(normalized.findingId, normalized.statement);
      const key = researchEvidenceSelectionDecisionKey({ ...normalized, sourceId });
      if (expectedDecisions.has(key)) {
        return fail("Research evidence selector catalog contains a duplicated support edge");
      }
      expectedDecisions.set(key, sourceSpanIds);
      queryCount += 1;
      return normalized;
    });
    return { sourceId, queries, spans };
  });
  if (queryCount > MAX_RESEARCH_SELECTOR_QUERIES || spanCount > MAX_RESEARCH_SELECTOR_SPANS) {
    return fail("Research evidence selector catalog exceeds its structural bounds");
  }
  const catalogHash = sha256(
    catalog.catalogHash,
    "Research evidence selector catalog embedded hash",
  );
  const normalizedCatalog = {
    protocol: "dezin.research-evidence-span-catalog.v1" as const,
    catalogHash,
    sources,
  };
  if (Buffer.byteLength(stableStringify({
        protocol: "dezin.research-evidence-selection-request.v1",
        scope,
        catalog: normalizedCatalog,
      }), "utf8")
      > MAX_RESEARCH_SELECTOR_CATALOG_BYTES
    || catalogHash !== createHash("sha256").update(stableStringify({
      protocol: normalizedCatalog.protocol,
      scope,
      sources: normalizedCatalog.sources,
    })).digest("hex")) {
    return fail("Research evidence selector catalog hash or serialized bound is invalid");
  }
  const selectedSpanBySource = new Map<string, string>();
  const decisionByKey = new Map<string, DecodedResearchEvidenceSelectorProvenance["decisions"][number]>();
  for (const [decisionIndex, rawDecision] of array(
    selector.decisions,
    "Research evidence selector provenance decisions",
    expectedDecisions.size,
    expectedDecisions.size,
  ).entries()) {
    const decision = exactRecord(
      rawDecision,
      ["findingId", "supportIndex", "sourceId", "selectedSpanId"],
      `Research evidence selector provenance decision ${decisionIndex}`,
    );
    const normalized = {
      findingId: identifier(
        decision.findingId,
        `Research evidence selector provenance decision ${decisionIndex} finding id`,
      ),
      supportIndex: safeInteger(
        decision.supportIndex,
        `Research evidence selector provenance decision ${decisionIndex} support index`,
        0,
        MAX_RESEARCH_SELECTOR_QUERIES_PER_SOURCE - 1,
      ),
      sourceId: identifier(
        decision.sourceId,
        `Research evidence selector provenance decision ${decisionIndex} source id`,
      ),
      selectedSpanId: decision.selectedSpanId === null
        ? null
        : (() => {
            const spanId = identifier(
              decision.selectedSpanId,
              `Research evidence selector provenance decision ${decisionIndex} selected span id`,
            );
            if (!RESEARCH_EVIDENCE_SPAN_ID.test(spanId)) {
              return fail(
                `Research evidence selector provenance decision ${decisionIndex} selected span id is invalid`,
              );
            }
            return spanId;
          })(),
    };
    const key = researchEvidenceSelectionDecisionKey(normalized);
    const availableSpanIds = expectedDecisions.get(key);
    if (decisionByKey.has(key) || availableSpanIds === undefined
      || (normalized.selectedSpanId !== null
        && !availableSpanIds.has(normalized.selectedSpanId))) {
      return fail("Research evidence selector provenance decision is outside its immutable catalog");
    }
    const existing = normalized.selectedSpanId === null
      ? undefined
      : selectedSpanBySource.get(normalized.sourceId);
    if (normalized.selectedSpanId !== null
      && existing !== undefined
      && existing !== normalized.selectedSpanId) {
      return fail("Research evidence selector provenance chose multiple passages for one source");
    }
    if (normalized.selectedSpanId !== null) {
      selectedSpanBySource.set(normalized.sourceId, normalized.selectedSpanId);
    }
    decisionByKey.set(key, normalized);
  }
  if (decisionByKey.size !== expectedDecisions.size) {
    return fail("Research evidence selector provenance decisions are not an exhaustive catalog bijection");
  }
  const decisions = normalizedCatalog.sources.flatMap((source) =>
    source.queries.map((query) => {
      const decision = decisionByKey.get(researchEvidenceSelectionDecisionKey({
        ...query,
        sourceId: source.sourceId,
      }));
      return decision ?? fail(
        "Research evidence selector provenance omitted an immutable catalog decision",
      );
    }));
  const outerCatalogHash = sha256(
    selector.catalogHash,
    "Research evidence selector catalog hash",
  );
  if (outerCatalogHash !== catalogHash) {
    return fail("Research evidence selector catalog hash identities are inconsistent");
  }
  return {
    id: identifier(selector.id, "Research evidence selector id"),
    ...(selector.model === undefined
      ? {}
      : { model: text(selector.model, "Research evidence selector model", 512) }),
    catalogHash: outerCatalogHash,
    catalog: normalizedCatalog,
    decisions,
  };
}

function stringArray(value: unknown, label: string, minimum = 0, maximum = 64): string[] {
  const values = array(value, label, minimum, maximum).map((item, index) => text(item, `${label} ${index}`, 8_192));
  if (new Set(values).size !== values.length) return fail(`${label} cannot contain duplicates`);
  return values;
}

function evidenceStatus(value: unknown, label: string): ResearchEvidenceStatus {
  if (value !== "evidence" && value !== "hypothesis") return fail(`${label} is invalid`);
  return value;
}

function researchExtractorMatchesMimeType(extractorId: string, mimeType: string): boolean {
  if (!MIME_TYPE.test(mimeType)) return false;
  if (extractorId === "dezin.html-visible-text") {
    return mimeType === "text/html" || mimeType === "application/xhtml+xml";
  }
  if (extractorId === "dezin.pdf-text") return mimeType === "application/pdf";
  return extractorId === "dezin.utf8-text"
    && (mimeType.startsWith("text/")
      || mimeType === "application/json" || mimeType.endsWith("+json")
      || mimeType === "application/xml" || mimeType.endsWith("+xml"));
}

function confidence(value: unknown, label: string): "high" | "medium" | "low" {
  if (value !== "high" && value !== "medium" && value !== "low") return fail(`${label} is invalid`);
  return value;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

interface DecodedResearchRepairProvenance {
  protocol: "dezin.research-direction-only-repair.v1";
  firstCandidateAudit: {
    protocol: "dezin.research-direction-only-first-candidate-audit.v1";
    findingIds: string[];
    evidenceFindingIds: string[];
    hypothesisFindingIds: string[];
    directionIds: string[];
    directionMappings: Array<{
      directionId: string;
      findingIds: string[];
    }>;
    changedDirectionOriginalFindingIds: string[];
  };
  firstCandidateChecksum: string;
  gateBlockers: string[];
  changedDirectionId: string;
  selectedEvidenceFindingIds: string[];
  revalidatedEvidenceFindingIds: string[];
  droppedFindingIds: string[];
}

interface DecodedResearchRepairAuthority {
  firstCandidateAudit: unknown;
  firstCandidateChecksum: string;
}

function decodeResearchRepairAuthority(value: unknown): DecodedResearchRepairAuthority {
  const authority = exactRecord(value, [
    "protocol",
    "firstCandidateAudit",
    "firstCandidateChecksum",
  ], "Research immutable payload repair authority");
  if (authority.protocol !== "dezin.research-direction-only-repair-authority.v1") {
    return fail("Research immutable payload repair authority protocol is unsupported");
  }
  return {
    firstCandidateAudit: authority.firstCandidateAudit,
    firstCandidateChecksum: sha256(
      authority.firstCandidateChecksum,
      "Research immutable payload repair authority checksum",
    ),
  };
}

function decodeResearchRepairProvenance(
  value: unknown,
  authority: DecodedResearchRepairAuthority | null,
): DecodedResearchRepairProvenance {
  const repair = exactRecord(value, [
    "protocol",
    "firstCandidateAudit",
    "firstCandidateChecksum",
    "gateBlockers",
    "changedDirectionId",
    "selectedEvidenceFindingIds",
    "revalidatedEvidenceFindingIds",
    "droppedFindingIds",
  ], "Research direction-only repair provenance");
  if (repair.protocol !== "dezin.research-direction-only-repair.v1") {
    return fail("Research direction-only repair provenance protocol is unsupported");
  }
  const firstCandidateAudit = exactRecord(repair.firstCandidateAudit, [
    "protocol",
    "findingIds",
    "evidenceFindingIds",
    "hypothesisFindingIds",
    "directionIds",
    "directionMappings",
    "changedDirectionOriginalFindingIds",
  ], "Research direction-only repair first candidate audit");
  if (firstCandidateAudit.protocol !== "dezin.research-direction-only-first-candidate-audit.v1") {
    return fail("Research direction-only repair first candidate audit protocol is unsupported");
  }
  const decodedFirstCandidateAudit = {
    protocol: "dezin.research-direction-only-first-candidate-audit.v1" as const,
    findingIds: stringArray(
      firstCandidateAudit.findingIds,
      "Research direction-only repair first candidate finding ids",
      3,
      256,
    ),
    evidenceFindingIds: stringArray(
      firstCandidateAudit.evidenceFindingIds,
      "Research direction-only repair first candidate evidence finding ids",
      1,
      256,
    ),
    hypothesisFindingIds: stringArray(
      firstCandidateAudit.hypothesisFindingIds,
      "Research direction-only repair first candidate hypothesis finding ids",
      0,
      256,
    ),
    directionIds: stringArray(
      firstCandidateAudit.directionIds,
      "Research direction-only repair first candidate direction ids",
      2,
      16,
    ),
    directionMappings: array(
      firstCandidateAudit.directionMappings,
      "Research direction-only repair first candidate direction mappings",
      2,
      16,
    ).map((value, index) => {
      const mapping = exactRecord(
        value,
        ["directionId", "findingIds"],
        `Research direction-only repair first candidate direction mapping ${index}`,
      );
      return {
        directionId: identifier(
          mapping.directionId,
          `Research direction-only repair first candidate direction mapping ${index} id`,
        ),
        findingIds: stringArray(
          mapping.findingIds,
          `Research direction-only repair first candidate direction mapping ${index} finding ids`,
          1,
          64,
        ),
      };
    }),
    changedDirectionOriginalFindingIds: stringArray(
      firstCandidateAudit.changedDirectionOriginalFindingIds,
      "Research direction-only repair first candidate changed direction finding ids",
      1,
      64,
    ),
  };
  const firstCandidateChecksum = sha256(
    repair.firstCandidateChecksum,
    "Research direction-only repair first candidate checksum",
  );
  const expectedFirstCandidateChecksum = createHash("sha256")
    .update(stableStringify(decodedFirstCandidateAudit))
    .digest("hex");
  if (firstCandidateChecksum !== expectedFirstCandidateChecksum) {
    return fail("Research direction-only repair first candidate audit checksum is invalid");
  }
  if (authority === null
    || authority.firstCandidateChecksum !== firstCandidateChecksum
    || stableStringify(authority.firstCandidateAudit) !== stableStringify(decodedFirstCandidateAudit)) {
    return fail("Research repair provenance is not anchored by the immutable payload repair authority");
  }
  const gateBlockers = stringArray(
    repair.gateBlockers,
    "Research direction-only repair gate blockers",
    1,
    16,
  );
  if (gateBlockers.length !== 1 || gateBlockers[0] !== "insufficient-evidence-directions") {
    return fail("Research direction-only repair provenance blocker is invalid");
  }
  const changedDirectionId = identifier(
    repair.changedDirectionId,
    "Research direction-only repair changed direction id",
  );
  const selectedEvidenceFindingIds = stringArray(
    repair.selectedEvidenceFindingIds,
    "Research direction-only repair selected finding ids",
    2,
    32,
  );
  const revalidatedEvidenceFindingIds = stringArray(
    repair.revalidatedEvidenceFindingIds,
    "Research direction-only repair revalidated finding ids",
    0,
    32,
  );
  const droppedFindingIds = stringArray(
    repair.droppedFindingIds,
    "Research direction-only repair dropped finding ids",
    0,
    32,
  );
  const revalidated = new Set(revalidatedEvidenceFindingIds);
  const dropped = new Set(droppedFindingIds);
  const firstCandidateFindingIds = new Set(decodedFirstCandidateAudit.findingIds);
  const firstCandidateEvidenceIds = new Set(decodedFirstCandidateAudit.evidenceFindingIds);
  const firstCandidateHypothesisIds = new Set(decodedFirstCandidateAudit.hypothesisFindingIds);
  if (decodedFirstCandidateAudit.evidenceFindingIds.some((id) => firstCandidateHypothesisIds.has(id))
    || decodedFirstCandidateAudit.findingIds.some(
      (id) => !firstCandidateEvidenceIds.has(id) && !firstCandidateHypothesisIds.has(id),
    )
    || [...firstCandidateEvidenceIds, ...firstCandidateHypothesisIds].length
      !== decodedFirstCandidateAudit.findingIds.length
    || decodedFirstCandidateAudit.directionMappings.length
      !== decodedFirstCandidateAudit.directionIds.length
    || decodedFirstCandidateAudit.directionMappings.some(
      (mapping, index) => mapping.directionId !== decodedFirstCandidateAudit.directionIds[index]
        || mapping.findingIds.some((id) => !firstCandidateFindingIds.has(id)),
    )
    || decodedFirstCandidateAudit.changedDirectionOriginalFindingIds.some(
      (id) => !firstCandidateFindingIds.has(id),
    )
    || !decodedFirstCandidateAudit.directionIds.includes(changedDirectionId)) {
    return fail("Research direction-only repair first candidate audit partition is invalid");
  }
  if (selectedEvidenceFindingIds.some((id) => !firstCandidateEvidenceIds.has(id))) {
    return fail("Research direction-only repair selected finding is not sealed first-pass evidence");
  }
  const changedDirectionMapping = decodedFirstCandidateAudit.directionMappings.find(
    (mapping) => mapping.directionId === changedDirectionId,
  );
  if (!changedDirectionMapping
    || changedDirectionMapping.findingIds.length
      !== decodedFirstCandidateAudit.changedDirectionOriginalFindingIds.length
    || changedDirectionMapping.findingIds.some(
      (id, index) => id !== decodedFirstCandidateAudit.changedDirectionOriginalFindingIds[index],
    )) {
    return fail("Research direction-only repair changed mapping is not bound to the first candidate audit");
  }
  if (selectedEvidenceFindingIds.length
      === decodedFirstCandidateAudit.changedDirectionOriginalFindingIds.length
    && selectedEvidenceFindingIds.every(
      (id, index) => id === decodedFirstCandidateAudit.changedDirectionOriginalFindingIds[index],
    )) {
    return fail("Research direction-only repair did not change the sealed first-pass direction mapping");
  }
  if (revalidatedEvidenceFindingIds.some((id) => dropped.has(id))
    || selectedEvidenceFindingIds.some((id) => !revalidated.has(id) && !dropped.has(id))
    || revalidatedEvidenceFindingIds.some((id) => !selectedEvidenceFindingIds.includes(id))
    || droppedFindingIds.some((id) => !selectedEvidenceFindingIds.includes(id))
    || selectedEvidenceFindingIds.filter((id) => revalidated.has(id))
      .some((id, index) => id !== revalidatedEvidenceFindingIds[index])
    || selectedEvidenceFindingIds.filter((id) => dropped.has(id))
      .some((id, index) => id !== droppedFindingIds[index])) {
    return fail("Research direction-only repair provenance finding partition is invalid");
  }
  return {
    protocol: "dezin.research-direction-only-repair.v1",
    firstCandidateAudit: decodedFirstCandidateAudit,
    firstCandidateChecksum,
    gateBlockers,
    changedDirectionId,
    selectedEvidenceFindingIds,
    revalidatedEvidenceFindingIds,
    droppedFindingIds,
  };
}

function validateResearchRepairAgainstImmutableRevision(input: {
  repair: DecodedResearchRepairProvenance;
  findings: readonly ResearchRevisionFindingView[];
  directions: readonly ResearchRevisionDirectionView[];
  qualityState: ResearchRevisionQualityState;
}): void {
  const { repair } = input;
  const finalFindingIds = input.findings.map((finding) => finding.id);
  const finalDirectionIds = input.directions.map((direction) => direction.id);
  if (repair.firstCandidateAudit.findingIds.length !== finalFindingIds.length
    || repair.firstCandidateAudit.findingIds.some((id, index) => id !== finalFindingIds[index])
    || repair.firstCandidateAudit.directionIds.length !== finalDirectionIds.length
    || repair.firstCandidateAudit.directionIds.some((id, index) => id !== finalDirectionIds[index])) {
    return fail("Research direction-only repair audit does not bind the immutable finding and direction ids");
  }
  const findingById = new Map(input.findings.map((finding) => [finding.id, finding]));
  if (repair.selectedEvidenceFindingIds.some((id) => !findingById.has(id))) {
    return fail("Research direction-only repair provenance contains a ghost immutable finding id");
  }
  if (repair.firstCandidateAudit.hypothesisFindingIds.some(
    (id) => findingById.get(id)?.evidenceStatus !== "hypothesis",
  )) {
    return fail("Research direction-only repair hypothesis promotion reached final evidence");
  }
  if (repair.revalidatedEvidenceFindingIds.some(
    (id) => findingById.get(id)?.evidenceStatus !== "evidence",
  )) {
    return fail("Research direction-only repair revalidated finding is not final evidence");
  }
  if (repair.droppedFindingIds.some(
    (id) => findingById.get(id)?.evidenceStatus !== "hypothesis",
  )) {
    return fail("Research direction-only repair dropped finding is not a final hypothesis");
  }
  const changedDirection = input.directions.find(
    (direction) => direction.id === repair.changedDirectionId,
  );
  if (!changedDirection) {
    return fail("Research direction-only repair provenance does not match the immutable direction");
  }
  const originalMappingByDirectionId = new Map(
    repair.firstCandidateAudit.directionMappings.map(
      (mapping) => [mapping.directionId, mapping.findingIds] as const,
    ),
  );
  for (const direction of input.directions) {
    if (direction.id === repair.changedDirectionId) continue;
    const originalFindingIds = originalMappingByDirectionId.get(direction.id);
    if (!originalFindingIds
      || originalFindingIds.length !== direction.findingIds.length
      || originalFindingIds.some((id, index) => id !== direction.findingIds[index])) {
      return fail("Research direction-only repair changed more than one immutable direction mapping");
    }
  }
  if (repair.revalidatedEvidenceFindingIds.length < 2
    && changedDirection.evidenceStatus === "evidence") {
    return fail("Research grounded repair requires at least two revalidated evidence findings");
  }
  if (repair.revalidatedEvidenceFindingIds.length >= 2) {
    if (changedDirection.evidenceStatus !== "evidence"
      || changedDirection.findingIds.length !== repair.revalidatedEvidenceFindingIds.length
      || changedDirection.findingIds.some(
        (id, index) => id !== repair.revalidatedEvidenceFindingIds[index],
      )
      || changedDirection.evidenceFindingIds.length !== repair.revalidatedEvidenceFindingIds.length
      || changedDirection.evidenceFindingIds.some(
        (id, index) => id !== repair.revalidatedEvidenceFindingIds[index],
      )
      || changedDirection.hypothesisFindingIds.length !== 0) {
      return fail("Research evidence repair provenance does not match the immutable direction");
    }
    return;
  }
  if (changedDirection.evidenceStatus !== "hypothesis"
    || changedDirection.findingIds.length !== repair.selectedEvidenceFindingIds.length
    || changedDirection.findingIds.some(
      (id, index) => id !== repair.selectedEvidenceFindingIds[index],
    )
    || changedDirection.evidenceFindingIds.length !== repair.revalidatedEvidenceFindingIds.length
    || changedDirection.evidenceFindingIds.some(
      (id, index) => id !== repair.revalidatedEvidenceFindingIds[index],
    )
    || changedDirection.hypothesisFindingIds.length !== repair.droppedFindingIds.length
    || changedDirection.hypothesisFindingIds.some(
      (id, index) => id !== repair.droppedFindingIds[index],
    )) {
    return fail("Research hypothesis repair provenance does not match the immutable direction");
  }
}

function parseResearchJson(bytes: Buffer): unknown {
  let textValue: string;
  try {
    textValue = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("Research Revision payload is not valid UTF-8");
  }
  try {
    return JSON.parse(textValue) as unknown;
  } catch {
    return fail("Research Revision payload is not valid JSON");
  }
}

interface ResearchBundleContextPack {
  id: string;
  hash: string;
  graphRevision: number;
}

interface DecodedResearchSource {
  view: ResearchRevisionSourceView;
  binding: {
    contextPackId: string;
    contextPackHash: string;
    itemOrdinal: number;
    itemChecksum: string;
  } | null;
}

interface DecodedResearchReceipt {
  raw: Record<string, unknown>;
  id: string;
  checksum: string;
  sourceId: string;
  sourceKind: "context" | "web" | "user";
  verification: "verified" | "unverified";
  canonicalUrl: string | null;
  canonicalTextChecksum: string | null;
  excerpt: { text: string; utf8Start: number | null; utf8End: number | null };
}

interface DecodedResearchSupportReceipt {
  raw: Record<string, unknown>;
  id: string;
  checksum: string;
  findingId: string;
  statementChecksum: string;
  sourceId: string;
  sourceReceiptId: string;
  verification: "verified" | "unverified";
  quote: { text: string; utf8Start: number | null; utf8End: number | null };
}

function canonicalReceiptIdentity(
  raw: Record<string, unknown>,
  prefix: "research-evidence" | "research-support",
  label: string,
): { id: string; checksum: string } {
  const id = identifier(raw.id, `${label} id`);
  const checksum = sha256(raw.checksum, `${label} checksum`);
  const { id: _id, checksum: _checksum, ...payload } = raw;
  const expected = createHash("sha256").update(stableStringify(payload)).digest("hex");
  if (checksum !== expected || id !== `${prefix}-${expected}`) {
    return fail(`${label} canonical identity is invalid`);
  }
  return { id, checksum };
}

function locatedExcerpt(value: unknown, label: string): {
  text: string;
  utf8Start: number;
  utf8End: number;
} {
  const item = exactRecord(value, ["text", "utf8Start", "utf8End"], label);
  const excerptText = text(item.text, `${label} text`, 16_384);
  const utf8Start = safeInteger(item.utf8Start, `${label} UTF-8 start`);
  const utf8End = safeInteger(item.utf8End, `${label} UTF-8 end`, utf8Start + 1);
  if (utf8End - utf8Start !== Buffer.byteLength(excerptText, "utf8")) {
    return fail(`${label} UTF-8 location is inconsistent`);
  }
  return { text: excerptText, utf8Start, utf8End };
}

function decodeSources(
  value: unknown,
  contextPack: ResearchBundleContextPack,
  authority: ContextPack,
): DecodedResearchSource[] {
  const ids = new Set<string>();
  const receiptIds = new Set<string>();
  return array(value, "Research sources", 2, 64).map((raw, index) => {
    const source = exactRecord(raw, [
      "id", "kind", "title", "locator", "excerpt", "binding", "notes", "verification", "receiptId",
    ], `Research source ${index}`);
    const id = identifier(source.id, `Research source ${index} id`);
    if (ids.has(id)) return fail(`Research source ${id} is duplicated`);
    ids.add(id);
    if (source.kind !== "context" && source.kind !== "web" && source.kind !== "user") {
      return fail(`Research source ${id} kind is invalid`);
    }
    if (source.verification !== "verified" && source.verification !== "unverified") {
      return fail(`Research source ${id} verification is invalid`);
    }
    const receiptId = identifier(source.receiptId, `Research source ${id} receipt id`);
    if (receiptIds.has(receiptId)) return fail(`Research source receipt ${receiptId} is duplicated`);
    receiptIds.add(receiptId);
    let binding: DecodedResearchSource["binding"] = null;
    let locator: string;
    if (source.kind === "web") {
      if (source.binding !== null) return fail(`Research source ${id} web binding must be null`);
      locator = canonicalHttpUrl(source.locator, `Research source ${id} locator`);
    } else {
      const rawBinding = exactRecord(source.binding, [
        "contextPackId", "contextPackHash", "itemOrdinal", "itemChecksum",
      ], `Research source ${id} Context binding`);
      binding = {
        contextPackId: identifier(rawBinding.contextPackId, `Research source ${id} Context Pack id`),
        contextPackHash: sha256(rawBinding.contextPackHash, `Research source ${id} Context Pack hash`),
        itemOrdinal: safeInteger(rawBinding.itemOrdinal, `Research source ${id} Context item ordinal`),
        itemChecksum: sha256(rawBinding.itemChecksum, `Research source ${id} Context item checksum`),
      };
      if (binding.contextPackId !== contextPack.id || binding.contextPackHash !== contextPack.hash) {
        return fail(`Research source ${id} Context Pack binding is inconsistent`);
      }
      const authorityItem = authority.items[binding.itemOrdinal];
      if (!authorityItem
        || authorityItem.ordinal !== binding.itemOrdinal
        || authorityItem.checksum !== binding.itemChecksum
        || authorityItem.provided !== true) {
        return fail(`Research source ${id} Context item is not anchored to its immutable authority`);
      }
      locator = text(source.locator, `Research source ${id} locator`, 16_384);
      if (locator !== `context-pack:${contextPack.id}#item:${binding.itemOrdinal}`) {
        return fail(`Research source ${id} Context locator is inconsistent`);
      }
    }
    return { view: {
      id,
      kind: source.kind,
      title: text(source.title, `Research source ${id} title`, 4_096),
      locator,
      excerpt: text(source.excerpt, `Research source ${id} excerpt`, 16_384),
      notes: text(source.notes, `Research source ${id} notes`, 16_384, 0),
      verification: source.verification,
      receiptId,
    }, binding };
  });
}

function decodeReceipts(
  value: unknown,
  sources: readonly DecodedResearchSource[],
  contextPack: ResearchBundleContextPack,
  authority: ContextPack,
): DecodedResearchReceipt[] {
  const sourceById = new Map(sources.map((source) => [source.view.id, source]));
  const ids = new Set<string>();
  const sourceIds = new Set<string>();
  const receipts = array(value, "Research evidence receipts", sources.length, sources.length).map((raw, index) => {
    const base = record(raw, `Research evidence receipt ${index}`);
    const sourceId = identifier(base.sourceId, `Research evidence receipt ${index} source id`);
    const source = sourceById.get(sourceId);
    if (!source || sourceIds.has(sourceId)) return fail(`Research evidence receipt ${index} source identity is invalid`);
    sourceIds.add(sourceId);
    const receiptProtocol = base.protocol;
    if ((receiptProtocol !== "dezin.research-evidence-receipt.v1"
        && receiptProtocol !== "dezin.research-evidence-receipt.v2")
      || (receiptProtocol === "dezin.research-evidence-receipt.v2" && source.view.kind !== "web")
      || base.sourceKind !== source.view.kind
      || (base.verification !== "verified" && base.verification !== "unverified")
      || base.verification !== source.view.verification) {
      return fail(`Research evidence receipt ${index} source evidence is inconsistent`);
    }
    let item: Record<string, unknown>;
    let excerpt: DecodedResearchReceipt["excerpt"];
    let canonicalUrl: string | null = null;
    let canonicalTextChecksum: string | null = null;
    let canonicalTextByteLength: number | null = null;
    if (source.view.kind === "web" && base.verification === "verified") {
      item = receiptProtocol === "dezin.research-evidence-receipt.v2"
        ? exactRecord(base, [
            "protocol", "sourceId", "sourceKind", "verification", "requestedUrl", "canonicalUrl", "retrievedAt",
            "status", "source", "canonicalText", "excerpt", "id", "checksum",
          ], `Research evidence receipt ${index}`)
        : exactRecord(base, [
            "protocol", "sourceId", "sourceKind", "verification", "requestedUrl", "canonicalUrl", "retrievedAt",
            "status", "mimeType", "contentChecksum", "excerpt", "id", "checksum",
          ], `Research evidence receipt ${index}`);
      if (canonicalHttpUrl(item.requestedUrl, `Research evidence receipt ${index} requested URL`) !== source.view.locator) {
        return fail(`Research evidence receipt ${index} requested URL is inconsistent`);
      }
      canonicalUrl = canonicalHttpUrl(item.canonicalUrl, `Research evidence receipt ${index} canonical URL`);
      safeInteger(item.retrievedAt, `Research evidence receipt ${index} retrieved at`);
      safeInteger(item.status, `Research evidence receipt ${index} status`, 200, 299);
      if (receiptProtocol === "dezin.research-evidence-receipt.v2") {
        const sourceIdentity = exactRecord(
          item.source,
          ["mimeType", "byteLength", "checksum"],
          `Research evidence receipt ${index} source identity`,
        );
        const canonicalText = exactRecord(
          item.canonicalText,
          ["mimeType", "byteLength", "checksum", "extractor"],
          `Research evidence receipt ${index} canonical text`,
        );
        const extractor = exactRecord(
          canonicalText.extractor,
          ["id", "version"],
          `Research evidence receipt ${index} canonical text extractor`,
        );
        const sourceMimeType = text(
          sourceIdentity.mimeType,
          `Research evidence receipt ${index} source MIME type`,
          127,
        );
        safeInteger(sourceIdentity.byteLength, `Research evidence receipt ${index} source bytes`, 1, 4 * 1024 * 1024);
        sha256(sourceIdentity.checksum, `Research evidence receipt ${index} source checksum`);
        if (canonicalText.mimeType !== "text/plain; charset=utf-8") {
          return fail(`Research evidence receipt ${index} canonical text MIME type is invalid`);
        }
        canonicalTextByteLength = safeInteger(
          canonicalText.byteLength,
          `Research evidence receipt ${index} canonical text bytes`,
          1,
          512 * 1024,
        );
        canonicalTextChecksum = sha256(
          canonicalText.checksum,
          `Research evidence receipt ${index} canonical text checksum`,
        );
        if (typeof extractor.id !== "string"
          || !researchExtractorMatchesMimeType(extractor.id, sourceMimeType)
          || extractor.version !== 1) {
          return fail(`Research evidence receipt ${index} canonical text extractor is invalid`);
        }
      } else {
        text(item.mimeType, `Research evidence receipt ${index} MIME type`, 127);
        canonicalTextChecksum = sha256(
          item.contentChecksum,
          `Research evidence receipt ${index} content checksum`,
        );
      }
      const location = locatedExcerpt(item.excerpt, `Research evidence receipt ${index} excerpt`);
      if (canonicalTextByteLength !== null && location.utf8End > canonicalTextByteLength) {
        return fail(`Research evidence receipt ${index} excerpt exceeds canonical text`);
      }
      excerpt = { ...location };
    } else if (source.view.kind === "web") {
      item = exactRecord(base, [
        "protocol", "sourceId", "sourceKind", "verification", "requestedUrl", "reason", "excerpt", "id", "checksum",
      ], `Research evidence receipt ${index}`);
      if (canonicalHttpUrl(item.requestedUrl, `Research evidence receipt ${index} requested URL`) !== source.view.locator
        || (item.reason !== "retriever-unavailable"
          && !(receiptProtocol === "dezin.research-evidence-receipt.v1"
            && item.reason === "retrieval-failed")
          && item.reason !== "network-failed"
          && item.reason !== "http-status"
          && item.reason !== "unsupported-media-type"
          && item.reason !== "content-extraction-failed"
          && item.reason !== "excerpt-mismatch"
          && item.reason !== "representation-invalid"
          && !(receiptProtocol === "dezin.research-evidence-receipt.v2"
            && (item.reason === "binding-unavailable"
              || item.reason === "binding-rejected"
              || item.reason === "binding-invalid")))) {
        return fail(`Research evidence receipt ${index} unverified evidence is inconsistent`);
      }
      const rawExcerpt = exactRecord(item.excerpt, ["text"], `Research evidence receipt ${index} excerpt`);
      excerpt = {
        text: text(rawExcerpt.text, `Research evidence receipt ${index} excerpt text`, 16_384),
        utf8Start: null,
        utf8End: null,
      };
    } else {
      if (base.verification !== "verified" || source.binding === null) {
        return fail(`Research evidence receipt ${index} Context evidence is inconsistent`);
      }
      item = exactRecord(base, [
        "protocol", "sourceId", "sourceKind", "verification", "contextPackId", "contextPackHash",
        "contextItemOrdinal", "contextItemChecksum", "excerpt", "id", "checksum",
      ], `Research evidence receipt ${index}`);
      if (item.contextPackId !== contextPack.id
        || item.contextPackHash !== contextPack.hash
        || item.contextItemOrdinal !== source.binding.itemOrdinal
        || item.contextItemChecksum !== source.binding.itemChecksum) {
        return fail(`Research evidence receipt ${index} Context binding is inconsistent`);
      }
      sha256(item.contextPackHash, `Research evidence receipt ${index} Context Pack hash`);
      sha256(item.contextItemChecksum, `Research evidence receipt ${index} Context item checksum`);
      const location = locatedExcerpt(item.excerpt, `Research evidence receipt ${index} excerpt`);
      const authorityItem = authority.items[source.binding.itemOrdinal];
      const authorityBytes = authorityItem === undefined
        ? null
        : Buffer.from(authorityItem.content, "utf8");
      const excerptBytes = Buffer.from(location.text, "utf8");
      if (authorityItem === undefined
        || authorityItem.ordinal !== source.binding.itemOrdinal
        || authorityItem.checksum !== source.binding.itemChecksum
        || authorityBytes === null
        || location.utf8End > authorityBytes.byteLength
        || !authorityBytes.subarray(location.utf8Start, location.utf8End).equals(excerptBytes)) {
        return fail(`Research evidence receipt ${index} excerpt is not anchored to its immutable Context item`);
      }
      excerpt = { ...location };
    }
    if (excerpt.text !== source.view.excerpt) {
      return fail(`Research evidence receipt ${index} excerpt is inconsistent`);
    }
    const identity = canonicalReceiptIdentity(item, "research-evidence", `Research evidence receipt ${index}`);
    if (ids.has(identity.id) || identity.id !== source.view.receiptId) {
      return fail(`Research evidence receipt ${index} identity is inconsistent`);
    }
    ids.add(identity.id);
    return {
      raw: item,
      ...identity,
      sourceId,
      sourceKind: source.view.kind,
      verification: source.view.verification,
      canonicalUrl,
      canonicalTextChecksum,
      excerpt,
    };
  });
  if (!sameMembers(receipts.map((receipt) => receipt.sourceId), sources.map((source) => source.view.id))) {
    return fail("Research evidence receipts do not cover every source exactly once");
  }
  return receipts;
}

function decodeSupportReceipts(
  value: unknown,
  receipts: readonly DecodedResearchReceipt[],
): DecodedResearchSupportReceipt[] {
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const ids = new Set<string>();
  return array(value, "Research support receipts", 1, 2_048).map((raw, index) => {
    const base = record(raw, `Research support receipt ${index}`);
    if (base.protocol !== "dezin.research-support-receipt.v1"
      || (base.verification !== "verified" && base.verification !== "unverified")) {
      return fail(`Research support receipt ${index} protocol is invalid`);
    }
    const verification = base.verification;
    const item = verification === "verified"
      ? exactRecord(base, [
          "protocol", "findingId", "statementChecksum", "sourceId", "sourceReceiptId", "verification",
          "quote", "id", "checksum",
        ], `Research support receipt ${index}`)
      : exactRecord(base, [
          "protocol", "findingId", "statementChecksum", "sourceId", "sourceReceiptId", "verification",
          "quote", "reason", "id", "checksum",
        ], `Research support receipt ${index}`);
    const sourceId = identifier(item.sourceId, `Research support receipt ${index} source id`);
    const sourceReceiptId = identifier(item.sourceReceiptId, `Research support receipt ${index} source receipt id`);
    const sourceReceipt = receiptById.get(sourceReceiptId);
    if (!sourceReceipt || sourceReceipt.sourceId !== sourceId
      || (verification === "verified" && sourceReceipt.verification !== "verified")) {
      return fail(`Research support receipt ${index} source receipt is inconsistent`);
    }
    let quote: DecodedResearchSupportReceipt["quote"];
    if (verification === "verified") {
      const location = locatedExcerpt(item.quote, `Research support receipt ${index} quote`);
      const relativeIndex = sourceReceipt.excerpt.text.indexOf(location.text);
      const expectedStart = sourceReceipt.excerpt.utf8Start === null || relativeIndex < 0
        ? null
        : sourceReceipt.excerpt.utf8Start
          + Buffer.byteLength(sourceReceipt.excerpt.text.slice(0, relativeIndex), "utf8");
      if (expectedStart === null || location.utf8Start !== expectedStart) {
        return fail(`Research support receipt ${index} quote location is inconsistent`);
      }
      quote = { ...location };
    } else {
      const rawQuote = exactRecord(item.quote, ["text"], `Research support receipt ${index} quote`);
      if (item.reason !== "quote-not-bound-to-verified-source-excerpt") {
        return fail(`Research support receipt ${index} unverified reason is invalid`);
      }
      quote = {
        text: text(rawQuote.text, `Research support receipt ${index} quote text`, 16_384),
        utf8Start: null,
        utf8End: null,
      };
    }
    const identity = canonicalReceiptIdentity(item, "research-support", `Research support receipt ${index}`);
    if (ids.has(identity.id)) return fail(`Research support receipt ${identity.id} is duplicated`);
    ids.add(identity.id);
    return {
      raw: item,
      ...identity,
      findingId: identifier(item.findingId, `Research support receipt ${index} finding id`),
      statementChecksum: sha256(item.statementChecksum, `Research support receipt ${index} statement checksum`),
      sourceId,
      sourceReceiptId,
      verification,
      quote,
    };
  });
}

function decodeFindings(
  value: unknown,
  sources: ReadonlyMap<string, ResearchRevisionSourceView>,
  supportReceipts: ReadonlyMap<string, DecodedResearchSupportReceipt>,
  expectedVerifier: { id: string; model?: string } | null,
): ResearchRevisionFindingView[] {
  const ids = new Set<string>();
  const claimedSupportReceiptIds = new Set<string>();
  const findings = array(value, "Research findings", 3, 256).map((raw, index) => {
    const finding = exactRecord(raw, [
      "id", "statement", "implication", "confidence", "agentConfidence", "evidenceStatus", "sourceIds",
      "verifiedSourceIds", "unverifiedSourceIds", "supportReceiptIds", "groundedness",
    ], `Research finding ${index}`);
    const id = identifier(finding.id, `Research finding ${index} id`);
    if (ids.has(id)) return fail(`Research finding ${id} is duplicated`);
    ids.add(id);
    const status = evidenceStatus(finding.evidenceStatus, `Research finding ${id} evidence status`);
    const statement = text(finding.statement, `Research finding ${id} statement`);
    const findingConfidence = confidence(finding.confidence, `Research finding ${id} confidence`);
    confidence(finding.agentConfidence, `Research finding ${id} agent confidence`);
    const referencedSources = stringArray(finding.sourceIds, `Research finding ${id} sources`, 1, 64);
    const verifiedSourceIds = stringArray(finding.verifiedSourceIds, `Research finding ${id} verified sources`, 0, 64);
    const unverifiedSourceIds = stringArray(finding.unverifiedSourceIds, `Research finding ${id} unverified sources`, 0, 64);
    const expectedVerifiedSourceIds = referencedSources.filter(
      (sourceId) => sources.get(sourceId)?.verification === "verified",
    );
    const expectedUnverifiedSourceIds = referencedSources.filter(
      (sourceId) => sources.get(sourceId)?.verification === "unverified",
    );
    if (referencedSources.some((sourceId) => !sources.has(sourceId))
      || [...verifiedSourceIds, ...unverifiedSourceIds].some((sourceId) => !referencedSources.includes(sourceId))
      || new Set([...verifiedSourceIds, ...unverifiedSourceIds]).size !== referencedSources.length
      || !sameMembers(verifiedSourceIds, expectedVerifiedSourceIds)
      || !sameMembers(unverifiedSourceIds, expectedUnverifiedSourceIds)) {
      return fail(`Research finding ${id} source evidence is inconsistent`);
    }
    const supportReceiptIds = stringArray(finding.supportReceiptIds, `Research finding ${id} support receipts`, 1, 8);
    const findingSupportReceipts = supportReceiptIds.map((receiptId) => {
      const receipt = supportReceipts.get(receiptId);
      if (!receipt || receipt.findingId !== id || claimedSupportReceiptIds.has(receiptId)) {
        return fail(`Research finding ${id} support receipt identity is inconsistent`);
      }
      claimedSupportReceiptIds.add(receiptId);
      return receipt;
    });
    const expectedSourceIds = [...new Set(findingSupportReceipts.map((receipt) => receipt.sourceId))];
    if (!sameMembers(referencedSources, expectedSourceIds)
      || findingSupportReceipts.some((receipt) => receipt.statementChecksum
        !== createHash("sha256").update(statement).digest("hex"))) {
      return fail(`Research finding ${id} support receipt evidence is inconsistent`);
    }
    const groundedness = exactRecord(finding.groundedness, [
      "verified", "verifier", "rationale", "supportReceiptIds",
    ], `Research finding ${id} groundedness`);
    if (typeof groundedness.verified !== "boolean" || groundedness.verified !== (status === "evidence")) {
      return fail(`Research finding ${id} groundedness does not match its evidence status`);
    }
    const findingVerifier = verifier(groundedness.verifier, `Research finding ${id} verifier`);
    const groundedSupportReceiptIds = stringArray(
      groundedness.supportReceiptIds,
      `Research finding ${id} grounded support receipts`,
      0,
      8,
    );
    const verifiedSupportReceiptIds = findingSupportReceipts
      .filter((receipt) => receipt.verification === "verified")
      .map((receipt) => receipt.id);
    if (!sameVerifier(findingVerifier, expectedVerifier)
      || groundedSupportReceiptIds.some((receiptId) => !verifiedSupportReceiptIds.includes(receiptId))
      || (status === "evidence" && (findingVerifier === null
        || groundedSupportReceiptIds.length === 0))
      || (status === "hypothesis" && findingConfidence !== "low")) {
      return fail(`Research finding ${id} quality evidence is inconsistent`);
    }
    return {
      id,
      statement,
      implication: text(finding.implication, `Research finding ${id} implication`),
      confidence: findingConfidence,
      evidenceStatus: status,
      sourceIds: referencedSources,
      verifiedSourceIds,
      unverifiedSourceIds,
      supportReceiptIds,
      groundedness: {
        verified: groundedness.verified,
        verifier: findingVerifier,
        rationale: text(groundedness.rationale, `Research finding ${id} groundedness rationale`, 8_192),
        supportReceiptIds: groundedSupportReceiptIds,
      },
    };
  });
  if (!sameMembers([...claimedSupportReceiptIds], [...supportReceipts.keys()])) {
    return fail("Research support receipts do not cover every finding support exactly once");
  }
  return findings;
}

function validateResearchEvidenceSelectorAgainstBundle(input: {
  selector: DecodedResearchEvidenceSelectorProvenance | null;
  receipts: readonly DecodedResearchReceipt[];
  supportReceipts: readonly DecodedResearchSupportReceipt[];
  findings: readonly ResearchRevisionFindingView[];
}): void {
  if (input.selector === null) return;
  const receiptBySourceId = new Map(
    input.receipts.map((receipt) => [receipt.sourceId, receipt] as const),
  );
  const supportReceiptById = new Map(
    input.supportReceipts.map((receipt) => [receipt.id, receipt] as const),
  );
  const findingById = new Map(
    input.findings.map((finding) => [finding.id, finding] as const),
  );
  const decisionByKey = new Map(
    input.selector.decisions.map((decision) => [
      researchEvidenceSelectionDecisionKey(decision),
      decision,
    ] as const),
  );
  for (const catalogSource of input.selector.catalog.sources) {
    const sourceReceipt = receiptBySourceId.get(catalogSource.sourceId);
    for (const query of catalogSource.queries) {
      const finding = findingById.get(query.findingId);
      const supportReceiptId = finding?.supportReceiptIds[query.supportIndex];
      const supportReceipt = supportReceiptId === undefined
        ? undefined
        : supportReceiptById.get(supportReceiptId);
      const decision = decisionByKey.get(researchEvidenceSelectionDecisionKey({
        ...query,
        sourceId: catalogSource.sourceId,
      }));
      if (finding === undefined || finding.statement !== query.statement
        || supportReceipt === undefined
        || supportReceipt.sourceId !== catalogSource.sourceId
        || decision === undefined) {
        return fail("Research evidence selector query is not bound to its exact finding support");
      }
      if (decision.selectedSpanId === null) {
        if (supportReceipt.verification !== "unverified") {
          return fail("Research evidence selector rejection is inconsistent with its support receipt");
        }
        continue;
      }
      if (sourceReceipt?.verification === "verified") {
        const selectedSpan = catalogSource.spans.find(
          (span) => span.spanId === decision.selectedSpanId,
        );
        if (selectedSpan === undefined || supportReceipt.verification !== "verified"
          || supportReceipt.quote.text !== selectedSpan.text) {
          return fail("Research evidence selector selection is inconsistent with its support receipt");
        }
      } else if (supportReceipt.verification !== "unverified") {
        return fail("Invalid Research evidence selector binding promoted a verified support receipt");
      }
    }
  }
}

function evidenceReferences(
  item: Record<string, unknown>,
  label: string,
  findings: ReadonlyMap<string, ResearchRevisionFindingView>,
): {
  findingIds: string[];
  evidenceFindingIds: string[];
  hypothesisFindingIds: string[];
  evidenceStatus: ResearchEvidenceStatus;
} {
  const findingIds = stringArray(item.findingIds, `${label} findings`, 1, 64);
  const evidenceFindingIds = stringArray(item.evidenceFindingIds, `${label} evidence findings`, 0, 64);
  const hypothesisFindingIds = stringArray(item.hypothesisFindingIds, `${label} hypothesis findings`, 0, 64);
  if (findingIds.some((id) => !findings.has(id))
    || evidenceFindingIds.some((id) => findings.get(id)?.evidenceStatus !== "evidence")
    || hypothesisFindingIds.some((id) => findings.get(id)?.evidenceStatus !== "hypothesis")
    || new Set([...evidenceFindingIds, ...hypothesisFindingIds]).size !== findingIds.length
    || findingIds.some((id) => !evidenceFindingIds.includes(id) && !hypothesisFindingIds.includes(id))) {
    return fail(`${label} finding evidence is inconsistent`);
  }
  const status = evidenceStatus(item.evidenceStatus, `${label} evidence status`);
  if ((status === "evidence") !== (hypothesisFindingIds.length === 0)) {
    return fail(`${label} evidence status is inconsistent`);
  }
  return { findingIds, evidenceFindingIds, hypothesisFindingIds, evidenceStatus: status };
}

function decodePrinciples(
  value: unknown,
  findings: ReadonlyMap<string, ResearchRevisionFindingView>,
): ResearchRevisionPrincipleView[] {
  const ids = new Set<string>();
  return array(value, "Research design principles", 3, 128).map((raw, index) => {
    const principle = exactRecord(raw, [
      "id", "title", "rationale", "findingIds", "evidenceStatus", "evidenceFindingIds", "hypothesisFindingIds",
    ], `Research principle ${index}`);
    const id = identifier(principle.id, `Research principle ${index} id`);
    if (ids.has(id)) return fail(`Research principle ${id} is duplicated`);
    ids.add(id);
    return {
      id,
      title: text(principle.title, `Research principle ${id} title`),
      rationale: text(principle.rationale, `Research principle ${id} rationale`),
      ...evidenceReferences(principle, `Research principle ${id}`, findings),
    };
  });
}

function decodeDirections(
  value: unknown,
  findings: ReadonlyMap<string, ResearchRevisionFindingView>,
): ResearchRevisionDirectionView[] {
  const ids = new Set<string>();
  return array(value, "Research directions", 2, 16).map((raw, index) => {
    const direction = exactRecord(raw, [
      "id", "title", "thesis", "visualLanguage", "interactionPrinciples", "risks", "findingIds",
      "evidenceStatus", "evidenceFindingIds", "hypothesisFindingIds",
    ], `Research direction ${index}`);
    const id = identifier(direction.id, `Research direction ${index} id`);
    if (ids.has(id)) return fail(`Research direction ${id} is duplicated`);
    ids.add(id);
    return {
      id,
      title: text(direction.title, `Research direction ${id} title`),
      thesis: text(direction.thesis, `Research direction ${id} thesis`),
      visualLanguage: stringArray(direction.visualLanguage, `Research direction ${id} visual language`, 1, 16),
      interactionPrinciples: stringArray(direction.interactionPrinciples, `Research direction ${id} interaction principles`, 1, 16),
      risks: stringArray(direction.risks, `Research direction ${id} risks`, 1, 16),
      ...evidenceReferences(direction, `Research direction ${id}`, findings),
    };
  });
}

interface ResearchBundleScope {
  taskId: string;
  planId: string;
  attempt: number;
  inputHash: string;
  workspaceId: string;
  resourceId: string;
  parentRevisionId: string | null;
  contextPackId: string;
  operation: "create" | "revise";
  nodeId: string;
  title: string;
  resourceKind: "research";
}

export interface ResearchRevisionTaskAuthority {
  readonly operation: "create" | "revise";
  readonly nodeId: string;
  readonly title: string;
  readonly brief: {
    readonly proposalRationale: string;
    readonly assumptions: readonly string[];
    readonly targetInstructions: {
      readonly operation: "create" | "revise";
      readonly kind: "research";
      readonly title: string;
      readonly instructions?: string;
    };
  };
}

function decodeBundleScope(
  value: unknown,
  owner: {
    workspaceId: string;
    resourceId: string;
    parentRevisionId: string | null;
    taskAuthority?: ResearchRevisionTaskAuthority;
  },
): ResearchBundleScope {
  const scope = exactRecord(value, [
    "taskId", "planId", "attempt", "inputHash", "workspaceId", "resourceId", "parentRevisionId",
    "contextPackId", "operation", "nodeId", "title", "resourceKind",
  ], "Research Revision scope");
  if (scope.workspaceId !== owner.workspaceId || scope.resourceId !== owner.resourceId
    || scope.parentRevisionId !== owner.parentRevisionId || scope.resourceKind !== "research"
    || (scope.operation !== "create" && scope.operation !== "revise")) {
    return fail("Research Revision payload scope does not match its immutable owner");
  }
  const decoded: ResearchBundleScope = {
    taskId: identifier(scope.taskId, "Research scope Task id"),
    planId: identifier(scope.planId, "Research scope Plan id"),
    attempt: safeInteger(scope.attempt, "Research scope Attempt", 1),
    inputHash: sha256(scope.inputHash, "Research scope input hash"),
    workspaceId: owner.workspaceId,
    resourceId: owner.resourceId,
    parentRevisionId: owner.parentRevisionId,
    contextPackId: identifier(scope.contextPackId, "Research scope Context Pack id"),
    operation: scope.operation,
    nodeId: identifier(scope.nodeId, "Research scope node id"),
    title: text(scope.title, "Research scope title", 4_096),
    resourceKind: "research",
  };
  if (owner.taskAuthority !== undefined
    && (decoded.operation !== owner.taskAuthority.operation
      || decoded.nodeId !== owner.taskAuthority.nodeId
      || decoded.title !== owner.taskAuthority.title)) {
    return fail("Research Revision payload scope substituted its frozen Task target");
  }
  return decoded;
}

function decodeBundleContextPack(
  value: unknown,
  scope: ResearchBundleScope,
  authority: ContextPack | null,
): ResearchBundleContextPack {
  const contextPack = exactRecord(value, ["id", "hash", "graphRevision"], "Research Context Pack identity");
  const decoded = {
    id: identifier(contextPack.id, "Research Context Pack id"),
    hash: sha256(contextPack.hash, "Research Context Pack hash"),
    graphRevision: safeInteger(contextPack.graphRevision, "Research Context Pack graph revision"),
  };
  if (decoded.id !== scope.contextPackId) return fail("Research Context Pack identity is inconsistent");
  if (authority === null
    || authority.id !== decoded.id
    || authority.workspaceId !== scope.workspaceId
    || authority.hash !== decoded.hash
    || authority.graphRevision !== decoded.graphRevision) {
    return fail("Research Context Pack identity is not anchored to its immutable authority");
  }
  return decoded;
}

function validateResearchBrief(
  value: unknown,
  scope: ResearchBundleScope,
  authority?: ResearchRevisionTaskAuthority,
): void {
  const brief = exactRecord(value, ["proposalRationale", "assumptions", "targetInstructions"], "Research brief");
  const proposalRationale = text(brief.proposalRationale, "Research brief rationale", 32_000);
  const assumptions = stringArray(brief.assumptions, "Research brief assumptions", 0, 64);
  const target = exactRecord(
    brief.targetInstructions,
    ["operation", "kind", "title"],
    "Research brief target instructions",
    ["instructions"],
  );
  if (target.operation !== scope.operation || target.kind !== "research" || target.title !== scope.title) {
    return fail("Research brief substituted its exact Task target");
  }
  const instructions = target.instructions === undefined
    ? undefined
    : text(target.instructions, "Research brief target instructions brief", 2_000);
  if (instructions !== undefined && Buffer.byteLength(instructions, "utf8") > 2_000) {
    return fail("Research brief target instructions brief exceeds its UTF-8 byte limit");
  }
  const expectedTarget = authority?.brief.targetInstructions;
  if (authority !== undefined
    && (proposalRationale !== authority.brief.proposalRationale
      || assumptions.length !== authority.brief.assumptions.length
      || assumptions.some((assumption, index) => assumption !== authority.brief.assumptions[index])
      || expectedTarget === undefined
      || target.operation !== expectedTarget.operation
      || target.kind !== expectedTarget.kind
      || target.title !== expectedTarget.title
      || instructions !== expectedTarget.instructions)) {
    return fail("Research brief substituted its frozen Task authority");
  }
}

function decodeResearchProvenance(input: {
  provenance: Record<string, unknown>;
  scope: ResearchBundleScope;
  contextPack: ResearchBundleContextPack;
  receipts: readonly DecodedResearchReceipt[];
  supportReceipts: readonly DecodedResearchSupportReceipt[];
  repairAuthority: DecodedResearchRepairAuthority | null;
}): {
  verifier: { id: string; model?: string } | null;
  evidenceSelector: DecodedResearchEvidenceSelectorProvenance | null;
  repair: DecodedResearchRepairProvenance | null;
} {
  const outer = record(input.provenance, "Research Revision provenance");
  const adapter = exactRecord(outer.adapter, ["id", "version", "kind"], "Research adapter provenance identity");
  if (outer.kind !== "generation-task-resource"
    || outer.planId !== input.scope.planId || outer.taskId !== input.scope.taskId
    || outer.attempt !== input.scope.attempt || outer.inputHash !== input.scope.inputHash
    || adapter.id !== "dezin.resource-adapter.research" || adapter.version !== 1 || adapter.kind !== "research") {
    return fail("Research Revision outer provenance is inconsistent");
  }
  const production = exactRecord(outer.adapterProvenance, [
    "protocol", "taskId", "attempt", "inputHash", "contextPackId", "contextPackHash", "generatorId",
    "researchEvidence",
  ], "Research production provenance", ["model", "researchRepair"]);
  if (production.protocol !== "dezin.production-resource-generation.v1"
    || production.taskId !== input.scope.taskId || production.attempt !== input.scope.attempt
    || production.inputHash !== input.scope.inputHash || production.contextPackId !== input.contextPack.id
    || production.contextPackHash !== input.contextPack.hash) {
    return fail("Research production provenance is inconsistent");
  }
  const generator = {
    id: identifier(production.generatorId, "Research generator id"),
    ...(production.model === undefined
      ? {}
      : { model: text(production.model, "Research generator model", 512) }),
  };
  const evidence = exactResearchEvidenceProvenance(production.researchEvidence);
  const evidenceSelector = evidence.protocol === "dezin.research-evidence-provenance.v3"
    ? researchEvidenceSelectorProvenance(evidence.evidenceSelector, input.scope)
    : null;
  const groundednessVerifier = verifier(
    evidence.groundednessVerifier,
    "Research provenance groundedness verifier",
  );
  if (evidence.protocol === "dezin.research-evidence-provenance.v3"
    && ((evidenceSelector !== null && evidenceSelector.id === generator.id)
      || (groundednessVerifier !== null && groundednessVerifier.id === generator.id)
      || (evidenceSelector !== null && groundednessVerifier !== null
        && !sameVerifier(evidenceSelector, groundednessVerifier)))) {
    return fail(
      "Research evidence selector and groundedness verifier must bind one independent reviewer principal",
    );
  }
  const selectorBindingFailures = input.receipts.flatMap((receipt) => {
    const reason = receipt.raw.reason;
    return receipt.sourceKind === "web"
      && receipt.verification === "unverified"
      && typeof reason === "string"
      && RESEARCH_SELECTOR_BINDING_FAILURE_REASONS.has(reason)
      ? [{ sourceId: receipt.sourceId, reason }]
      : [];
  });
  const selectorCatalogSourceIds = new Set(
    evidenceSelector?.catalog.sources.map((source) => source.sourceId) ?? [],
  );
  const selectorSelectedSpanBySource = new Map<string, string>();
  for (const decision of evidenceSelector?.decisions ?? []) {
    if (decision.selectedSpanId !== null) {
      selectorSelectedSpanBySource.set(decision.sourceId, decision.selectedSpanId);
    }
  }
  const selectorSelectedSourceIds = new Set(selectorSelectedSpanBySource.keys());
  const receiptBySourceId = new Map(
    input.receipts.map((receipt) => [receipt.sourceId, receipt] as const),
  );
  const selectorBindingFailureMatchesAuthority = (
    sourceId: string,
    reason: string,
  ): boolean => {
    if (evidence.protocol !== "dezin.research-evidence-provenance.v3") return false;
    if (evidenceSelector === null) return reason === "binding-unavailable";
    const sourceInCatalog = selectorCatalogSourceIds.has(sourceId);
    const sourceHasSelection = selectorSelectedSourceIds.has(sourceId);
    if (reason === "binding-unavailable") return !sourceInCatalog;
    if (reason === "binding-rejected") return sourceInCatalog && !sourceHasSelection;
    return reason === "binding-invalid" && sourceInCatalog && sourceHasSelection;
  };
  const selectorCatalogReceiptsMatchDecisions = evidenceSelector === null
    || evidenceSelector.catalog.sources.every((catalogSource) => {
      const { sourceId } = catalogSource;
      const receipt = receiptBySourceId.get(sourceId);
      if (receipt?.sourceKind !== "web") return false;
      const reason = receipt.raw.reason;
      if (selectorSelectedSourceIds.has(sourceId)) {
        if (receipt.verification === "unverified") return reason === "binding-invalid";
        const selectedSpanId = selectorSelectedSpanBySource.get(sourceId);
        const selectedSpan = catalogSource.spans.find((span) => span.spanId === selectedSpanId);
        const requestedUrl = receipt.raw.requestedUrl;
        if (receipt.raw.protocol !== "dezin.research-evidence-receipt.v2"
          || selectedSpan === undefined || typeof requestedUrl !== "string"
          || receipt.canonicalUrl === null || receipt.canonicalTextChecksum === null
          || receipt.excerpt.utf8Start === null || receipt.excerpt.utf8End === null
          || selectedSpan.text !== receipt.excerpt.text) {
          return false;
        }
        const expectedSpanId = `research-evidence-span-${createHash("sha256")
          .update(stableStringify({
            protocol: "dezin.research-evidence-span.v1",
            scope: input.scope,
            sourceId,
            requestedUrl,
            canonicalUrl: receipt.canonicalUrl,
            canonicalTextChecksum: receipt.canonicalTextChecksum,
            utf8Start: receipt.excerpt.utf8Start,
            utf8End: receipt.excerpt.utf8End,
            textChecksum: createHash("sha256").update(selectedSpan.text).digest("hex"),
          }))
          .digest("hex")}`;
        return selectedSpan.spanId === expectedSpanId;
      }
      return receipt.verification === "unverified" && reason === "binding-rejected";
    });
  if (selectorBindingFailures.some(({ sourceId, reason }) =>
      !selectorBindingFailureMatchesAuthority(sourceId, reason))
    || !selectorCatalogReceiptsMatchDecisions) {
    return fail("Research evidence selector binding provenance is inconsistent");
  }
  const receiptIds = stringArray(evidence.receiptIds, "Research provenance receipt ids", input.receipts.length, input.receipts.length);
  const supportReceiptIds = stringArray(
    evidence.supportReceiptIds,
    "Research provenance support receipt ids",
    input.supportReceipts.length,
    input.supportReceipts.length,
  );
  if (!sameMembers(receiptIds, input.receipts.map((receipt) => receipt.id))
    || !sameMembers(supportReceiptIds, input.supportReceipts.map((receipt) => receipt.id))) {
    return fail("Research evidence provenance receipt identities are inconsistent");
  }
  safeInteger(evidence.verifiedSourceCount, "Research provenance verified source count");
  safeInteger(evidence.unverifiedSourceCount, "Research provenance unverified source count");
  safeInteger(evidence.evidenceFindingCount, "Research provenance evidence finding count");
  safeInteger(evidence.hypothesisFindingCount, "Research provenance hypothesis finding count");
  const repair = production.researchRepair === undefined
    ? null
    : decodeResearchRepairProvenance(production.researchRepair, input.repairAuthority);
  if ((repair === null) !== (input.repairAuthority === null)) {
    return fail("Research immutable payload repair authority does not match repair provenance");
  }
  return {
    verifier: groundednessVerifier,
    evidenceSelector,
    repair,
  };
}

function requiredMetadataCount(value: unknown, label: string, expected: number): void {
  if (safeInteger(value, label) !== expected) return fail(`${label} does not match the immutable payload`);
}

function decisionGradeVerifiedWebSourceCount(
  receipts: readonly DecodedResearchReceipt[],
  selectedSourceIds: ReadonlySet<string>,
): number {
  const identities: Array<{
    canonicalUrl: string;
    canonicalTextChecksum: string;
  }> = [];
  for (const receipt of receipts) {
    if (receipt.sourceKind !== "web" || receipt.verification !== "verified"
      || !selectedSourceIds.has(receipt.sourceId)
      || receipt.canonicalUrl === null || receipt.canonicalTextChecksum === null) {
      continue;
    }
    identities.push({
      canonicalUrl: receipt.canonicalUrl,
      canonicalTextChecksum: receipt.canonicalTextChecksum,
    });
  }
  return countCanonicalResearchEvidenceComponents(identities);
}

function validateResearchMetadata(input: {
  metadata: Record<string, unknown>;
  sources: readonly ResearchRevisionSourceView[];
  receipts: readonly DecodedResearchReceipt[];
  supportReceipts: readonly DecodedResearchSupportReceipt[];
  findings: readonly ResearchRevisionFindingView[];
  designPrinciples: readonly ResearchRevisionPrincipleView[];
  directions: readonly ResearchRevisionDirectionView[];
  verifier: { id: string; model?: string } | null;
  bundleVersion: 3 | 4;
}): ResearchRevisionQualityState {
  const adapter = exactRecord(input.metadata.adapter, [
    "format", "version", "qualityState", "requiresHypothesisConfirmation", "groundednessVerifierAvailable",
    "sourceCount", "verifiedSourceCount", "unverifiedSourceCount", "supportReceiptCount", "findingCount",
    "evidenceFindingCount", "hypothesisFindingCount", "principleCount", "directionCount", "evidenceDirectionCount",
    "hypothesisDirectionCount",
  ], "Research Revision adapter metadata", ["decisionGradeGate"]);
  const evidenceFindingCount = input.findings.filter((finding) => finding.evidenceStatus === "evidence").length;
  const evidenceDirectionCount = input.directions.filter((direction) => direction.evidenceStatus === "evidence").length;
  const verifiedSourceCount = input.sources.filter((source) => source.verification === "verified").length;
  const requiresDecisionGradeGate = input.receipts.some((receipt) =>
    receipt.sourceKind === "web"
      && receipt.raw.protocol === "dezin.research-evidence-receipt.v2");
  if (requiresDecisionGradeGate && adapter.decisionGradeGate === undefined) {
    return fail("Research decision-grade gate is required for Web v2 evidence");
  }
  let expectedQuality: ResearchRevisionQualityState = evidenceDirectionCount > 0 ? "grounded" : "needs-review";
  if (adapter.decisionGradeGate !== undefined) {
    const gate = exactRecord(adapter.decisionGradeGate, [
      "protocol", "criteria", "observed", "accepted", "blockers",
    ], "Research decision-grade gate");
    const criteria = exactRecord(gate.criteria, [
      "minimumVerifiedWebSourceCount", "minimumEvidenceFindingCount", "minimumEvidenceDirectionCount",
      "requiresGroundednessVerifier",
    ], "Research decision-grade gate criteria");
    const observed = exactRecord(gate.observed, [
      "verifiedWebSourceCount", "evidenceFindingCount", "evidenceDirectionCount", "groundednessVerifierAvailable",
    ], "Research decision-grade gate observation");
    const decisionGradeSupportReceiptIds = new Set(input.findings
      .filter((finding) => finding.evidenceStatus === "evidence")
      .flatMap((finding) => finding.groundedness.supportReceiptIds));
    const decisionGradeSourceIds = new Set(input.supportReceipts
      .filter((receipt) => decisionGradeSupportReceiptIds.has(receipt.id))
      .map((receipt) => receipt.sourceId));
    const verifiedWebSourceCount = decisionGradeVerifiedWebSourceCount(
      input.receipts,
      decisionGradeSourceIds,
    );
    const supportReceiptById = new Map(
      input.supportReceipts.map((receipt) => [receipt.id, receipt]),
    );
    const evidenceFindingById = new Map(input.findings
      .filter((finding) => finding.evidenceStatus === "evidence")
      .map((finding) => [finding.id, finding]));
    const decisionGradeEvidenceDirectionCount = input.directions.filter((direction) => {
      if (direction.evidenceStatus !== "evidence") return false;
      const findingIds = [...new Set(direction.findingIds.filter(
        (findingId) => evidenceFindingById.has(findingId),
      ))];
      const supportReceiptIds = new Set(findingIds.flatMap(
        (findingId) => evidenceFindingById.get(findingId)!.groundedness.supportReceiptIds,
      ));
      const sourceIds = new Set([...supportReceiptIds].flatMap((receiptId) => {
        const receipt = supportReceiptById.get(receiptId);
        return receipt === undefined ? [] : [receipt.sourceId];
      }));
      return findingIds.length >= 2
        && decisionGradeVerifiedWebSourceCount(input.receipts, sourceIds) >= 2;
    }).length;
    const gateUsesDirectionLocalCoverage =
      gate.protocol === "dezin.research-decision-grade-gate.v2";
    if (!gateUsesDirectionLocalCoverage
      && gate.protocol !== "dezin.research-decision-grade-gate.v1") {
      return fail("Research decision-grade gate protocol is unsupported");
    }
    const decisionGradeDirectionCount = gateUsesDirectionLocalCoverage
      ? decisionGradeEvidenceDirectionCount
      : evidenceDirectionCount;
    const expectedBlockers = [
      ...(input.verifier === null ? ["groundedness-verifier-unavailable"] : []),
      ...(verifiedWebSourceCount < 2 ? ["insufficient-verified-web-sources"] : []),
      ...(evidenceFindingCount < 2 ? ["insufficient-evidence-findings"] : []),
      ...(decisionGradeDirectionCount < 1 ? ["insufficient-evidence-directions"] : []),
    ];
    const blockers = stringArray(gate.blockers, "Research decision-grade gate blockers", 0, 4);
    if (criteria.minimumVerifiedWebSourceCount !== 2
      || criteria.minimumEvidenceFindingCount !== 2
      || criteria.minimumEvidenceDirectionCount !== 1
      || criteria.requiresGroundednessVerifier !== true
      || observed.verifiedWebSourceCount !== verifiedWebSourceCount
      || observed.evidenceFindingCount !== evidenceFindingCount
      || observed.evidenceDirectionCount !== decisionGradeDirectionCount
      || observed.groundednessVerifierAvailable !== (input.verifier !== null)
      || gate.accepted !== (expectedBlockers.length === 0)
      || blockers.length !== new Set(blockers).size
      || blockers.some((blocker, index) => blocker !== expectedBlockers[index])) {
      return fail("Research decision-grade gate is inconsistent");
    }
    expectedQuality = expectedBlockers.length === 0 ? "grounded" : "needs-review";
  }
  if (adapter.format !== "dezin-research-resource-bundle" || adapter.version !== input.bundleVersion
    || adapter.qualityState !== expectedQuality
    || typeof adapter.requiresHypothesisConfirmation !== "boolean"
    || adapter.requiresHypothesisConfirmation !== (evidenceDirectionCount !== input.directions.length)
    || typeof adapter.groundednessVerifierAvailable !== "boolean"
    || adapter.groundednessVerifierAvailable !== (input.verifier !== null)) {
    return fail("Research Revision quality metadata is inconsistent");
  }
  const counts: Array<[unknown, number, string]> = [
    [adapter.sourceCount, input.sources.length, "Research source count"],
    [adapter.verifiedSourceCount, verifiedSourceCount, "Research verified source count"],
    [adapter.unverifiedSourceCount, input.sources.length - verifiedSourceCount, "Research unverified source count"],
    [adapter.supportReceiptCount, input.supportReceipts.length, "Research support receipt count"],
    [adapter.findingCount, input.findings.length, "Research finding count"],
    [adapter.evidenceFindingCount, evidenceFindingCount, "Research evidence finding count"],
    [adapter.hypothesisFindingCount, input.findings.length - evidenceFindingCount, "Research hypothesis finding count"],
    [adapter.principleCount, input.designPrinciples.length, "Research principle count"],
    [adapter.directionCount, input.directions.length, "Research direction count"],
    [adapter.evidenceDirectionCount, evidenceDirectionCount, "Research evidence direction count"],
    [adapter.hypothesisDirectionCount, input.directions.length - evidenceDirectionCount, "Research hypothesis direction count"],
  ];
  for (const [value, expected, label] of counts) requiredMetadataCount(value, label, expected);
  return expectedQuality;
}

export interface ResearchRevisionPayloadValidationInput {
  readonly bytes: Buffer;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly parentRevisionId: string | null;
  readonly revisionMetadata: Record<string, unknown>;
  readonly revisionProvenance: Record<string, unknown>;
  /** Exact daemon Context Pack reconstructed from its immutable manifest and Core row. */
  readonly contextPack: ContextPack | null;
  /** Exact frozen Task semantics supplied by the leased Attempt authority when validating generation output. */
  readonly taskAuthority?: ResearchRevisionTaskAuthority;
}

export interface ResearchRevisionDirectionSelectionInput extends ResearchRevisionPayloadValidationInput {
  readonly directionId: string;
}

export function researchRevisionContextPackId(provenance: Record<string, unknown>): string | null {
  try {
    const outer = record(provenance, "Research Revision provenance");
    const production = record(outer.adapterProvenance, "Research production provenance");
    return identifier(production.contextPackId, "Research production Context Pack id");
  } catch (error) {
    if (error instanceof ResearchResourceRevisionError) return null;
    throw error;
  }
}

function selectLegacyResearchRevisionDirection(
  input: ResearchRevisionDirectionSelectionInput,
  bundle: Record<string, unknown>,
): ResearchRevisionDirectionView {
  if (bundle.version !== 1 && bundle.version !== 2) {
    return fail("Research Revision payload protocol is unsupported");
  }
  const scope = record(bundle.scope, "Legacy Research Revision scope");
  if (scope.workspaceId !== input.workspaceId || scope.resourceId !== input.resourceId) {
    return fail("Legacy Research Revision payload scope does not match its immutable owner");
  }
  const directionId = identifier(input.directionId, "Research direction selection id");
  const matches = array(bundle.directions, "Legacy Research directions", 1, 16)
    .map((value, index): ResearchRevisionDirectionView => {
      const baseFields = [
        "id", "title", "thesis", "visualLanguage", "interactionPrinciples", "risks", "findingIds",
      ];
      const direction = exactRecord(
        value,
        bundle.version === 1
          ? baseFields
          : [...baseFields, "evidenceStatus", "evidenceFindingIds", "hypothesisFindingIds"],
        `Legacy Research direction ${index}`,
      );
      const id = identifier(direction.id, `Legacy Research direction ${index} id`);
      const findingIds = stringArray(direction.findingIds, `Legacy Research direction ${id} findings`, 1, 32);
      if (bundle.version === 2) {
        const evidenceFindingIds = stringArray(
          direction.evidenceFindingIds,
          `Legacy Research direction ${id} evidence findings`,
          0,
          32,
        );
        const hypothesisFindingIds = stringArray(
          direction.hypothesisFindingIds,
          `Legacy Research direction ${id} hypothesis findings`,
          0,
          32,
        );
        const partition = [...evidenceFindingIds, ...hypothesisFindingIds];
        const status = evidenceStatus(direction.evidenceStatus, `Legacy Research direction ${id} evidence status`);
        if (partition.length !== findingIds.length
          || new Set(partition).size !== partition.length
          || partition.some((findingId) => !findingIds.includes(findingId))
          || (status === "evidence") !== (hypothesisFindingIds.length === 0)) {
          return fail(`Legacy Research direction ${id} evidence is inconsistent`);
        }
      }
      // Legacy bundles predate canonical receipts and groundedness attestations.
      // Keep the selected design direction usable for queued/retry work, but
      // never carry a legacy self-asserted evidence label across the v3 trust boundary.
      return {
        id,
        title: text(direction.title, `Legacy Research direction ${id} title`),
        thesis: text(direction.thesis, `Legacy Research direction ${id} thesis`),
        visualLanguage: stringArray(
          direction.visualLanguage,
          `Legacy Research direction ${id} visual language`,
          1,
          16,
        ),
        interactionPrinciples: stringArray(
          direction.interactionPrinciples,
          `Legacy Research direction ${id} interaction principles`,
          1,
          16,
        ),
        risks: stringArray(direction.risks, `Legacy Research direction ${id} risks`, 1, 16),
        findingIds,
        evidenceStatus: "hypothesis",
        evidenceFindingIds: [],
        hypothesisFindingIds: findingIds,
      };
    })
    .filter((direction) => direction.id === directionId);
  if (matches.length !== 1) {
    return fail("Chosen Research direction is missing or ambiguous in its pinned Revision");
  }
  return matches[0]!;
}

function decodeResearchBundle(
  input: ResearchRevisionPayloadValidationInput,
): Omit<ResearchResourceRevisionView, "protocol" | "resource" | "revision" | "observed"> {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_RESEARCH_VIEW_BYTES) {
    return fail("Research Revision payload exceeds the Viewer bound");
  }
  const parsed = parseResearchJson(input.bytes);
  const envelope = record(parsed, "Research Revision payload");
  if (envelope.format !== "dezin-research-resource-bundle"
    || (envelope.version !== 3 && envelope.version !== 4)) {
    return fail("Research Revision payload protocol is unsupported");
  }
  const bundleVersion: 3 | 4 = envelope.version;
  const baseFields = [
    "format", "version", "scope", "contextPack", "brief", "executiveSummary", "sources", "receipts",
    "supportReceipts", "findings", "designPrinciples", "directions", "openQuestions",
  ];
  const bundle = exactRecord(
    parsed,
    bundleVersion === 4 ? [...baseFields, "repairAuthority"] : baseFields,
    "Research Revision payload",
  );
  const repairAuthority = bundleVersion === 4
    ? decodeResearchRepairAuthority(bundle.repairAuthority)
    : null;
  const scope = decodeBundleScope(bundle.scope, input);
  const contextPack = decodeBundleContextPack(bundle.contextPack, scope, input.contextPack);
  validateResearchBrief(bundle.brief, scope, input.taskAuthority);
  const decodedSources = decodeSources(bundle.sources, contextPack, input.contextPack!);
  const sources = decodedSources.map((source) => source.view);
  const receipts = decodeReceipts(bundle.receipts, decodedSources, contextPack, input.contextPack!);
  const supportReceipts = decodeSupportReceipts(bundle.supportReceipts, receipts);
  const decodedProvenance = decodeResearchProvenance({
    provenance: input.revisionProvenance,
    scope,
    contextPack,
    receipts,
    supportReceipts,
    repairAuthority,
  });
  const groundednessVerifier = decodedProvenance.verifier;
  const findings = decodeFindings(
    bundle.findings,
    new Map(sources.map((source) => [source.id, source])),
    new Map(supportReceipts.map((receipt) => [receipt.id, receipt])),
    groundednessVerifier,
  );
  validateResearchEvidenceSelectorAgainstBundle({
    selector: decodedProvenance.evidenceSelector,
    receipts,
    supportReceipts,
    findings,
  });
  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  const designPrinciples = decodePrinciples(bundle.designPrinciples, findingsById);
  const directions = decodeDirections(bundle.directions, findingsById);
  const evidenceDirectionCount = directions.filter((direction) => direction.evidenceStatus === "evidence").length;
  const hypothesisDirectionCount = directions.length - evidenceDirectionCount;
  const qualityState = validateResearchMetadata({
    metadata: input.revisionMetadata,
    sources,
    receipts,
    supportReceipts,
    findings,
    designPrinciples,
    directions,
    verifier: groundednessVerifier,
    bundleVersion,
  });
  if (decodedProvenance.repair !== null) {
    validateResearchRepairAgainstImmutableRevision({
      repair: decodedProvenance.repair,
      findings,
      directions,
      qualityState,
    });
  }
  const productionProvenance = record(input.revisionProvenance.adapterProvenance, "Research production provenance");
  const provenance = exactResearchEvidenceProvenance(
    productionProvenance.researchEvidence,
  );
  const verifiedSourceCount = sources.filter((source) => source.verification === "verified").length;
  const evidenceFindingCount = findings.filter((finding) => finding.evidenceStatus === "evidence").length;
  if (provenance.verifiedSourceCount !== verifiedSourceCount
    || provenance.unverifiedSourceCount !== sources.length - verifiedSourceCount
    || provenance.evidenceFindingCount !== evidenceFindingCount
    || provenance.hypothesisFindingCount !== findings.length - evidenceFindingCount) {
    return fail("Research evidence provenance counts are inconsistent");
  }
  return {
    qualityState,
    evidenceDirectionCount,
    hypothesisDirectionCount,
    executiveSummary: text(bundle.executiveSummary, "Research executive summary", 32_000),
    sources,
    findings,
    designPrinciples,
    directions,
    openQuestions: stringArray(bundle.openQuestions, "Research open questions", 0, 64),
  };
}

/**
 * Validates the complete canonical Research v3 payload, metadata, provenance,
 * receipts, findings, and evidence partitions before exposing one direction.
 */
export function listResearchRevisionDirections(
  input: ResearchRevisionPayloadValidationInput,
): readonly ResearchRevisionDirectionView[] {
  const content = decodeResearchBundle(input);
  return Object.freeze(content.directions.map((direction) =>
    Object.freeze(structuredClone(direction))));
}

export function selectResearchRevisionDirection(
  input: ResearchRevisionDirectionSelectionInput,
): ResearchRevisionDirectionView {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_RESEARCH_VIEW_BYTES) {
    return fail("Research Revision payload exceeds the Viewer bound");
  }
  const envelope = record(parseResearchJson(input.bytes), "Research Revision payload");
  if (envelope.format !== "dezin-research-resource-bundle") {
    return fail("Research Revision payload protocol is unsupported");
  }
  if (envelope.version === 1 || envelope.version === 2) {
    return selectLegacyResearchRevisionDirection(input, envelope);
  }
  const directionId = identifier(input.directionId, "Research direction selection id");
  const matches = listResearchRevisionDirections(input).filter((direction) => direction.id === directionId);
  if (matches.length !== 1) {
    return fail("Chosen Research direction is missing or ambiguous in its pinned Revision");
  }
  return matches[0]!;
}

export async function readResearchResourceRevision(input: {
  store: Store;
  dataDir: string;
  projectId: string;
  resourceId: string;
  revisionId: string;
  signal?: AbortSignal;
}): Promise<ResearchResourceRevisionView> {
  input.signal?.throwIfAborted();
  const facts = input.store.workspace.getResourceRevisionViewFactsForProject(
    input.projectId,
    input.resourceId,
    input.revisionId,
  );
  const resource = facts?.resource ?? null;
  if (!resource || resource.kind !== "research") {
    return fail("Research Resource is missing or has the wrong kind");
  }
  const revision = facts?.revision ?? null;
  if (!revision || revision.workspaceId !== resource.workspaceId || revision.resourceId !== resource.id) {
    return fail("Research Revision is missing or foreign");
  }
  let descriptor;
  try {
    descriptor = resolveResourceRevisionPayloadDescriptor({
      store: input.store,
      dataDir: input.dataDir,
      workspaceId: resource.workspaceId,
      resourceRevisionId: revision.id,
      expectedResourceId: resource.id,
    });
  } catch (error) {
    if (error instanceof ResourceRevisionPayloadError) {
      return fail(`Research Revision payload is unavailable: ${error.message}`);
    }
    throw error;
  }
  if (descriptor.resourceKind !== "research" || descriptor.mimeType !== "application/json"
    || descriptor.resourceRevisionId !== revision.id
    || descriptor.manifestPath !== revision.manifestPath
    || descriptor.manifestChecksum !== revision.checksum
    || descriptor.byteLength < 1 || descriptor.byteLength > MAX_RESEARCH_VIEW_BYTES) {
    return fail("Research Revision payload identity is invalid");
  }
  const materializationRoot = await mkdtemp(join(input.dataDir, ".research-view-"));
  const destination = join(materializationRoot, "research.json");
  try {
    try {
      await verifyResourceRevisionPayload(input.dataDir, descriptor, {
        destination,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      if (error instanceof ResourceRevisionPayloadError) {
        return fail(`Research Revision payload failed integrity verification: ${error.message}`);
      }
      throw error;
    }
    input.signal?.throwIfAborted();
    const contextPackId = researchRevisionContextPackId(revision.provenance);
    const contextPack = contextPackId === null
      ? null
      : createWorkspaceContextPackRepository(input.store.workspace, {
          manifestRoot: input.dataDir,
        }).get(resource.workspaceId, contextPackId);
    const content = decodeResearchBundle({
      bytes: await readFile(destination),
      workspaceId: resource.workspaceId,
      resourceId: resource.id,
      parentRevisionId: revision.parentRevisionId,
      revisionMetadata: revision.metadata,
      revisionProvenance: revision.provenance,
      contextPack,
    });
    return {
      protocol: "dezin.research-resource-revision-view.v1",
      resource,
      revision,
      observed: { headRevisionId: resource.headRevisionId, snapshotId: facts!.snapshotId },
      ...content,
    };
  } finally {
    await rm(materializationRoot, { recursive: true, force: true });
  }
}
