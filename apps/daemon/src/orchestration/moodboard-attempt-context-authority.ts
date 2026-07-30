import type {
  MoodboardAttemptContextAuthorityPort,
  MoodboardAttemptContextAuthorityInput,
  MoodboardAttemptContextIdentity,
} from "./resource-task-payload-staging.ts";
import type { ResearchRevisionTaskAuthority } from "../research-resource-revision.ts";

const CONTEXT_PACK_ID = /^context-pack-([a-f0-9]{64})$/;

export interface MoodboardAttemptContextProjectCatalog {
  listProjects(): readonly { readonly id: string }[];
}

export interface MoodboardAttemptContextWorkspaceStore {
  getWorkspace(projectId: string): { readonly id: string } | null;
  getGenerationTaskAttemptForProject(
    projectId: string,
    planId: string,
    taskId: string,
    attempt: number,
  ): {
    readonly taskId: string;
    readonly planId: string;
    readonly workspaceId: string;
    readonly attempt: number;
    readonly inputHash: string;
    readonly contextPackId: string | null;
    readonly payload?: Record<string, unknown>;
    readonly target: {
      readonly type: string;
      readonly workspaceId: string;
      readonly id: string;
    };
  } | null;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function authorityText(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maximum
    && value === value.trim() && isWellFormedUtf16(value)
    ? value
    : null;
}

function isWellFormedUtf16(value: string): boolean {
  const native = value as string & { isWellFormed?: () => boolean };
  if (typeof native.isWellFormed === "function") return native.isWellFormed();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function researchTaskAuthority(
  payloadValue: unknown,
  resourceId: string,
): ResearchRevisionTaskAuthority | null {
  const payload = plainRecord(payloadValue);
  const operation = plainRecord(payload?.operation);
  const brief = plainRecord(payload?.brief);
  const target = plainRecord(brief?.targetInstructions);
  if (payload?.version !== 2 || operation === null || brief === null || target === null
    || operation.kind !== "research" || operation.resourceId !== resourceId
    || (operation.operation !== "create" && operation.operation !== "revise")
    || target.operation !== operation.operation || target.kind !== "research"
    || target.title !== operation.title) {
    return null;
  }
  const nodeId = authorityText(operation.nodeId, 512);
  const title = authorityText(operation.title, 4_096);
  const proposalRationale = authorityText(brief.proposalRationale, 32_000);
  if (nodeId === null || title === null || proposalRationale === null
    || !Array.isArray(brief.assumptions) || brief.assumptions.length > 1_000) {
    return null;
  }
  const assumptions: string[] = [];
  for (const assumption of brief.assumptions) {
    const parsed = authorityText(assumption, 32_000);
    if (parsed === null) return null;
    assumptions.push(parsed);
  }
  let instructions: string | undefined;
  if (operation.instructions === undefined && target.instructions === undefined) {
    instructions = undefined;
  } else {
    const operationInstructions = authorityText(operation.instructions, 2_000);
    const targetInstructions = authorityText(target.instructions, 2_000);
    if (operationInstructions === null
      || targetInstructions === null
      || operationInstructions !== targetInstructions) return null;
    instructions = operationInstructions;
  }
  return Object.freeze({
    operation: operation.operation,
    nodeId,
    title,
    brief: Object.freeze({
      proposalRationale,
      assumptions: Object.freeze(assumptions),
      targetInstructions: Object.freeze({
        operation: operation.operation,
        kind: "research" as const,
        title,
        ...(instructions === undefined ? {} : { instructions }),
      }),
    }),
  });
}

/**
 * Restores a receipt scan's Context Pack identity from the immutable Store
 * Attempt. Receipt provenance and generated bundle claims are deliberately not
 * inputs to this authority.
 */
export function createStoreBackedMoodboardAttemptContextAuthority(options: {
  readonly projectCatalog: MoodboardAttemptContextProjectCatalog;
  readonly workspaceStore: MoodboardAttemptContextWorkspaceStore;
}): MoodboardAttemptContextAuthorityPort {
  const listProjects = options.projectCatalog.listProjects.bind(options.projectCatalog);
  const getWorkspace = options.workspaceStore.getWorkspace.bind(options.workspaceStore);
  const getAttempt = options.workspaceStore.getGenerationTaskAttemptForProject
    .bind(options.workspaceStore);
  return Object.freeze({
    resolveMoodboardAttemptContext(
      input: MoodboardAttemptContextAuthorityInput,
    ): MoodboardAttemptContextIdentity | null {
      let projectId: string | null = null;
      try {
        for (const project of listProjects()) {
          if (typeof project?.id !== "string" || project.id.length === 0) continue;
          const workspace = getWorkspace(project.id);
          if (workspace?.id !== input.workspaceId) continue;
          if (projectId !== null) return null;
          projectId = project.id;
        }
        if (projectId === null) return null;
        const attempt = getAttempt(projectId, input.planId, input.taskId, input.attempt);
        if (attempt === null
          || attempt.taskId !== input.taskId
          || attempt.planId !== input.planId
          || attempt.workspaceId !== input.workspaceId
          || attempt.attempt !== input.attempt
          || attempt.inputHash !== input.inputHash
          || attempt.target.type !== "resource"
          || attempt.target.workspaceId !== input.workspaceId
          || attempt.target.id !== input.resourceId
          || typeof attempt.contextPackId !== "string") return null;
        const match = CONTEXT_PACK_ID.exec(attempt.contextPackId);
        if (match === null) return null;
        const researchAuthority = researchTaskAuthority(attempt.payload, input.resourceId);
        return Object.freeze({
          contextPackId: attempt.contextPackId,
          contextPackHash: match[1]!,
          ...(researchAuthority === null
            ? {}
            : { researchTaskAuthority: researchAuthority }),
        });
      } catch {
        return null;
      }
    },
  });
}
