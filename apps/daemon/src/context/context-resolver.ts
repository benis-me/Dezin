import {
  BlockedContextError,
  CONTEXT_PRIORITY,
  ContextIntegrityError,
  assertPortableContextValue,
  checksumBytes,
  cloneAndFreeze,
  estimateContextTokens,
  isWellFormedContextText,
  normalizeAgentTurnRequest,
  normalizeContextItemRef,
  stableStringify,
  type AgentIntent,
  type AgentTurnRequest,
  type ContextCandidate,
  type ContextCandidateSource,
  type ContextItemClass,
  type ContextItemRef,
  type ContextOmission,
  type ContextPack,
  type ExplicitContextResolution,
  type ResolvedContextItem,
  type ResourceRevisionSnapshot,
} from "./context-types.ts";
import type { ContextPackStore } from "./context-pack-store.ts";
import type { ResourceAdapterRegistry } from "./adapters/index.ts";

const REQUIRED_CLASSES = new Set<ContextItemClass>(["system-kernel", "target", "selection", "explicit"]);
const COMPACT_ORDER: readonly ContextItemClass[] = ["conversation", "indirect", "prototype-neighbor"];
const DEFAULT_BUDGETS: Readonly<Record<AgentIntent, number>> = Object.freeze({
  plan: 24_000,
  generate: 64_000,
  edit: 48_000,
  repair: 48_000,
  "analyze-impact": 32_000,
});
const MAX_CONTEXT_ITEMS = 1_024;
const MAX_EXPLICIT_REFS = 64;
const MAX_CANDIDATE_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_COLLECTED_CONTEXT_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateKey(candidate: ContextCandidate): string {
  return stableStringify({
    contextClass: candidate.contextClass,
    resolvedKind: candidate.resolvedKind,
    kind: candidate.ref.kind,
    resourceKind: candidate.ref.kind === "resource" ? candidate.ref.resourceKind : null,
    id: candidate.ref.id,
    revisionId: "revisionId" in candidate.ref ? candidate.ref.revisionId ?? null : null,
  });
}

function isResourceRevision(value: ExplicitContextResolution): value is ResourceRevisionSnapshot {
  return value !== null
    && !Array.isArray(value)
    && typeof value === "object"
    && "resourceId" in value
    && "manifestPath" in value
    && "payloadChecksum" in value;
}

