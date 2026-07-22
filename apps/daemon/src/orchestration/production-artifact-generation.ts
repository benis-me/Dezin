import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative as relativePath,
  resolve,
  sep,
} from "node:path";

import type {
  AgentRunner,
  AgentTurnInput,
  AgentTurnResult,
} from "../../../../packages/agent/src/index.ts";
import type {
  GenerationTaskFailureClass,
  Settings,
  Store,
} from "../../../../packages/core/src/index.ts";
import type { DesignRegistry } from "../../../../packages/design/src/index.ts";
import {
  buildAgentEnv,
  hydrateVisualReviewerSettings,
} from "../agent-env.ts";
import { inspectBoundedPngImage } from "../artifact-thumbnail.ts";
import {
  generateImages,
  type FetchLike,
} from "../image-gen.ts";
import { createProviderFetch } from "../provider-fetch.ts";
import { createWorkspaceContextPackRepository } from "../context/context-pack-store.ts";
import type { ContextPack } from "../context/context-types.ts";
import { buildRunner } from "../run-handler.ts";
import type { SharinganCaptureRevisionMaterializerPort } from "./sharingan-capture-reference.ts";
import {
  createProductionArtifactRunExecutor,
  type ProductionArtifactRunAdapterOptions,
} from "./production-artifact-run-adapter.ts";
import { createProductionArtifactProviderRunner } from "./production-artifact-provider-sandbox.ts";
import { createProductionArtifactAgentExecutionPorts } from "./target-confined-artifact-agent.ts";
import {
  hydrateArtifactImageGeneration,
  hydrateArtifactExecutionSettings,
  requireArtifactExecutionProfile,
  type BoundArtifactImageGeneration,
  type ArtifactExecutionProfileOwnership,
} from "./production-generation-context.ts";
import type {
  ProductionStandardArtifactQualityEvaluatorDependencies,
} from "./standard-artifact-quality-evaluator.ts";

export interface ProductionArtifactGenerationOptions {
  readonly store: Store;
  readonly dataDir: string;
  readonly designRegistry: DesignRegistry;
  readonly repositoryDirForWorkspace: (
    workspaceId: string,
    signal: AbortSignal,
  ) => string | Promise<string>;
  readonly sharinganCaptures?: SharinganCaptureRevisionMaterializerPort;
  readonly onEvent?: ProductionArtifactRunAdapterOptions["onEvent"];
  readonly reportError?: ProductionArtifactRunAdapterOptions["reportError"];
  /** Test seam; production always uses the confined Artifact provider factory. */
  readonly createRunner?: typeof buildRunner;
  /** Test seam for external preview/render services; the production quality evaluator remains real. */
  readonly qualityDependencies?: ProductionStandardArtifactQualityEvaluatorDependencies;
}

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function projectIdForWorkspace(store: Store, workspaceId: string): string {
  const projectIds = store.listProjects()
    .filter((project) => store.workspace.getWorkspace(project.id)?.id === workspaceId)
    .map((project) => project.id)
    .sort(compareBinary);
  if (projectIds.length !== 1) {
    throw new Error(`Artifact generation Workspace has no unique Project owner: ${workspaceId}`);
  }
  return projectIds[0]!;
}

export interface BoundArtifactExecutionProfile {
  readonly agentCommand: string;
  readonly providerId: string;
  readonly model: string | undefined;
  readonly hasExactSharinganCapture: boolean;
  readonly settings: Settings;
  /** Quality-process-only settings with only the exact Claude reviewer credential restored. */
  readonly qualitySettings: Settings;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly baseSystemPrompt: string;
  readonly directionSpec: string | undefined;
  readonly imageGeneration: BoundArtifactImageGeneration;
  readonly expectedSharinganRequestedUrl: string | undefined;
  readonly qualityIgnores: readonly {
    readonly ruleId: string;
    readonly selector: string | null;
  }[];
}

