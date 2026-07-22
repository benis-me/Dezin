import { types as nodeUtilTypes } from "node:util";

import type { GenerationTaskFailureClass } from "../../../../packages/core/src/index.ts";
import { GitArtifactCandidateRetention } from "./artifact-candidate-retention.ts";
import {
  GenerationTaskPublication,
  type GenerationTaskPublicationOptions,
  type GenerationTaskPublicationStorePort,
} from "./task-publication.ts";

const SAFE_OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PUBLICATION_OPTION_FIELDS = Object.freeze([
  "store",
  "repositoryDirForWorkspace",
  "projectIdForWorkspace",
  "notifyPlan",
] as const);

export interface ProductionTaskPublicationAdapterOptions {
  readonly store: GenerationTaskPublicationStorePort;
  readonly repositoryDirForWorkspace: (workspaceId: string) => string | Promise<string>;
  readonly projectIdForWorkspace: GenerationTaskPublicationOptions["projectIdForWorkspace"];
  readonly notifyPlan: GenerationTaskPublicationOptions["notifyPlan"];
}

export class ProductionTaskPublicationAdapterError extends Error {
  readonly code:
    | "PRODUCTION_TASK_PUBLICATION_CONFIGURATION_INVALID"
    | "PRODUCTION_TASK_RETENTION_UNAVAILABLE";
  readonly failureClass: GenerationTaskFailureClass;

  constructor(
    code: ProductionTaskPublicationAdapterError["code"],
    message: string,
    failureClass: GenerationTaskFailureClass,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ProductionTaskPublicationAdapterError";
    this.code = code;
    this.failureClass = failureClass;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function dataMethod<T extends (...args: never[]) => unknown>(
  value: unknown,
  key: string,
): T | null {
  if (!value || (typeof value !== "object" && typeof value !== "function")
    || nodeUtilTypes.isProxy(value)) return null;
  let cursor: object | null = value;
  try {
    while (cursor !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (descriptor !== undefined) {
        return "value" in descriptor && typeof descriptor.value === "function"
          ? descriptor.value.bind(value) as T
          : null;
      }
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch {
    return null;
  }
  return null;
}

function publicationOptions(value: unknown): Record<typeof PUBLICATION_OPTION_FIELDS[number], unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== PUBLICATION_OPTION_FIELDS.length
      || keys.some((key) => typeof key !== "string"
        || !PUBLICATION_OPTION_FIELDS.includes(key as typeof PUBLICATION_OPTION_FIELDS[number]))) {
      return null;
    }
    const result = {} as Record<typeof PUBLICATION_OPTION_FIELDS[number], unknown>;
    for (const field of PUBLICATION_OPTION_FIELDS) {
      const descriptor = descriptors[field];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      result[field] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function pinnedStore(value: unknown): GenerationTaskPublicationStorePort | null {
  const getArtifactRevision = dataMethod<GenerationTaskPublicationStorePort["getArtifactRevision"]>(
    value,
    "getArtifactRevision",
  );
  const stageGenerationTaskCandidateForProject = dataMethod<
    GenerationTaskPublicationStorePort["stageGenerationTaskCandidateForProject"]
  >(value, "stageGenerationTaskCandidateForProject");
  const publishGenerationTaskCandidateForProject = dataMethod<
    GenerationTaskPublicationStorePort["publishGenerationTaskCandidateForProject"]
  >(value, "publishGenerationTaskCandidateForProject");
  const completeGenerationTaskValidationForProject = dataMethod<
    GenerationTaskPublicationStorePort["completeGenerationTaskValidationForProject"]
  >(value, "completeGenerationTaskValidationForProject");
  const publishGenerationPlanCheckpointForProject = dataMethod<
    GenerationTaskPublicationStorePort["publishGenerationPlanCheckpointForProject"]
  >(value, "publishGenerationPlanCheckpointForProject");
  const finishGenerationTaskAttemptForProject = dataMethod<
    GenerationTaskPublicationStorePort["finishGenerationTaskAttemptForProject"]
  >(value, "finishGenerationTaskAttemptForProject");
  if (getArtifactRevision === null || stageGenerationTaskCandidateForProject === null
    || publishGenerationTaskCandidateForProject === null
    || completeGenerationTaskValidationForProject === null
    || publishGenerationPlanCheckpointForProject === null
    || finishGenerationTaskAttemptForProject === null) return null;
  return Object.freeze({
    getArtifactRevision,
    stageGenerationTaskCandidateForProject,
    publishGenerationTaskCandidateForProject,
    completeGenerationTaskValidationForProject,
    publishGenerationPlanCheckpointForProject,
    finishGenerationTaskAttemptForProject,
  });
}

/**
 * Production publication composition. Artifact candidate history is always
 * promoted to the immutable Revision refs and the Attempt ref is released
 * before Core publication; Resource publication remains fenced by Core after
 * the durable payload journal/receipt has already settled.
 */
export function createProductionGenerationTaskPublication(
  options: ProductionTaskPublicationAdapterOptions,
): GenerationTaskPublication {
  const configuration = publicationOptions(options);
  const store = pinnedStore(configuration?.store);
  if (configuration === null || store === null
    || typeof configuration.projectIdForWorkspace !== "function"
    || typeof configuration.notifyPlan !== "function") {
    throw new ProductionTaskPublicationAdapterError(
      "PRODUCTION_TASK_PUBLICATION_CONFIGURATION_INVALID",
      "Production Generation Task publication configuration is invalid",
      "build-infrastructure",
    );
  }
  if (typeof configuration.repositoryDirForWorkspace !== "function") {
    throw new ProductionTaskPublicationAdapterError(
      "PRODUCTION_TASK_RETENTION_UNAVAILABLE",
      "Production Artifact candidate retention repository adapter is unavailable",
      "build-infrastructure",
    );
  }
  const repositoryDirForWorkspace = configuration.repositoryDirForWorkspace as (
    workspaceId: string,
  ) => string | Promise<string>;
  const projectIdForWorkspace = configuration.projectIdForWorkspace as (
    workspaceId: string,
  ) => string;
  const notifyPlan = configuration.notifyPlan as (planId: string) => void;
  const artifactRetention = new GitArtifactCandidateRetention({
    async repositoryDirForWorkspace(workspaceId) {
      let directory: string;
      try {
        directory = await Reflect.apply(repositoryDirForWorkspace, options, [workspaceId]);
      } catch (error) {
        throw new ProductionTaskPublicationAdapterError(
          "PRODUCTION_TASK_RETENTION_UNAVAILABLE",
          "Production Artifact candidate retention repository could not be resolved",
          "build-infrastructure",
          error,
        );
      }
      if (typeof directory !== "string" || directory.length === 0 || directory.includes("\0")) {
        throw new ProductionTaskPublicationAdapterError(
          "PRODUCTION_TASK_RETENTION_UNAVAILABLE",
          "Production Artifact candidate retention repository is invalid",
          "build-infrastructure",
        );
      }
      return directory;
    },
  });
  return new GenerationTaskPublication({
    store,
    artifactRetention,
    projectIdForWorkspace(workspaceId) {
      const projectId = Reflect.apply(projectIdForWorkspace, options, [workspaceId]);
      if (typeof projectId !== "string" || !SAFE_OWNER_ID.test(projectId)) {
        throw new ProductionTaskPublicationAdapterError(
          "PRODUCTION_TASK_PUBLICATION_CONFIGURATION_INVALID",
          "Production Generation Task Project owner is invalid",
          "build-infrastructure",
        );
      }
      return projectId;
    },
    notifyPlan(planId) {
      Reflect.apply(notifyPlan, options, [planId]);
    },
  });
}
