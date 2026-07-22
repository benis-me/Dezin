import { types as nodeUtilTypes } from "node:util";

import type { AgentRunner } from "../../../../packages/agent/src/index.ts";
import type { GenerationTaskFailureClass } from "../../../../packages/core/src/index.ts";
import {
  DefaultArtifactRunPreparation,
  type ArtifactRunInfrastructureInput,
  type ArtifactRunPreparationOptions,
} from "./artifact-run-preparation.ts";
import {
  ArtifactRunExecutor,
  type ArtifactRunExecutorOptions,
} from "./artifact-run-executor.ts";
import {
  ProductionStandardArtifactQualityEvaluator,
  type ProductionStandardArtifactQualityEvaluatorOptions,
} from "./standard-artifact-quality-evaluator.ts";

const ARTIFACT_OPTION_FIELDS = Object.freeze([
  "contextPacks",
  "projectIdForWorkspace",
  "repositoryDirForWorkspace",
  "agent",
  "quality",
  "baseSystemPrompt",
  "environment",
  "sharinganCaptures",
  "onEvent",
  "reportError",
] as const);
const REQUIRED_ARTIFACT_OPTION_FIELDS = Object.freeze([
  "contextPacks",
  "projectIdForWorkspace",
  "repositoryDirForWorkspace",
  "agent",
  "quality",
  "baseSystemPrompt",
] as const);

export interface ProductionArtifactAgentAdapter {
  createRunner(
    input: ArtifactRunInfrastructureInput,
    signal: AbortSignal,
  ): AgentRunner | Promise<AgentRunner>;
}

export type ProductionArtifactQualityConfiguration = Omit<
  ProductionStandardArtifactQualityEvaluatorOptions,
  "infrastructure" | "projectId"
>;

export interface ProductionArtifactRunAdapterOptions
  extends Omit<
    ArtifactRunPreparationOptions,
    "createRunner" | "createQualityEvaluator"
  >,
  Pick<ArtifactRunExecutorOptions, "onEvent" | "reportError"> {
  readonly agent: ProductionArtifactAgentAdapter;
  readonly quality: (
    input: ArtifactRunInfrastructureInput,
    signal: AbortSignal,
  ) => ProductionArtifactQualityConfiguration | Promise<ProductionArtifactQualityConfiguration>;
}

export class ProductionArtifactRunAdapterError extends Error {
  readonly code:
    | "PRODUCTION_ARTIFACT_CONFIGURATION_INVALID"
    | "PRODUCTION_ARTIFACT_AGENT_UNAVAILABLE"
    | "PRODUCTION_ARTIFACT_QUALITY_UNAVAILABLE";
  readonly failureClass: GenerationTaskFailureClass;