export interface ProductionArtifactImagePostprocessingRunnerOptions {
  readonly runner: AgentRunner;
  readonly worktreeDir: string;
  readonly imageGeneration: BoundArtifactImageGeneration;
  readonly fetchImpl?: FetchLike;
  /** Test seam that may only lower the built-in image output ceiling. */
  readonly maxOutputBytes?: number;
}

export class ProductionArtifactImagePostprocessingError extends Error {
  readonly code:
    | "IMAGE_GENERATION_DISABLED"
    | "IMAGE_GENERATION_CREDENTIAL_UNAVAILABLE"
    | "IMAGE_GENERATION_PROVIDER_FAILED"
    | "IMAGE_GENERATION_OUTPUT_INVALID"
    | "IMAGE_GENERATION_PLACEHOLDER_INVALID"
    | "IMAGE_GENERATION_PATH_INVALID"
    | "IMAGE_GENERATION_WRITE_FAILED";
  readonly failureClass: GenerationTaskFailureClass;

  constructor(
    code: ProductionArtifactImagePostprocessingError["code"],
    message: string,
    failureClass: GenerationTaskFailureClass,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ProductionArtifactImagePostprocessingError";
    this.code = code;
    this.failureClass = failureClass;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function pathFailure(message: string, cause?: unknown): ProductionArtifactImagePostprocessingError {
  return new ProductionArtifactImagePostprocessingError(
    "IMAGE_GENERATION_PATH_INVALID",
    message,
    "build-infrastructure",
    cause,
  );
}

function nodeErrorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error
    && typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code!
    : null;
}

async function canonicalWorktreeDir(value: string): Promise<string> {
  try {
    const canonical = await realpath(value);
    const stats = await lstat(canonical);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("not a plain directory");
    }
    return canonical;
  } catch (error) {
    throw pathFailure("Artifact image postprocessing worktree is unavailable", error);
  }
}

async function assertPlainDirectoryTree(root: string, directory: string): Promise<void> {
  const absolute = resolve(directory);
  if (!inside(root, absolute)) {
    throw pathFailure("Artifact image asset directory escapes its isolated worktree");
  }
  const relative = relativePath(root, absolute);
  const segments = relative === "" ? [] : relative.split(sep);
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw pathFailure("Artifact image path contains a symlink or non-directory component");
      }
    } catch (error) {
      if (error instanceof ProductionArtifactImagePostprocessingError) throw error;
      throw pathFailure("Artifact image directory is unavailable", error);
    }
  }
}

async function ensureConfinedAssetsDirectory(root: string, artifactPath: string): Promise<string> {
  const parent = dirname(artifactPath);
  await assertPlainDirectoryTree(root, parent);
  const assetsDir = join(parent, "assets");
  try {
    await mkdir(assetsDir, { mode: 0o700 });
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") {
      throw pathFailure("Artifact image assets directory could not be created", error);
    }
  }
  await assertPlainDirectoryTree(root, assetsDir);
  return assetsDir;
}

async function assertCanonicalArtifactFile(
  root: string,
  filePath: string,
  expectedHtml: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await assertPlainDirectoryTree(root, dirname(filePath));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw pathFailure("Canonical Artifact is a symlink or non-file entry");
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) throw pathFailure("Canonical Artifact is not a regular file");
    const actualHtml = await handle.readFile("utf8");
    if (actualHtml !== expectedHtml) {
      throw pathFailure("Canonical Artifact bytes do not match the Agent result");
    }
  } catch (error) {
    if (error instanceof ProductionArtifactImagePostprocessingError) throw error;
    throw pathFailure("Canonical Artifact cannot be inspected safely", error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertConfinedFileDestination(root: string, filePath: string): Promise<void> {
  if (!inside(root, resolve(filePath))) {
    throw pathFailure("Artifact image output escapes its isolated worktree");
  }
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw pathFailure("Artifact image output collides with a symlink or non-file entry");
    }
  } catch (error) {
    if (error instanceof ProductionArtifactImagePostprocessingError) throw error;
    if (nodeErrorCode(error) !== "ENOENT") {
      throw pathFailure("Artifact image output cannot be inspected safely", error);
    }
  }
}

