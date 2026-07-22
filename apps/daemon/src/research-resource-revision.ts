import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

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
import { stableStringify } from "./context/context-types.ts";
import {
  ResourceRevisionPayloadError,
  resolveResourceRevisionPayloadDescriptor,
  verifyResourceRevisionPayload,
} from "./resource-revision-payload.ts";

const MAX_RESEARCH_VIEW_BYTES = 8 * 1024 * 1024;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SENSITIVE_URL_KEY = /(?:^|[-_.])(token|secret|password|passwd|api[-_]?key|authorization|auth|credential|signature|session|jwt)(?:$|[-_.])/i;

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
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail(`${label} must be a canonical HTTP(S) URL`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username || parsed.password || parsed.hash || parsed.href !== raw
    || [...parsed.searchParams.keys()].some((key) => SENSITIVE_URL_KEY.test(key))) {
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

function stringArray(value: unknown, label: string, minimum = 0, maximum = 64): string[] {
  const values = array(value, label, minimum, maximum).map((item, index) => text(item, `${label} ${index}`, 8_192));
  if (new Set(values).size !== values.length) return fail(`${label} cannot contain duplicates`);
  return values;
}

function evidenceStatus(value: unknown, label: string): ResearchEvidenceStatus {
  if (value !== "evidence" && value !== "hypothesis") return fail(`${label} is invalid`);
  return value;
}

function confidence(value: unknown, label: string): "high" | "medium" | "low" {
  if (value !== "high" && value !== "medium" && value !== "low") return fail(`${label} is invalid`);
  return value;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
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

function decodeSources(value: unknown, contextPack: ResearchBundleContextPack): DecodedResearchSource[] {
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
    if (base.protocol !== "dezin.research-evidence-receipt.v1"
      || base.sourceKind !== source.view.kind
      || (base.verification !== "verified" && base.verification !== "unverified")
      || base.verification !== source.view.verification) {
      return fail(`Research evidence receipt ${index} source evidence is inconsistent`);
    }
    let item: Record<string, unknown>;
    let excerpt: DecodedResearchReceipt["excerpt"];
    if (source.view.kind === "web" && base.verification === "verified") {
      item = exactRecord(base, [
        "protocol", "sourceId", "sourceKind", "verification", "requestedUrl", "canonicalUrl", "retrievedAt",
        "status", "mimeType", "contentChecksum", "excerpt", "id", "checksum",
      ], `Research evidence receipt ${index}`);
      if (canonicalHttpUrl(item.requestedUrl, `Research evidence receipt ${index} requested URL`) !== source.view.locator) {
        return fail(`Research evidence receipt ${index} requested URL is inconsistent`);
      }
      canonicalHttpUrl(item.canonicalUrl, `Research evidence receipt ${index} canonical URL`);
      safeInteger(item.retrievedAt, `Research evidence receipt ${index} retrieved at`);
      safeInteger(item.status, `Research evidence receipt ${index} status`, 200, 299);
      text(item.mimeType, `Research evidence receipt ${index} MIME type`, 127);
      sha256(item.contentChecksum, `Research evidence receipt ${index} content checksum`);
      const location = locatedExcerpt(item.excerpt, `Research evidence receipt ${index} excerpt`);
      excerpt = { ...location };
    } else if (source.view.kind === "web") {
      item = exactRecord(base, [
        "protocol", "sourceId", "sourceKind", "verification", "requestedUrl", "reason", "excerpt", "id", "checksum",
      ], `Research evidence receipt ${index}`);
      if (canonicalHttpUrl(item.requestedUrl, `Research evidence receipt ${index} requested URL`) !== source.view.locator
        || (item.reason !== "retriever-unavailable" && item.reason !== "retrieval-failed")) {
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
    if (!sourceReceipt || sourceReceipt.sourceId !== sourceId || sourceReceipt.verification !== verification) {
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
        || findingSupportReceipts.some((receipt) => receipt.verification !== "verified")
        || !sameMembers(groundedSupportReceiptIds, supportReceiptIds)))
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

function decodeBundleScope(
  value: unknown,
  owner: { workspaceId: string; resourceId: string; parentRevisionId: string | null },
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
  return {
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
}

function decodeBundleContextPack(value: unknown, scope: ResearchBundleScope): ResearchBundleContextPack {
  const contextPack = exactRecord(value, ["id", "hash", "graphRevision"], "Research Context Pack identity");
  const decoded = {
    id: identifier(contextPack.id, "Research Context Pack id"),
    hash: sha256(contextPack.hash, "Research Context Pack hash"),
    graphRevision: safeInteger(contextPack.graphRevision, "Research Context Pack graph revision"),
  };
  if (decoded.id !== scope.contextPackId) return fail("Research Context Pack identity is inconsistent");
  return decoded;
}

function validateResearchBrief(value: unknown, scope: ResearchBundleScope): void {
  const brief = exactRecord(value, ["proposalRationale", "assumptions", "targetInstructions"], "Research brief");
  text(brief.proposalRationale, "Research brief rationale", 32_000);
  stringArray(brief.assumptions, "Research brief assumptions", 0, 64);
  const target = exactRecord(
    brief.targetInstructions,
    ["operation", "kind", "title"],
    "Research brief target instructions",
  );
  if (target.operation !== scope.operation || target.kind !== "research" || target.title !== scope.title) {
    return fail("Research brief substituted its exact Task target");
  }
}

function decodeResearchProvenance(input: {
  provenance: Record<string, unknown>;
  scope: ResearchBundleScope;
  contextPack: ResearchBundleContextPack;
  receipts: readonly DecodedResearchReceipt[];
  supportReceipts: readonly DecodedResearchSupportReceipt[];
}): { id: string; model?: string } | null {
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
  ], "Research production provenance", ["model"]);
  if (production.protocol !== "dezin.production-resource-generation.v1"
    || production.taskId !== input.scope.taskId || production.attempt !== input.scope.attempt
    || production.inputHash !== input.scope.inputHash || production.contextPackId !== input.contextPack.id
    || production.contextPackHash !== input.contextPack.hash) {
    return fail("Research production provenance is inconsistent");
  }
  identifier(production.generatorId, "Research generator id");
  if (production.model !== undefined) text(production.model, "Research generator model", 512);
  const evidence = exactRecord(production.researchEvidence, [
    "protocol", "verifiedSourceCount", "unverifiedSourceCount", "evidenceFindingCount", "hypothesisFindingCount",
    "receiptIds", "supportReceiptIds", "groundednessVerifier",
  ], "Research evidence provenance");
  if (evidence.protocol !== "dezin.research-evidence-provenance.v2") {
    return fail("Research evidence provenance protocol is unsupported");
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
  return verifier(evidence.groundednessVerifier, "Research provenance groundedness verifier");
}

function requiredMetadataCount(value: unknown, label: string, expected: number): void {
  if (safeInteger(value, label) !== expected) return fail(`${label} does not match the immutable payload`);
}

function validateResearchMetadata(input: {
  metadata: Record<string, unknown>;
  sources: readonly ResearchRevisionSourceView[];
  supportReceipts: readonly DecodedResearchSupportReceipt[];
  findings: readonly ResearchRevisionFindingView[];
  designPrinciples: readonly ResearchRevisionPrincipleView[];
  directions: readonly ResearchRevisionDirectionView[];
  verifier: { id: string; model?: string } | null;
}): ResearchRevisionQualityState {
  const adapter = exactRecord(input.metadata.adapter, [
    "format", "version", "qualityState", "requiresHypothesisConfirmation", "groundednessVerifierAvailable",
    "sourceCount", "verifiedSourceCount", "unverifiedSourceCount", "supportReceiptCount", "findingCount",
    "evidenceFindingCount", "hypothesisFindingCount", "principleCount", "directionCount", "evidenceDirectionCount",
    "hypothesisDirectionCount",
  ], "Research Revision adapter metadata");
  const evidenceFindingCount = input.findings.filter((finding) => finding.evidenceStatus === "evidence").length;
  const evidenceDirectionCount = input.directions.filter((direction) => direction.evidenceStatus === "evidence").length;
  const verifiedSourceCount = input.sources.filter((source) => source.verification === "verified").length;
  const expectedQuality: ResearchRevisionQualityState = evidenceDirectionCount > 0 ? "grounded" : "needs-review";
  if (adapter.format !== "dezin-research-resource-bundle" || adapter.version !== 3
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

function decodeResearchBundle(input: {
  bytes: Buffer;
  workspaceId: string;
  resourceId: string;
  parentRevisionId: string | null;
  revisionMetadata: Record<string, unknown>;
  revisionProvenance: Record<string, unknown>;
}): Omit<ResearchResourceRevisionView, "protocol" | "resource" | "revision" | "observed"> {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_RESEARCH_VIEW_BYTES) {
    return fail("Research Revision payload exceeds the Viewer bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bytes.toString("utf8"));
  } catch {
    return fail("Research Revision payload is not valid JSON");
  }
  const bundle = exactRecord(parsed, [
    "format", "version", "scope", "contextPack", "brief", "executiveSummary", "sources", "receipts",
    "supportReceipts", "findings", "designPrinciples", "directions", "openQuestions",
  ], "Research Revision payload");
  if (bundle.format !== "dezin-research-resource-bundle" || bundle.version !== 3) {
    return fail("Research Revision payload protocol is unsupported");
  }
  const scope = decodeBundleScope(bundle.scope, input);
  const contextPack = decodeBundleContextPack(bundle.contextPack, scope);
  validateResearchBrief(bundle.brief, scope);
  const decodedSources = decodeSources(bundle.sources, contextPack);
  const sources = decodedSources.map((source) => source.view);
  const receipts = decodeReceipts(bundle.receipts, decodedSources, contextPack);
  const supportReceipts = decodeSupportReceipts(bundle.supportReceipts, receipts);
  const groundednessVerifier = decodeResearchProvenance({
    provenance: input.revisionProvenance,
    scope,
    contextPack,
    receipts,
    supportReceipts,
  });
  const findings = decodeFindings(
    bundle.findings,
    new Map(sources.map((source) => [source.id, source])),
    new Map(supportReceipts.map((receipt) => [receipt.id, receipt])),
    groundednessVerifier,
  );
  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  const designPrinciples = decodePrinciples(bundle.designPrinciples, findingsById);
  const directions = decodeDirections(bundle.directions, findingsById);
  const evidenceDirectionCount = directions.filter((direction) => direction.evidenceStatus === "evidence").length;
  const hypothesisDirectionCount = directions.length - evidenceDirectionCount;
  const qualityState = validateResearchMetadata({
    metadata: input.revisionMetadata,
    sources,
    supportReceipts,
    findings,
    designPrinciples,
    directions,
    verifier: groundednessVerifier,
  });
  const productionProvenance = record(input.revisionProvenance.adapterProvenance, "Research production provenance");
  const provenance = exactRecord(
    productionProvenance.researchEvidence,
    [
      "protocol", "verifiedSourceCount", "unverifiedSourceCount", "evidenceFindingCount", "hypothesisFindingCount",
      "receiptIds", "supportReceiptIds", "groundednessVerifier",
    ],
    "Research evidence provenance",
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
    const content = decodeResearchBundle({
      bytes: await readFile(destination),
      workspaceId: resource.workspaceId,
      resourceId: resource.id,
      parentRevisionId: revision.parentRevisionId,
      revisionMetadata: revision.metadata,
      revisionProvenance: revision.provenance,
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