  constructor(
    code: ProductionArtifactRunAdapterError["code"],
    message: string,
    failureClass: GenerationTaskFailureClass,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ProductionArtifactRunAdapterError";
    this.code = code;
    this.failureClass = failureClass;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function dataMethod<T extends (...args: never[]) => unknown>(
  value: unknown,
  key: string,
): T | null {
  if ((typeof value !== "object" && typeof value !== "function")
    || value === null || nodeUtilTypes.isProxy(value)) return null;
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

function pinnedRunner(value: unknown): AgentRunner | null {
  if (!value || typeof value !== "object" || nodeUtilTypes.isProxy(value)) return null;
  let cursor: object | null = value;
  let id: unknown;
  try {
    while (cursor !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, "id");
      if (descriptor !== undefined) {
        if (!("value" in descriptor)) return null;
        id = descriptor.value;
        break;
      }
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch {
    return null;
  }
  const runTurn = dataMethod<AgentRunner["runTurn"]>(value, "runTurn");
  if (typeof id !== "string" || id.length === 0 || runTurn === null) return null;
  return Object.freeze({ id, runTurn });
}

function artifactOptions(value: unknown): Record<typeof ARTIFACT_OPTION_FIELDS[number], unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.some((key) => typeof key !== "string"
        || !ARTIFACT_OPTION_FIELDS.includes(key as typeof ARTIFACT_OPTION_FIELDS[number]))
      || REQUIRED_ARTIFACT_OPTION_FIELDS.some((field) => !keys.includes(field))) return null;
    const result = {
      environment: undefined,
      sharinganCaptures: undefined,
      onEvent: undefined,
      reportError: undefined,
    } as Record<typeof ARTIFACT_OPTION_FIELDS[number], unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key as string]!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) return null;
      result[key as typeof ARTIFACT_OPTION_FIELDS[number]] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function requireConfiguration(
  options: ProductionArtifactRunAdapterOptions,
): {
  contextPacks: ArtifactRunPreparationOptions["contextPacks"];
  projectIdForWorkspace: ArtifactRunPreparationOptions["projectIdForWorkspace"];
  repositoryDirForWorkspace: ArtifactRunPreparationOptions["repositoryDirForWorkspace"];
  baseSystemPrompt: ArtifactRunPreparationOptions["baseSystemPrompt"];
  environment: ArtifactRunPreparationOptions["environment"];
  sharinganCaptures: ArtifactRunPreparationOptions["sharinganCaptures"];
  onEvent: ArtifactRunExecutorOptions["onEvent"];
  reportError: ArtifactRunExecutorOptions["reportError"];
  createAgentRunner: ProductionArtifactAgentAdapter["createRunner"];
  createQuality: ProductionArtifactRunAdapterOptions["quality"];
} {
  const configuration = artifactOptions(options);
  const contextPackGet = dataMethod<ArtifactRunPreparationOptions["contextPacks"]["get"]>(
    configuration?.contextPacks,
    "get",
  );
  if (configuration === null || contextPackGet === null
    || typeof configuration.projectIdForWorkspace !== "function"
    || typeof configuration.repositoryDirForWorkspace !== "function"
    || typeof configuration.baseSystemPrompt !== "function"
    || (configuration.environment !== undefined && typeof configuration.environment !== "function")
    || (configuration.onEvent !== undefined && typeof configuration.onEvent !== "function")
    || (configuration.reportError !== undefined && typeof configuration.reportError !== "function")) {
    throw new ProductionArtifactRunAdapterError(
      "PRODUCTION_ARTIFACT_CONFIGURATION_INVALID",
      "Production Artifact run adapter configuration is invalid",
      "build-infrastructure",
    );
  }
  const createAgentRunner = dataMethod<ProductionArtifactAgentAdapter["createRunner"]>(
    configuration.agent,
    "createRunner",
  );
  if (createAgentRunner === null) {
    throw new ProductionArtifactRunAdapterError(
      "PRODUCTION_ARTIFACT_AGENT_UNAVAILABLE",
      "Production Artifact Agent adapter is unavailable",
      "adapter",
    );
  }
  if (typeof configuration.quality !== "function") {
    throw new ProductionArtifactRunAdapterError(
      "PRODUCTION_ARTIFACT_QUALITY_UNAVAILABLE",
      "Production Artifact quality adapter is unavailable",
      "build-infrastructure",
    );
  }
  const sharinganMaterialize = configuration.sharinganCaptures === undefined
    ? null
    : dataMethod<NonNullable<ArtifactRunPreparationOptions["sharinganCaptures"]>["materializeExactRevision"]>(
      configuration.sharinganCaptures,
      "materializeExactRevision",
    );
  if (configuration.sharinganCaptures !== undefined && sharinganMaterialize === null) {
    throw new ProductionArtifactRunAdapterError(
      "PRODUCTION_ARTIFACT_CONFIGURATION_INVALID",
      "Production Sharingan Capture materializer is invalid",
      "build-infrastructure",
    );
  }
  const owner = options as unknown as object;
  return {
    contextPacks: Object.freeze({ get: contextPackGet }),
    projectIdForWorkspace: (configuration.projectIdForWorkspace as ArtifactRunPreparationOptions["projectIdForWorkspace"]).bind(owner),
    repositoryDirForWorkspace: (configuration.repositoryDirForWorkspace as ArtifactRunPreparationOptions["repositoryDirForWorkspace"]).bind(owner),
    baseSystemPrompt: (configuration.baseSystemPrompt as ArtifactRunPreparationOptions["baseSystemPrompt"]).bind(owner),
    environment: configuration.environment === undefined
      ? undefined
      : (configuration.environment as NonNullable<ArtifactRunPreparationOptions["environment"]>).bind(owner),
    sharinganCaptures: sharinganMaterialize === null
      ? undefined
      : Object.freeze({ materializeExactRevision: sharinganMaterialize }),
    onEvent: configuration.onEvent === undefined
      ? undefined
      : (configuration.onEvent as NonNullable<ArtifactRunExecutorOptions["onEvent"]>).bind(owner),
    reportError: configuration.reportError === undefined
      ? undefined
      : (configuration.reportError as NonNullable<ArtifactRunExecutorOptions["reportError"]>).bind(owner),
    createAgentRunner,
    createQuality: (configuration.quality as ProductionArtifactRunAdapterOptions["quality"]).bind(owner),
  };
}

function declaredFailure(error: unknown): boolean {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return false;
  try {
    return typeof Reflect.get(error, "failureClass") === "string";
  } catch {
    return false;
  }
}

/**
 * Production composition for one Page/Component leaf. The only Agent entry is
 * the explicit injected adapter; candidate transaction, immutable Context/Base,
 * Standard quality loop, visual evidence, version retention and cleanup remain
 * owned by the hardened leaf implementations.
 */
export function createProductionArtifactRunExecutor(
  options: ProductionArtifactRunAdapterOptions,
): ArtifactRunExecutor {
  const configuration = requireConfiguration(options);
  const { createAgentRunner, createQuality } = configuration;
  const preparation = new DefaultArtifactRunPreparation({
    contextPacks: configuration.contextPacks,
    projectIdForWorkspace: configuration.projectIdForWorkspace,
    repositoryDirForWorkspace: configuration.repositoryDirForWorkspace,
    baseSystemPrompt: configuration.baseSystemPrompt,
    environment: configuration.environment,
    sharinganCaptures: configuration.sharinganCaptures,
    async createRunner(input, signal) {
      let rawRunner: AgentRunner;
      try {
        rawRunner = await createAgentRunner(input, signal);
      } catch (error) {
        if (declaredFailure(error)) throw error;
        throw new ProductionArtifactRunAdapterError(
          "PRODUCTION_ARTIFACT_AGENT_UNAVAILABLE",
          "Production Artifact Agent adapter failed during isolated runner creation",
          "adapter",
          error,
        );
      }
      const runner = pinnedRunner(rawRunner);
      if (runner === null) {
        throw new ProductionArtifactRunAdapterError(
          "PRODUCTION_ARTIFACT_AGENT_UNAVAILABLE",
          "Production Artifact Agent adapter returned an invalid runner",
          "adapter",
        );
      }
      return runner;
    },
    async createQualityEvaluator(input, signal) {
      let configuration: ProductionArtifactQualityConfiguration;
      try {
        configuration = await createQuality(input, signal);
      } catch (error) {
        if (declaredFailure(error)) throw error;
        throw new ProductionArtifactRunAdapterError(
          "PRODUCTION_ARTIFACT_QUALITY_UNAVAILABLE",
          "Production Artifact quality adapter failed during exact evaluator creation",
          "build-infrastructure",
          error,
        );
      }
      try {
        return new ProductionStandardArtifactQualityEvaluator({
          ...configuration,
          infrastructure: input,
          projectId: input.projectId,
        });
      } catch (error) {
        if (declaredFailure(error)) throw error;
        throw new ProductionArtifactRunAdapterError(
          "PRODUCTION_ARTIFACT_QUALITY_UNAVAILABLE",
          "Production Artifact quality adapter returned invalid configuration",
          "build-infrastructure",
          error,
        );
      }
    },
  });
  return new ArtifactRunExecutor({
    preparation,
    onEvent: configuration.onEvent,
    reportError: configuration.reportError,
  });
}