function normalizeCandidate(candidate: ContextCandidate, contextClass: ContextItemClass): ContextCandidate {
  if (!candidate || typeof candidate !== "object" || typeof candidate.content !== "string") {
    throw new ContextIntegrityError(`Context candidate in ${contextClass} is incomplete`);
  }
  const ref = normalizeContextItemRef(candidate.ref, `Context candidate ${contextClass} ref`);
  if (!(["artifact-revision", "resource-revision", "kernel-revision", "inline"] as const).includes(candidate.resolvedKind)) {
    throw new ContextIntegrityError(`Context candidate ${ref.id} resolved kind is invalid`);
  }
  const exactRevisionId = "revisionId" in ref ? ref.revisionId : undefined;
  const identityIsCoherent = (candidate.resolvedKind === "resource-revision"
      && ref.kind === "resource" && exactRevisionId !== undefined)
    || (candidate.resolvedKind === "artifact-revision"
      && ref.kind === "artifact" && exactRevisionId !== undefined)
    || (candidate.resolvedKind === "kernel-revision"
      && ref.kind === "kernel" && exactRevisionId !== undefined)
    || (candidate.resolvedKind === "inline" && ref.kind === "inline");
  if (!identityIsCoherent) throw new ContextIntegrityError("Context candidate " + ref.id + " exact identity is incoherent");
  if (!isWellFormedContextText(candidate.content)
    || Buffer.byteLength(candidate.content, "utf8") > MAX_CANDIDATE_CONTENT_BYTES
    || (candidate.compactContent !== undefined
      && (typeof candidate.compactContent !== "string"
        || !isWellFormedContextText(candidate.compactContent)
        || Buffer.byteLength(candidate.compactContent, "utf8") > MAX_CANDIDATE_CONTENT_BYTES))) {
    throw new ContextIntegrityError(`Context candidate ${ref.id} content exceeds its byte limit`);
  }
  if (typeof candidate.reason !== "string" || candidate.reason.length === 0
    || !isWellFormedContextText(candidate.reason)
    || Buffer.byteLength(candidate.reason, "utf8") > 2_000) {
    throw new ContextIntegrityError(`Context candidate ${ref.id} reason is invalid`);
  }
  if (candidate.trustLevel !== "system" && candidate.trustLevel !== "trusted" && candidate.trustLevel !== "untrusted") {
    throw new ContextIntegrityError(`Context candidate ${ref.id} trust level is invalid`);
  }
  if (contextClass === "system-kernel" && candidate.trustLevel !== "system") {
    throw new ContextIntegrityError(`System Kernel candidate ${ref.id} must use system trust`);
  }
  if (!Array.isArray(candidate.capabilities) || candidate.capabilities.length > 64
    || candidate.capabilities.some((capability) => typeof capability !== "string"
      || capability.length === 0 || !isWellFormedContextText(capability)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(capability)
      || Buffer.byteLength(capability, "utf8") > 128)) {
    throw new ContextIntegrityError(`Context candidate ${ref.id} capabilities are invalid`);
  }
  if (!SHA256.test(candidate.checksum)) {
    throw new ContextIntegrityError(`Context candidate ${ref.id} checksum is invalid`);
  }
  if (candidate.resolvedKind === "inline" && candidate.checksum !== checksumBytes(candidate.content)) {
    throw new ContextIntegrityError("Inline Context candidate " + ref.id + " checksum does not match its content");
  }
  if (!candidate.boundary || typeof candidate.boundary !== "object" || Array.isArray(candidate.boundary)
    || candidate.boundary.readOnly !== true || candidate.boundary.mayGrantCapabilities !== false
    || typeof candidate.boundary.source !== "string" || !candidate.boundary.source
    || !isWellFormedContextText(candidate.boundary.source)
    || /[\u0000-\u001f\u007f]/.test(candidate.boundary.source)
    || Buffer.byteLength(candidate.boundary.source, "utf8") > 1_024
    || (candidate.boundary.delimiter !== undefined
      && (typeof candidate.boundary.delimiter !== "string"
        || !candidate.boundary.delimiter
        || !isWellFormedContextText(candidate.boundary.delimiter)
        || /[\u0000-\u001f\u007f]/.test(candidate.boundary.delimiter)
        || Buffer.byteLength(candidate.boundary.delimiter, "utf8") > 1_024))
    || Object.keys(candidate.boundary).some(
      (field) => field !== "source" && field !== "readOnly"
        && field !== "mayGrantCapabilities" && field !== "delimiter",
    )) {
    throw new ContextIntegrityError(`Context candidate ${ref.id} has an invalid capability boundary`);
  }
  if (candidate.trustLevel === "untrusted" && candidate.capabilities.length !== 0) {
    throw new ContextIntegrityError(`Untrusted Context candidate ${ref.id} cannot grant capabilities`);
  }
  assertPortableContextValue(candidate.boundary, `Context candidate ${ref.id} boundary`, 128 * 1024);
  assertPortableContextValue(candidate.provenance, `Context candidate ${ref.id} provenance`);
  const content = `${candidate.content}`;
  const compactContent = typeof candidate.compactContent === "string"
    && estimateContextTokens(candidate.compactContent) < estimateContextTokens(content)
    ? candidate.compactContent
    : undefined;
  return cloneAndFreeze({
    ...candidate,
    ref,
    contextClass,
    content,
    compactContent,
    capabilities: [...new Set(candidate.capabilities)].sort(binaryCompare),
    boundary: { ...candidate.boundary },
    tokenEstimate: estimateContextTokens(content),
    provenance: structuredClone(candidate.provenance),
    provided: true,
  });
}

