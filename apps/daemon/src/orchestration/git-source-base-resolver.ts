import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import type {
  ArtifactRevisionRecord,
  GenerationTaskSourceBase,
  ProjectWorkspace,
  WorkspaceArtifactRecord,
} from "../../../../packages/core/src/index.ts";
import type {
  GenerationTaskSourceBaseRequest,
  GenerationTaskSourceBaseResolver,
} from "./generation-plan-service.ts";

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface GitSourceBaseWorkspacePort {
  getWorkspace(projectId: string): Pick<ProjectWorkspace, "id" | "projectId"> | null;
  getArtifact(artifactId: string): Pick<
    WorkspaceArtifactRecord,
    "id" | "workspaceId" | "kind" | "activeTrackId" | "archivedAt"
  > | null;
  getArtifactRevision(revisionId: string): Pick<
    ArtifactRevisionRecord,
    "id" | "workspaceId" | "artifactId" | "trackId" | "sourceCommitHash" | "sourceTreeHash"
  > | null;
}

export interface GitArtifactSourceBaseResolverOptions {
  readonly workspace: GitSourceBaseWorkspacePort;
  readonly repositoryDirForWorkspace: (workspaceId: string) => string | Promise<string>;
}

export class GitSourceBaseResolutionError extends Error {
  readonly failureClass = "storage" as const;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GitSourceBaseResolutionError";
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Source Base resolution aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function exactObjectId(value: string, label: string): string {
  const normalized = value.trim();
  if (!GIT_OBJECT_ID.test(normalized)) {
    throw new GitSourceBaseResolutionError(`${label} is not an exact lowercase Git object id`);
  }
  return normalized;
}

async function gitObject(
  repositoryDir: string,
  expression: string,
  signal: AbortSignal,
): Promise<string> {
  checkAbort(signal);
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      ["rev-parse", "--verify", expression],
      {
        cwd: repositoryDir,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        windowsHide: true,
        signal,
      },
      (error, stdout) => {
        if (signal.aborted) return reject(abortReason(signal));
        if (error) {
          return reject(new GitSourceBaseResolutionError(
            `Git Source Base object is unavailable: ${expression}`,
            error,
          ));
        }
        try {
          resolve(exactObjectId(stdout, `Git Source Base ${expression}`));
        } catch (inspectionError) {
          reject(inspectionError);
        }
      },
    );
  });
}

/**
 * Freezes the exact commit/tree used to create an Artifact candidate worktree.
 * Existing Artifacts use their durable base Revision; new Artifacts resolve HEAD
 * once to a commit and derive the tree from that commit, never from HEAD again.
 */
export class GitArtifactSourceBaseResolver implements GenerationTaskSourceBaseResolver {
  readonly #options: GitArtifactSourceBaseResolverOptions;

  constructor(options: GitArtifactSourceBaseResolverOptions) {
    this.#options = options;
  }

  async resolve(
    input: GenerationTaskSourceBaseRequest,
    signal: AbortSignal,
  ): Promise<GenerationTaskSourceBase> {
    checkAbort(signal);
    const { task, observation } = input;
    if (task.target.type !== "artifact" || observation.target.type !== "artifact"
      || task.id !== observation.taskId || task.planId !== input.planId
      || task.workspaceId !== observation.workspaceId
      || task.target.workspaceId !== task.workspaceId
      || observation.target.workspaceId !== task.workspaceId
      || task.target.id !== observation.target.id
      || task.target.trackId !== observation.target.trackId) {
      throw new GitSourceBaseResolutionError("Source Base request does not describe one exact Artifact Task");
    }
    const workspace = this.#options.workspace.getWorkspace(input.projectId);
    const artifact = this.#options.workspace.getArtifact(task.target.id);
    if (!workspace || workspace.id !== task.workspaceId || workspace.projectId !== input.projectId
      || !artifact || artifact.workspaceId !== task.workspaceId || artifact.archivedAt !== null
      || artifact.id !== task.target.id || artifact.kind !== task.kind
      || artifact.activeTrackId !== task.target.trackId) {
      throw new GitSourceBaseResolutionError("Source Base target ownership or Track identity is invalid");
    }
    const configuredDir = await this.#options.repositoryDirForWorkspace(task.workspaceId);
    checkAbort(signal);
    let repositoryDir: string;
    try {
      repositoryDir = await realpath(configuredDir);
      const metadata = await stat(repositoryDir);
      if (!metadata.isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new GitSourceBaseResolutionError("Source Base repository is unavailable", error);
    }
    checkAbort(signal);

    let sourceCommitHash: string;
    let expectedTreeHash: string | null = null;
    if (observation.baseRevisionId === null) {
      sourceCommitHash = await gitObject(repositoryDir, "HEAD^{commit}", signal);
    } else {
      const revision = this.#options.workspace.getArtifactRevision(observation.baseRevisionId);
      if (!revision || revision.id !== observation.baseRevisionId
        || revision.workspaceId !== task.workspaceId
        || revision.artifactId !== task.target.id
        || revision.trackId !== task.target.trackId) {
        throw new GitSourceBaseResolutionError("Source Base Artifact Revision is missing or foreign");
      }
      sourceCommitHash = exactObjectId(revision.sourceCommitHash, "Source Base Revision commit");
      expectedTreeHash = exactObjectId(revision.sourceTreeHash, "Source Base Revision tree");
      const verifiedCommit = await gitObject(repositoryDir, `${sourceCommitHash}^{commit}`, signal);
      if (verifiedCommit !== sourceCommitHash) {
        throw new GitSourceBaseResolutionError("Source Base Revision commit does not match Git");
      }
    }
    const sourceTreeHash = await gitObject(repositoryDir, `${sourceCommitHash}^{tree}`, signal);
    if (expectedTreeHash !== null && sourceTreeHash !== expectedTreeHash) {
      throw new GitSourceBaseResolutionError("Source Base Revision tree does not match Git");
    }
    return Object.freeze({ sourceCommitHash, sourceTreeHash });
  }
}