async function atomicWriteConfinedFile(
  root: string,
  filePath: string,
  bytes: Uint8Array | string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await assertPlainDirectoryTree(root, dirname(filePath));
  await assertConfinedFileDestination(root, filePath);
  const tempPath = join(dirname(filePath), `.${posix.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    signal?.throwIfAborted();
    await assertPlainDirectoryTree(root, dirname(filePath));
    await assertConfinedFileDestination(root, filePath);
    await rename(tempPath, filePath);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof ProductionArtifactImagePostprocessingError) throw error;
    throw new ProductionArtifactImagePostprocessingError(
      "IMAGE_GENERATION_WRITE_FAILED",
      "Artifact image output could not be written atomically inside the isolated worktree",
      "build-infrastructure",
      error,
    );
  } finally {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
  }
}

function artifactPathInWorktree(worktreeDir: string, value: string | undefined): {
  absolute: string;
  relative: string;
} {
  const relative = value ?? "index.html";
  if (relative.length === 0 || relative.length > 4_096 || relative.includes("\\")
    || isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new ProductionArtifactImagePostprocessingError(
      "IMAGE_GENERATION_PATH_INVALID",
      "Artifact image postprocessing path escapes its isolated worktree",
      "build-infrastructure",
    );
  }
  const normalized = posix.normalize(relative);
  const absolute = resolve(worktreeDir, ...normalized.split("/"));
  if (normalized !== relative || normalized === "." || normalized.startsWith("../")
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || !inside(worktreeDir, absolute)) {
    throw new ProductionArtifactImagePostprocessingError(
      "IMAGE_GENERATION_PATH_INVALID",
      "Artifact image postprocessing path escapes its isolated worktree",
      "build-infrastructure",
    );
  }
  return { absolute, relative };
}

function imageGenerationOptions(binding: BoundArtifactImageGeneration) {
  return {
    baseUrl: binding.baseUrl,
    apiKey: binding.apiKey,
    model: binding.model,
    providerId: binding.providerId,
    apiVersion: binding.apiVersion,
    params: { outputFormat: "png" as const },
  };
}

/** Adds the frozen image-generation postprocessor to every exact Agent turn. */
export function createProductionArtifactImagePostprocessingRunner(
  options: ProductionArtifactImagePostprocessingRunnerOptions,
): AgentRunner {
  return Object.freeze({
    id: `image-postprocessed:${options.runner.id}`,
    async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
      const result = await options.runner.runTurn(input);
      input.signal?.throwIfAborted();
      if (!/<img\b[^>]*\bdata-gen-prompt\b/i.test(result.artifactHtml)) return result;
      if (!options.imageGeneration.enabled) {
        throw new ProductionArtifactImagePostprocessingError(
          "IMAGE_GENERATION_DISABLED",
          "Artifact contains an image generation marker, but frozen image generation is disabled. Remove the generation marker or enable image generation before creating a new Plan.",
          "design",
        );
      }
      if (!options.imageGeneration.apiKey.trim()) {
        throw new ProductionArtifactImagePostprocessingError(
          "IMAGE_GENERATION_CREDENTIAL_UNAVAILABLE",
          `Artifact requires image generation, but the credential for the exact ${options.imageGeneration.providerId} provider is unavailable. Configure that provider or remove the generation marker before retrying.`,
          "provider",
        );
      }
      const worktreeDir = await canonicalWorktreeDir(options.worktreeDir);
      const target = artifactPathInWorktree(worktreeDir, result.artifactPath);
      await assertCanonicalArtifactFile(
        worktreeDir,
        target.absolute,
        result.artifactHtml,
        input.signal,
      );
      const assetsDir = await ensureConfinedAssetsDirectory(worktreeDir, target.absolute);
      const media = await generateImages(
        result.artifactHtml,
        imageGenerationOptions(options.imageGeneration),
        assetsDir,
        options.fetchImpl ?? createProviderFetch(),
        {
          signal: input.signal,
          stopOnFailure: true,
          maxOutputBytes: options.maxOutputBytes,
          validateImage: async (bytes, signal) => {
            await inspectBoundedPngImage(bytes, signal);
          },
          writeAsset: (asset, signal) => atomicWriteConfinedFile(
            worktreeDir,
            join(assetsDir, asset.fileName),
            asset.bytes,
            signal,
          ),
        },
      );
      input.signal?.throwIfAborted();
      if (media.failed > 0) {
        const failure = media.failures[0];
        if (failure?.cause instanceof ProductionArtifactImagePostprocessingError) {
          throw failure.cause;
        }
        if (failure?.stage === "validation" || failure?.stage === "output") {
          throw new ProductionArtifactImagePostprocessingError(
            "IMAGE_GENERATION_OUTPUT_INVALID",
            "Artifact image provider did not return a valid bounded PNG. Retry with the configured provider or replace the generation marker with a real asset.",
            "provider",
          );
        }
        if (failure?.stage === "prompt") {
          throw new ProductionArtifactImagePostprocessingError(
            "IMAGE_GENERATION_PLACEHOLDER_INVALID",
            `Artifact image placeholder is invalid: ${failure.message}. Reduce or repair the generation markers before retrying.`,
            "design",
          );
        }
        throw new ProductionArtifactImagePostprocessingError(
          "IMAGE_GENERATION_PROVIDER_FAILED",
          `Artifact image generation provider failed: ${failure?.message ?? "unknown provider failure"}`,
          "provider",
        );
      }
      if (/<img\b[^>]*\bdata-gen-prompt\b/i.test(media.html)) {
        throw new ProductionArtifactImagePostprocessingError(
          "IMAGE_GENERATION_PLACEHOLDER_INVALID",
          "Artifact left an image generation marker without a valid quoted prompt. Use a valid quoted prompt or replace the marker with a real asset before retrying.",
          "design",
        );
      }
      await atomicWriteConfinedFile(worktreeDir, target.absolute, media.html, input.signal);
      return Object.freeze({
        text: result.text,
        artifactHtml: media.html,
        artifactPath: target.relative,
      });
    },
  });
}

/**
 * Creates the one per-Attempt non-persistent runtime binding. Only credential
 * values come from live state; all behavior is
 * read from the immutable Context Pack profile.
 */
export function bindArtifactExecutionProfile(input: {
  readonly contextPack: ContextPack;
  readonly ownership: ArtifactExecutionProfileOwnership;
  readonly liveSettings: Settings;
}): BoundArtifactExecutionProfile {
  const profile = requireArtifactExecutionProfile(input.contextPack, input.ownership);
  const settings = hydrateArtifactExecutionSettings(profile, input.liveSettings);
  const qualitySettings = hydrateVisualReviewerSettings(
    settings,
    input.liveSettings,
    profile.quality.reviewer,
  );
  return Object.freeze({
    agentCommand: profile.agent.command,
    providerId: profile.agent.providerId,
    model: profile.agent.model ?? undefined,
    hasExactSharinganCapture: profile.hasExactSharinganCapture,
    settings: Object.freeze(settings),
    qualitySettings: Object.freeze(qualitySettings),
    environment: Object.freeze({
      ...buildAgentEnv(settings, profile.agent.command),
      // A scoped Page/Component Agent must never inherit the daemon-wide bearer
      // capability, even when the daemon itself was launched with it in process.env.
      DEZIN_DAEMON_TOKEN: undefined,
    }),
    baseSystemPrompt: profile.prompt.systemPrompt,
    directionSpec: profile.researchDirection?.content,
    imageGeneration: hydrateArtifactImageGeneration(profile, input.liveSettings),
    expectedSharinganRequestedUrl: profile.quality.expectedSharinganRequestedUrl ?? undefined,
    qualityIgnores: Object.freeze(profile.quality.ignores.map((entry) => Object.freeze({ ...entry }))),
  });
}

/**
 * Complete production Page/Component leaf composition. Every attempt uses the
 * exact Context Pack and Git base prepared by the shared executor while keeping
 * Dezin's existing design-system, skills, craft, BYOK Agent, runtime, visual QA,
 * evidence, repair, and Sharingan contracts intact.
 */
export function createProductionArtifactGenerationExecutor(
  options: ProductionArtifactGenerationOptions,
) {
  const contextPacks = createWorkspaceContextPackRepository(options.store.workspace, {
    manifestRoot: options.dataDir,
  });
  const attemptBindings = new WeakMap<object, {
    readonly binding: BoundArtifactExecutionProfile;
    readonly ports: ReturnType<typeof createProductionArtifactAgentExecutionPorts>;
  }>();
  const exactProjectId = (workspaceId: string): string => (
    projectIdForWorkspace(options.store, workspaceId)
  );
  const ownership = (infrastructure: {
    projectId: string;
    claim: { task: { workspaceId: string; planId: string; id: string; target: { type: string; id: string } } };
  }): ArtifactExecutionProfileOwnership => {
    if (infrastructure.claim.task.target.type !== "artifact") {
      throw new Error("Artifact execution profile received a non-Artifact target");
    }
    return {
      projectId: infrastructure.projectId,
      workspaceId: infrastructure.claim.task.workspaceId,
      planId: infrastructure.claim.task.planId,
      taskId: infrastructure.claim.task.id,
      targetArtifactId: infrastructure.claim.task.target.id,
    };
  };
  const exactBinding = (infrastructure: object): {
    readonly binding: BoundArtifactExecutionProfile;
    readonly ports: ReturnType<typeof createProductionArtifactAgentExecutionPorts>;
  } => {
    const exact = attemptBindings.get(infrastructure);
    if (!exact) throw new Error("Artifact execution runtime binding is unavailable for this exact Attempt");
    return exact;
  };

  return createProductionArtifactRunExecutor({
    contextPacks,
    projectIdForWorkspace: (workspaceId) => exactProjectId(workspaceId),
    repositoryDirForWorkspace: options.repositoryDirForWorkspace,
    agent: {
      async createRunner(infrastructure): Promise<AgentRunner> {
        const binding = bindArtifactExecutionProfile({
          contextPack: infrastructure.contextPack,
          ownership: ownership(infrastructure),
          liveSettings: options.store.getSettings(),
        });
        if (binding.hasExactSharinganCapture !== infrastructure.hasExactSharinganCapture) {
          throw new Error(
            "Artifact execution Sharingan semantic does not match prepared immutable Capture context",
          );
        }
        const ports = createProductionArtifactAgentExecutionPorts({
          createRunner: () => options.createRunner === undefined
            ? createProductionArtifactProviderRunner({
                providerId: binding.providerId,
                command: binding.agentCommand,
                model: binding.model,
                worktreeDir: infrastructure.worktreeDir,
                enforceArtifactUpdate: false,
              })
            : options.createRunner(
                binding.settings,
                { agentCommand: binding.agentCommand, model: binding.model },
                { enforceArtifactUpdate: false },
              ),
          extraEnvironment: binding.environment,
        });
        attemptBindings.set(infrastructure, { binding, ports });
        const runner = await ports.createRunner(infrastructure);
        return createProductionArtifactImagePostprocessingRunner({
          runner,
          worktreeDir: infrastructure.worktreeDir,
          imageGeneration: binding.imageGeneration,
        });
      },
    },
    environment(infrastructure) {
      return exactBinding(infrastructure).ports.environment(infrastructure);
    },
    baseSystemPrompt(infrastructure) {
      return exactBinding(infrastructure).binding.baseSystemPrompt;
    },
    quality(infrastructure) {
      const { binding } = exactBinding(infrastructure);
      return {
        settings: binding.qualitySettings,
        dataDir: options.dataDir,
        agentCommand: binding.agentCommand,
        model: binding.model,
        directionSpec: binding.directionSpec,
        expectedSharinganRequestedUrl: binding.expectedSharinganRequestedUrl,
        qualityIgnores: binding.qualityIgnores,
        ...(options.qualityDependencies === undefined
          ? {}
          : { dependencies: options.qualityDependencies }),
      };
    },
    sharinganCaptures: options.sharinganCaptures,
    onEvent: options.onEvent,
    reportError: options.reportError,
  });
}