function dedupeAndSort(candidates: readonly ContextCandidate[]): ContextCandidate[] {
  const priority = new Map(CONTEXT_PRIORITY.map((contextClass, index) => [contextClass, index]));
  const sorted = [...candidates].sort((left, right) => {
    const classOrder = priority.get(left.contextClass)! - priority.get(right.contextClass)!;
    return classOrder || binaryCompare(candidateKey(left), candidateKey(right));
  });
  const seen = new Map<string, ContextCandidate>();
  return sorted.filter((candidate) => {
    const key = candidateKey(candidate);
    const prior = seen.get(key);
    if (prior) {
      if (stableStringify(prior) !== stableStringify(candidate)) {
        throw new ContextIntegrityError(`Context candidate ${candidate.ref.id} has ambiguous duplicate content`);
      }
      return false;
    }
    seen.set(key, candidate);
    return true;
  });
}

function matchesRequestedExplicitRef(requested: ContextItemRef, resolved: ContextItemRef): boolean {
  if (requested.kind !== resolved.kind || requested.id !== resolved.id) return false;
  if (requested.kind === "resource") {
    if (resolved.kind !== "resource" || requested.resourceKind !== resolved.resourceKind) return false;
  }
  if ("revisionId" in requested && requested.revisionId !== undefined) {
    return "revisionId" in resolved && resolved.revisionId === requested.revisionId;
  }
  return true;
}

function matchesTarget(request: AgentTurnRequest, candidate: ContextCandidate): boolean {
  if (candidate.ref.id !== request.scope.id) return false;
  // A newly-created Artifact/Resource has no Revision yet. Its trusted target
  // contract is therefore an inline, immutable Task description; exact prior
  // Revisions are supplied separately as required explicit Context.
  const immutableGenerationTarget = request.intent === "generate"
    && candidate.ref.kind === "inline"
    && candidate.resolvedKind === "inline"
    && candidate.trustLevel === "trusted"
    && candidate.boundary.source.startsWith("generation-task:");
  if (request.scope.type === "artifact") {
    return candidate.ref.kind === "artifact" || immutableGenerationTarget;
  }
  if (request.scope.type === "resource") {
    return candidate.ref.kind === "resource" || immutableGenerationTarget;
  }
  return true;
}

function matchesSelection(
  request: AgentTurnRequest,
  selection: NonNullable<AgentTurnRequest["selection"]>[number],
  candidate: ContextCandidate,
  targetArtifactRevisionId: string | undefined,
): boolean {
  if (candidate.ref.id !== selection.id) return false;
  if (selection.kind === "element") {
    const provenance = candidate.provenance;
    if (request.scope.type !== "artifact" || targetArtifactRevisionId === undefined
      || candidate.ref.kind !== "inline" || candidate.trustLevel !== "trusted"
      || provenance.selectionManifestProtocol !== "dezin.artifact-element-selection-manifest.v1"
      || provenance.designNodeId !== selection.id
      || provenance.workspaceId !== request.scope.workspaceId
      || provenance.artifactId !== request.scope.id
      || provenance.artifactRevisionId !== targetArtifactRevisionId
      || (request.baseRevisionId !== undefined && provenance.artifactRevisionId !== request.baseRevisionId)
      || typeof provenance.assemblyHash !== "string" || !SHA256.test(provenance.assemblyHash)
      || typeof provenance.sourceArtifactId !== "string" || provenance.sourceArtifactId.length === 0
      || typeof provenance.sourceArtifactRevisionId !== "string" || provenance.sourceArtifactRevisionId.length === 0
      || typeof provenance.sourceCommitHash !== "string"
      || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(provenance.sourceCommitHash)
      || typeof provenance.sourceTreeHash !== "string"
      || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(provenance.sourceTreeHash)
      || typeof provenance.sourcePath !== "string" || provenance.sourcePath.length === 0
      || typeof provenance.selectionManifestHash !== "string"
      || !SHA256.test(provenance.selectionManifestHash)) return false;
    const manifest = {
      protocol: provenance.selectionManifestProtocol,
      workspaceId: provenance.workspaceId,
      artifactId: provenance.artifactId,
      artifactRevisionId: provenance.artifactRevisionId,
      assemblyHash: provenance.assemblyHash,
      designNodeId: provenance.designNodeId,
      sourceArtifactId: provenance.sourceArtifactId,
      sourceArtifactRevisionId: provenance.sourceArtifactRevisionId,
      sourceCommitHash: provenance.sourceCommitHash,
      sourceTreeHash: provenance.sourceTreeHash,
      sourcePath: provenance.sourcePath,
    };
    const manifestHash = checksumBytes(stableStringify(manifest));
    if (manifestHash !== provenance.selectionManifestHash) return false;
    if (candidate.content !== stableStringify({
      ...manifest,
      selectionManifestHash: provenance.selectionManifestHash,
    })) return false;
    return selection.revisionId === undefined
      || provenance.artifactRevisionId === selection.revisionId;
  }
  if (selection.kind === "artifact" && candidate.ref.kind !== "artifact") return false;
  if (selection.kind === "resource" && candidate.ref.kind !== "resource") return false;
  if (selection.revisionId !== undefined) {
    return "revisionId" in candidate.ref && candidate.ref.revisionId === selection.revisionId;
  }
  return true;
}

