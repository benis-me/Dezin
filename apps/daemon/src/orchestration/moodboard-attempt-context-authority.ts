import type {
  MoodboardAttemptContextAuthorityPort,
  MoodboardAttemptContextAuthorityInput,
  MoodboardAttemptContextIdentity,
} from "./resource-task-payload-staging.ts";

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
    readonly target: {
      readonly type: string;
      readonly workspaceId: string;
      readonly id: string;
    };
  } | null;
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
        return Object.freeze({
          contextPackId: attempt.contextPackId,
          contextPackHash: match[1]!,
        });
      } catch {
        return null;
      }
    },
  });
}
