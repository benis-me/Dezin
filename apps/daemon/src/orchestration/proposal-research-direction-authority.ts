import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GenerationPlanCompileError,
  type Store,
  type WorkspaceProposalRecord,
} from "../../../../packages/core/src/index.ts";
import {
  createWorkspaceContextPackRepository,
} from "../context/context-pack-store.ts";
import {
  listResearchRevisionDirections,
  ResearchResourceRevisionError,
  researchRevisionContextPackId,
} from "../research-resource-revision.ts";
import {
  resolveResourceRevisionPayloadDescriptor,
  ResourceRevisionPayloadError,
  verifyResourceRevisionPayload,
} from "../resource-revision-payload.ts";

/**
 * Approval-time membership check for every Artifact Research direction
 * selection. Compile already proves the selection binds an owned exact
 * Research Revision; this gate proves each directionId actually exists in
 * that pinned payload so corrupt Agent output (e.g. directionId "s") cannot
 * enter a Generation Plan and cascade-block dependents at materialize time.
 */
export async function assertProposalResearchDirectionMembership(input: {
  readonly store: Store;
  readonly dataDir: string;
  readonly projectId: string;
  readonly proposal: WorkspaceProposalRecord;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const generation = input.proposal.generation;
  if (generation.kind !== "workspace-generation") return;

  const selections = generation.artifactPlans.flatMap((plan) => {
    if (plan.researchDirectionSelection === undefined) return [];
    return [{
      artifactId: plan.artifactId,
      artifactName: plan.name,
      selection: plan.researchDirectionSelection,
    }];
  });
  if (selections.length === 0) return;

  const directionCache = new Map<string, ReadonlySet<string>>();
  const contextPacks = createWorkspaceContextPackRepository(input.store.workspace, {
    manifestRoot: input.dataDir,
  });

  for (const { artifactId, artifactName, selection } of selections) {
    input.signal?.throwIfAborted();
    const cacheKey = `${selection.resourceId}@${selection.revisionId}`;
    let available = directionCache.get(cacheKey);
    if (available === undefined) {
      available = await loadResearchDirectionIds({
        store: input.store,
        dataDir: input.dataDir,
        projectId: input.projectId,
        workspaceId: input.proposal.workspaceId,
        resourceId: selection.resourceId,
        revisionId: selection.revisionId,
        contextPacks,
        signal: input.signal,
      });
      directionCache.set(cacheKey, available);
    }

    const requested = selection.directionIds ?? [selection.directionId];
    const missing = requested.filter((directionId) => !available.has(directionId));
    if (missing.length > 0 || !available.has(selection.directionId)) {
      throw new GenerationPlanCompileError(
        "invalid-reference",
        `generation Artifact ${artifactId} (${artifactName}) Research direction selection is missing or ambiguous in its pinned Revision`,
        {
          proposalId: input.proposal.id,
          artifactId,
          artifactName,
          resourceId: selection.resourceId,
          revisionId: selection.revisionId,
          directionId: selection.directionId,
          ...(selection.directionIds === undefined ? {} : { directionIds: [...selection.directionIds] }),
          missingDirectionIds: missing.length > 0 ? missing : [selection.directionId],
          availableDirectionIds: [...available],
        },
      );
    }
  }
}

async function loadResearchDirectionIds(input: {
  readonly store: Store;
  readonly dataDir: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly contextPacks: ReturnType<typeof createWorkspaceContextPackRepository>;
  readonly signal?: AbortSignal;
}): Promise<ReadonlySet<string>> {
  const facts = input.store.workspace.getResourceRevisionViewFactsForProject(
    input.projectId,
    input.resourceId,
    input.revisionId,
  );
  if (facts === null
    || facts.resource.kind !== "research"
    || facts.resource.archivedAt !== null
    || facts.revision.workspaceId !== input.workspaceId
    || facts.revision.resourceId !== input.resourceId) {
    throw new GenerationPlanCompileError(
      "invalid-reference",
      `Research Revision ${input.revisionId} is not an exact owned immutable Research payload`,
      {
        resourceId: input.resourceId,
        revisionId: input.revisionId,
      },
    );
  }

  let descriptor;
  try {
    descriptor = resolveResourceRevisionPayloadDescriptor({
      store: input.store,
      dataDir: input.dataDir,
      workspaceId: input.workspaceId,
      resourceRevisionId: input.revisionId,
      expectedResourceId: input.resourceId,
    });
  } catch (error) {
    if (error instanceof ResourceRevisionPayloadError) {
      throw new GenerationPlanCompileError(
        "invalid-reference",
        `Research Revision ${input.revisionId} payload is unavailable: ${error.message}`,
        { resourceId: input.resourceId, revisionId: input.revisionId },
      );
    }
    throw error;
  }

  if (descriptor.resourceKind !== "research"
    || descriptor.mimeType !== "application/json"
    || descriptor.manifestPath !== facts.revision.manifestPath
    || descriptor.manifestChecksum !== facts.revision.checksum) {
    throw new GenerationPlanCompileError(
      "invalid-reference",
      `Research Revision ${input.revisionId} payload identity is invalid`,
      { resourceId: input.resourceId, revisionId: input.revisionId },
    );
  }

  const materializationRoot = await mkdtemp(join(input.dataDir || tmpdir(), ".proposal-research-direction-"));
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
        throw new GenerationPlanCompileError(
          "invalid-reference",
          `Research Revision ${input.revisionId} payload failed integrity verification: ${error.message}`,
          { resourceId: input.resourceId, revisionId: input.revisionId },
        );
      }
      throw error;
    }
    input.signal?.throwIfAborted();

    const contextPackId = researchRevisionContextPackId(facts.revision.provenance);
    const contextPack = contextPackId === null
      ? null
      : input.contextPacks.get(input.workspaceId, contextPackId);

    try {
      const directions = listResearchRevisionDirections({
        bytes: await readFile(destination),
        workspaceId: input.workspaceId,
        resourceId: input.resourceId,
        parentRevisionId: facts.revision.parentRevisionId,
        revisionMetadata: facts.revision.metadata,
        revisionProvenance: facts.revision.provenance,
        contextPack,
      });
      return new Set(directions.map((direction) => direction.id));
    } catch (error) {
      if (error instanceof ResearchResourceRevisionError) {
        throw new GenerationPlanCompileError(
          "invalid-reference",
          `Research Revision ${input.revisionId} directions are invalid: ${error.message}`,
          { resourceId: input.resourceId, revisionId: input.revisionId },
        );
      }
      throw error;
    }
  } finally {
    await rm(materializationRoot, { recursive: true, force: true }).catch(() => {});
  }
}