function fitContextBudget(candidates: readonly ContextCandidate[], budget: number): {
  retained: ContextCandidate[];
  omissions: ContextOmission[];
} {
  const retained = candidates.map((candidate) => ({ ...candidate }));
  const requiredTokens = retained
    .filter((candidate) => REQUIRED_CLASSES.has(candidate.contextClass))
    .reduce((sum, candidate) => sum + candidate.tokenEstimate, 0);
  if (requiredTokens > budget) {
    const required = retained
      .filter((candidate) => REQUIRED_CLASSES.has(candidate.contextClass))
      .map((candidate) => `${candidate.contextClass}:${candidate.ref.id}`);
    throw new BlockedContextError(required, `Required context exceeds the ${budget}-token Context budget`);
  }

  let total = retained.reduce((sum, candidate) => sum + candidate.tokenEstimate, 0);
  for (const contextClass of COMPACT_ORDER) {
    if (total <= budget) break;
    for (let index = 0; index < retained.length && total > budget; index += 1) {
      const candidate = retained[index]!;
      if (candidate.contextClass !== contextClass || candidate.compactContent === undefined) continue;
      const compactTokens = estimateContextTokens(candidate.compactContent);
      total -= candidate.tokenEstimate - compactTokens;
      retained[index] = {
        ...candidate,
        content: candidate.compactContent,
        ...(candidate.resolvedKind === "inline"
          ? { checksum: checksumBytes(candidate.compactContent) }
          : {}),
        compactContent: undefined,
        tokenEstimate: compactTokens,
      };
    }
  }

  const omissions: ContextOmission[] = [];
  const dropOrder = [...CONTEXT_PRIORITY].reverse();
  for (const contextClass of dropOrder) {
    if (total <= budget) break;
    if (REQUIRED_CLASSES.has(contextClass)) continue;
    for (let index = retained.length - 1; index >= 0 && total > budget; index -= 1) {
      const candidate = retained[index]!;
      if (candidate.contextClass !== contextClass) continue;
      retained.splice(index, 1);
      total -= candidate.tokenEstimate;
      omissions.push({
        ref: cloneAndFreeze(candidate.ref),
        contextClass,
        reason: "omitted after deterministic Context budget fitting",
        tokenEstimate: candidate.tokenEstimate,
      });
    }
  }
  if (total > budget) throw new ContextIntegrityError("Context budget could not be fitted deterministically");
  return { retained, omissions };
}

export interface ContextResolverOptions {
  packStore: ContextPackStore;
  adapters: ResourceAdapterRegistry;
  resourceStorageRoot: string;
  source: ContextCandidateSource;
  budgets?: Partial<Record<AgentIntent, number>>;
}

export class ContextResolver {
  readonly #packStore: ContextPackStore;
  readonly #adapters: ResourceAdapterRegistry;
  readonly #source: ContextCandidateSource;
  readonly #resourceStorageRoot: string;
  readonly #budgets: Readonly<Record<AgentIntent, number>>;

  constructor(options: ContextResolverOptions) {
    this.#packStore = options.packStore;
    this.#adapters = options.adapters;
    this.#resourceStorageRoot = options.resourceStorageRoot;
    this.#source = options.source;
    const budgets = { ...DEFAULT_BUDGETS, ...options.budgets };
    for (const [intent, budget] of Object.entries(budgets)) {
      if (!Number.isSafeInteger(budget) || budget <= 0) throw new TypeError(`Context budget for ${intent} is invalid`);
    }
    this.#budgets = Object.freeze(budgets);
  }

  async #resolveExplicit(request: AgentTurnRequest, ref: ContextItemRef): Promise<ContextCandidate[]> {
    const resolved = await this.#source.resolveExplicit(request, cloneAndFreeze(ref));
    if (resolved === null) {
      throw new BlockedContextError([ref.id], `Explicit Context reference ${ref.id} could not be resolved`);
    }
    if (ref.kind === "resource") {
      if (!isResourceRevision(resolved)) {
        throw new BlockedContextError([ref.id], `Explicit Resource ${ref.id} did not resolve to an immutable Revision`);
      }
      if (resolved.workspaceId !== request.scope.workspaceId
        || resolved.resourceId !== ref.id
        || resolved.kind !== ref.resourceKind
        || (ref.revisionId !== undefined && resolved.id !== ref.revisionId)) {
        throw new BlockedContextError([ref.id], `Explicit Resource ${ref.id} resolved outside its exact owned Revision`);
      }
      const adapter = this.#adapters.require(ref.resourceKind);
      const items = await adapter.resolve({
        request,
        contextClass: "explicit",
        requestedRef: ref,
        revision: resolved,
        storageRoot: this.#resourceStorageRoot,
      });
      if (!items.length) throw new BlockedContextError([ref.id], `Explicit Resource ${ref.id} resolved without Context items`);
      const normalized = items.map((item) => normalizeCandidate(item, "explicit"));
      if (normalized.some((candidate) => candidate.resolvedKind !== "resource-revision"
        || candidate.ref.kind !== "resource"
        || !matchesRequestedExplicitRef(ref, candidate.ref)
        || candidate.ref.revisionId !== resolved.id)) {
        throw new BlockedContextError(
          [ref.id],
          `Explicit Resource ${ref.id} adapter did not preserve its exact requested Revision identity`,
        );
      }
      return normalized;
    }
    if (isResourceRevision(resolved)) {
      throw new ContextIntegrityError(`Non-Resource explicit reference ${ref.id} resolved to a Resource Revision`);
    }
    const values = Array.isArray(resolved) ? resolved : [resolved];
    if (!values.length) throw new BlockedContextError([ref.id], `Explicit Context reference ${ref.id} resolved empty`);
    const normalized = values.map((candidate) => normalizeCandidate(candidate, "explicit"));
    if (normalized.some((candidate) => !matchesRequestedExplicitRef(ref, candidate.ref))) {
      throw new BlockedContextError(
        [ref.id],
        `Explicit Context reference ${ref.id} did not resolve its exact requested identity`,
      );
    }
    return normalized;
  }

  async resolve(unsafeRequest: unknown): Promise<ContextPack> {
    const request = normalizeAgentTurnRequest(unsafeRequest);
    if (!request.scope.workspaceId || !request.scope.id) throw new ContextIntegrityError("Agent Context scope is incomplete");
    if (!Number.isSafeInteger(request.graphRevision) || request.graphRevision < 0) {
      throw new ContextIntegrityError("Agent Context graph Revision is invalid");
    }
    if (request.explicitContext.length > MAX_EXPLICIT_REFS) {
      throw new BlockedContextError(["explicit-context-limit"], "Too many explicit Context references");
    }

    const collected = await Promise.all(
      CONTEXT_PRIORITY
        .filter((contextClass): contextClass is Exclude<ContextItemClass, "explicit"> => contextClass !== "explicit")
        .map(async (contextClass) => {
          const candidates = await this.#source.collect(request, contextClass);
          if (!Array.isArray(candidates) || candidates.length > MAX_CONTEXT_ITEMS) {
            throw new ContextIntegrityError(`Context source ${contextClass} returned an invalid candidate list`);
          }
          return candidates.map((candidate) => normalizeCandidate(candidate, contextClass));
        }),
    );
    const explicit: ContextCandidate[] = [];
    for (const ref of request.explicitContext) explicit.push(...await this.#resolveExplicit(request, ref));
    const candidates = dedupeAndSort([...collected.flat(), ...explicit]);
    if (candidates.length > MAX_CONTEXT_ITEMS) {
      throw new BlockedContextError(["context-item-limit"], "Resolved Context exceeds the item-count limit");
    }
    const collectedBytes = candidates.reduce((total, candidate) => total
      + Buffer.byteLength(candidate.content, "utf8")
      + Buffer.byteLength(candidate.compactContent ?? "", "utf8")
      + Buffer.byteLength(candidate.reason, "utf8")
      + Buffer.byteLength(stableStringify(candidate.capabilities), "utf8")
      + Buffer.byteLength(stableStringify(candidate.provenance), "utf8")
      + Buffer.byteLength(stableStringify(candidate.boundary), "utf8"), 0);
    if (collectedBytes > MAX_COLLECTED_CONTEXT_BYTES) {
      throw new BlockedContextError(["context-byte-limit"], "Resolved Context exceeds its total byte limit");
    }
    const missingRequiredClasses = (["system-kernel", "target"] as const)
      .filter((contextClass) => !candidates.some((candidate) => candidate.contextClass === contextClass
        && (contextClass !== "target" || matchesTarget(request, candidate))));
    if (missingRequiredClasses.length) {
      throw new BlockedContextError(
        missingRequiredClasses,
        `Required Context is missing: ${missingRequiredClasses.join(", ")}`,
      );
    }
    if (request.selection?.length) {
      const artifactTarget = request.scope.type === "artifact"
        ? candidates.find((candidate) => candidate.contextClass === "target"
          && candidate.ref.kind === "artifact"
          && candidate.ref.id === request.scope.id)
        : undefined;
      const targetArtifactRevisionId = artifactTarget?.ref.kind === "artifact"
        ? artifactTarget.ref.revisionId
        : undefined;
      const missingSelections = request.selection.filter((selection) => !candidates.some(
        (candidate) => candidate.contextClass === "selection"
          && matchesSelection(request, selection, candidate, targetArtifactRevisionId),
      ));
      if (missingSelections.length) {
        throw new BlockedContextError(
          missingSelections.map((selection) => selection.id),
          "One or more selected Context references could not be resolved",
        );
      }
    }
    const fitted = fitContextBudget(candidates, this.#budgets[request.intent]);
    const items: ResolvedContextItem[] = fitted.retained.map((candidate, ordinal) => {
      const { compactContent: _compactContent, ...item } = candidate;
      return cloneAndFreeze({ ...item, ordinal, provided: true });
    });
    return this.#packStore.persist({
      workspaceId: request.scope.workspaceId,
      graphRevision: request.graphRevision,
      target: { type: request.scope.type, id: request.scope.id },
      intent: request.intent,
      messageChecksum: checksumBytes(request.message),
      items,
      omissions: fitted.omissions.map((omission) => cloneAndFreeze(omission)),
      tokenEstimate: items.reduce((sum, item) => sum + item.tokenEstimate, 0),
    });
  }
}
