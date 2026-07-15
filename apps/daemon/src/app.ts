/**
 * The Dezin daemon HTTP app. A tiny node:http server with a hand-rolled router —
 * a lean HTTP server scoped to exactly what Dezin needs. This iteration: health,
 * project CRUD, conversations, and static artifact serving. POST /api/runs (the
 * generate loop) lands in the next iteration.
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../../packages/core/src/index.ts";
import type { ConversationScope, CreateProjectInput, ExtensionScope, Project, Settings } from "../../../packages/core/src/index.ts";
import type { AgentRunner } from "../../../packages/agent/src/index.ts";
import type { DesignRegistry } from "../../../packages/design/src/index.ts";
import { HttpError, sendJson, sendError, send, readJsonBody, readRawBody, matchPath, isHttpError } from "./http-util.ts";
import { scoreTrend } from "../../../packages/quality/src/index.ts";
import { serveProjectFile, serveFileFromBase, projectDir } from "./serve-static.ts";
import { figToJson, summarizeFig } from "./parse-fig.ts";
import { serveWeb, defaultWebDir } from "./serve-web.ts";
import { handleRun, handleRunStream, handleCancelRun, handleRunFeedback } from "./run-handler.ts";
import type { ResearchPhaseRunner } from "./research-phase.ts";
import { handlePreferenceSuggest, type PreferenceSuggester } from "./preference-reflect.ts";
import { handleExport, handleImportProject } from "./export-handler.ts";
import { handleListFiles } from "./files-handler.ts";
import { handleGetResearch } from "./research-handler.ts";
import {
  handleListVariants,
  handleVariantFanout,
  handleCreateVariant,
  handleForkMessage,
  handleActivateVariant,
  handleRenameVariant,
  handleDeleteVariant,
} from "./variants-handler.ts";
import { handleGetVersion, handleGetVersionFile, handleGetVersionPreviewUrl, handleGetVersionDiff, handleGetVersionSource, handleRestoreVersion, handleSetVersionCover } from "./versions-handler.ts";
import { handleUploadRef } from "./refs-handler.ts";
import {
  setupStandardProject,
  getSetup,
  ensureDevServer,
  releaseDevServer,
  releaseProjectRuntime,
  releaseVariantRuntime,
  stopAllProjectRuntimes,
  type PreviewRuntimeOptions,
} from "./project-runtime.ts";
import { handleSharinganStart, handleSharinganCancel, handleSharinganStatus, handleSharinganShot, handleSharinganEvents, handleSharinganContinue, handleSharinganFocus, handleSharinganNavigate, handleSharinganReadDom, handleSharinganComputedStyles, handleSharinganLinks, handleSharinganClick, handleSharinganScroll, handleSharinganCapture, closeAllSharinganSessions, releaseSharinganProject, removeSharinganProjectProfiles, sharinganRunCaptureId, type SharinganOpen } from "./sharingan-handler.ts";
import { activeArtifactDir, variantArtifactDir, variantRuntimeKey, isStandardRootVariant, removeStandardVariantWorktree, removeStandardVersionWorktree } from "./variant-workspaces.ts";
import { RuntimeScopeUnavailableError, RuntimeSupervisor } from "./runtime-supervisor.ts";
import { handleListDesignSystems, handleGetDesignSystem, handleImportBrand, handleListSkills } from "./catalog-handler.ts";
import { handleCreateEffect, handleGetEffect, handleListEffects, handleUpdateEffect } from "./effects-handler.ts";
import { handleListAgents, handleRescanAgents, handleScanAgentsStream, warmAgents, type AgentProber } from "./agents-handler.ts";
import { handleListModelProviderModels, handleTestModelProvider } from "./model-provider-handler.ts";
import { analyzeImage } from "./analyze-image.ts";
import { buildAgentEnv } from "./agent-env.ts";
import { optimizePrompt, type PromptOptimizer } from "./prompt-optimize.ts";
import {
  captureCover,
  captureCoverUrl,
  type ArtifactThumbnailCapture,
} from "./capture-cover.ts";
import type {
  ApplyArtifactMutationInput,
  ArtifactMutationCandidateContext,
} from "./artifact-mutation.ts";
import type { ArtifactThumbnailRenderer } from "./artifact-thumbnail.ts";
import type { VisualQaRunner } from "./visual-qa.ts";
import { handleGenerateProjectTitle, type TitleGenerator } from "./title-handler.ts";
import {
  handleCreateMoodboard,
  handleCreateMoodboardConversation,
  handleDeleteMoodboard,
  handleDeleteMoodboardConversation,
  handleGenerateMoodboardImage,
  handleGetMoodboard,
  handleListMoodboardConversationMessages,
  handleListMoodboardConversations,
  handleListMoodboardMessages,
  handleListMoodboardNodes,
  handleListMoodboards,
  handlePatchMoodboard,
  handlePostMoodboardMessage,
  handlePutMoodboardNodes,
  handleRenameMoodboardConversation,
  recoverIncompleteMoodboards,
  handleServeMoodboardAsset,
  handleStartMoodboard,
  handleUploadMoodboardAsset,
} from "./moodboard-handler.ts";
import type { MoodboardAgentTextRunner } from "./moodboard-agent.ts";
import {
  assertSafeId,
  redactSettings,
  requireDaemonRequest,
  requireExtensionPairingRequest,
  type DaemonSecurityOptions,
} from "./security.ts";
import { mergeProviderProfilesForUpdate } from "./provider-profile-config.ts";
import {
  StoreExtensionPairingService,
  type ExtensionPairingService,
} from "./extension-auth.ts";
import { removeStandardRunTransaction } from "./standard-run-transaction.ts";
import {
  previewLeaseManager,
  requirePreviewLease,
  type PreviewLease,
  type PreviewLeaseManager,
} from "./preview-lease.ts";
import {
  handleApproveProposal,
  handleCreateResource,
  handleCreateResourceRevision,
  handleCreateProposal,
  handleGetArtifactRevision,
  handleGetProposal,
  handleGetResource,
  handleGetWorkspace,
  handleGetWorkspaceArtifact,
  handleGetWorkspaceSnapshot,
  handleGraphCommands,
  handleListArtifactRevisions,
  handleListArtifactTracks,
  handleListProposals,
  handleListResourceRevisions,
  handleListResources,
  handleListWorkspaceArtifacts,
  handleListWorkspaceSnapshots,
  handlePutWorkspaceLayout,
  handlePublishResourceRevision,
  handleRejectProposal,
  handleUpdateProposal,
  handleUpdateResource,
} from "./workspace-handler.ts";
import {
  handleAcquirePreviewTargetLease,
  handleResolvePreviewTarget,
} from "./preview-target-handler.ts";
import {
  handleArtifactMutation,
  handleArtifactThumbnail,
} from "./artifact-editor-handler.ts";
import { ensureStandardProjectWorkspace } from "./workspace-migration.ts";
import type { SafeBoundedExternalFetcher } from "./resource-revision-source.ts";

export type DevServerLease = Pick<PreviewLease, "url"> & Partial<Omit<PreviewLease, "url">>;

export interface AppDeps {
  store: Store;
  /** Root for on-disk artifacts: <dataDir>/projects/<id>/... */
  dataDir: string;
  version?: string;
  /** Agent runner used by POST /api/runs. Without it, runs return 501. */
  runner?: AgentRunner;
  /** Design-system registry (defaults to the bundled one). */
  designRegistry?: DesignRegistry;
  /** Agent availability prober for GET /api/agents (defaults to a real spawn probe). */
  agentProber?: AgentProber;
  /** Serve the built web app from here (SPA). Defaults to apps/web/dist when it exists. */
  webDir?: string;
  /** Visual QA runner for final prototype artifacts (defaults to screenshot + geometry checks). */
  visualQa?: VisualQaRunner;
  /** Standard project setup hook; tests can replace the slow npm-installing default. */
  standardProjectSetup?: (projectId: string, projectDir: string, signal?: AbortSignal) => void | Promise<void>;
  /** Standard dev-server hooks; tests can avoid spawning npm. */
  ensureDevServer?: (
    projectId: string,
    projectDir: string,
    runtimeKey?: string,
    signal?: AbortSignal,
    leaseManager?: PreviewLeaseManager,
    options?: PreviewRuntimeOptions,
  ) => Promise<DevServerLease>;
  releaseDevServer?: typeof releaseDevServer;
  /** Daemon-owned preview process leases; tests may inject a deterministic manager. */
  previewLeaseManager?: PreviewLeaseManager;
  /** Cover capture hook for Standard dev-server URLs; tests can avoid launching Chrome. */
  captureCoverUrl?: (url: string, outPath: string, signal?: AbortSignal) => Promise<boolean>;
  /** Cover capture hook for HTML snapshot files; tests can avoid launching Chrome. */
  captureCover?: (htmlPath: string, outPath: string, signal?: AbortSignal) => Promise<boolean>;
  /** Additional project-specific validation after the built-in bounded source parser succeeds. */
  artifactMutationValidator?: (candidate: ArtifactMutationCandidateContext) => void | Promise<void>;
  /** Immutable Resource Revision URL resolver for the bounded set-asset command. */
  artifactMutationAssetResolver?: NonNullable<ApplyArtifactMutationInput["resolveAssetSource"]>;
  /** Exact immutable Artifact Revision thumbnail renderer; null explicitly disables rendering. */
  artifactThumbnailRenderer?: ArtifactThumbnailRenderer | null;
  /** Low-level exact-frame capture hook used by the production thumbnail renderer. */
  artifactThumbnailCapture?: ArtifactThumbnailCapture;
  /** Sharingan browser opener; tests can delay session creation without launching Chrome. */
  sharinganOpen?: SharinganOpen;
  /** Import continuation checkpoint; tests can pause immediately after project ownership is registered. */
  importProjectCreated?: (projectId: string, signal?: AbortSignal) => void | Promise<void>;
  /** Prototype activation checkpoint; tests can pause after the target snapshot reaches the root. */
  prototypeVariantRestored?: (projectId: string, variantId: string, signal?: AbortSignal) => void | Promise<void>;
  /** Prototype message-fork checkpoint used to coordinate ownership around the root-file handoff. */
  prototypeMessageForkCheckpoint?: (
    projectId: string,
    variantId: string,
    phase: "before-root-overwrite" | "after-root-overwrite" | "before-rollback",
    signal?: AbortSignal,
  ) => void | Promise<void>;
  /** Variant creation/rollback checkpoint used to verify exact-scope ownership sequencing. */
  variantMutationCheckpoint?: (
    projectId: string,
    variantId: string,
    phase: "created" | "before-rollback",
    signal?: AbortSignal,
  ) => void | Promise<void>;
  /** Background title generator hook; tests can avoid launching an agent. */
  titleGenerator?: TitleGenerator;
  /** Prompt optimizer hook; tests can avoid launching a real agent. */
  promptOptimizer?: PromptOptimizer;
  /** Research phase hook; tests can avoid launching a real research agent. */
  researchPhase?: ResearchPhaseRunner;
  /** Preference reflection hook; tests can avoid launching a real agent. */
  preferenceSuggester?: PreferenceSuggester;
  /** Moodboard chat one-shot agent hook; tests can avoid launching a real CLI. */
  moodboardAgentText?: MoodboardAgentTextRunner;
  /** Provider model-list fetcher; tests can avoid real network calls. */
  modelProviderFetch?: typeof fetch;
  /** Optional local API boundary guard. */
  security?: DaemonSecurityOptions;
  /** Scoped browser-extension pairing service; defaults to the persistent Store implementation. */
  extensionPairing?: ExtensionPairingService;
  /** Image analyzer hook; tests can avoid launching a real agent. */
  imageAnalyzer?: typeof analyzeImage;
  /** Trusted DNS-pinned, redirect-revalidated, byte-bounded external Resource fetch boundary. */
  resourceExternalFetch?: SafeBoundedExternalFetcher;
  /** Unique owner id for this daemon process; persisted on newly-created runs. */
  daemonOwnerId?: string;
  /** Daemon-owned scoped runtime lifecycle; createApp supplies the production instance by default. */
  runtimeSupervisor?: RuntimeSupervisor;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
  extensionPairing: ExtensionPairingService,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
  publicRead?: boolean;
  extensionScope?: ExtensionScope;
  extensionPairing?: boolean;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function exactRequestRecord(
  value: unknown,
  label: string,
  allowedFields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedFields);
  const unexpected = Object.keys(record).find((field) => !allowed.has(field));
  if (unexpected) throw new HttpError(400, `${label} contains unexpected field: ${unexpected}`);
  return record;
}

function parseConversationScope(value: unknown, projectId: string): ConversationScope {
  const input = exactRequestRecord(value, "Conversation scope", ["type", "id"]);
  if (input.type !== "workspace" && input.type !== "artifact" && input.type !== "resource") {
    throw new HttpError(400, "Conversation scope type is unsupported");
  }
  if (typeof input.id !== "string" || input.id.trim() !== input.id || input.id.length === 0) {
    throw new HttpError(400, "Conversation scope id is invalid");
  }
  if (input.type === "workspace" && input.id !== projectId) {
    throw new HttpError(400, "Conversation workspace scope must use its owning Project id");
  }
  return { type: input.type, id: input.id };
}

function conversationScopeFromQuery(req: IncomingMessage, projectId: string): ConversationScope | undefined {
  const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
  const unexpected = [...query.keys()].find((field) => field !== "scopeType" && field !== "scopeId");
  if (unexpected) throw new HttpError(400, `Conversation list contains unexpected query: ${unexpected}`);
  const scopeTypes = query.getAll("scopeType");
  const scopeIds = query.getAll("scopeId");
  if (scopeTypes.length === 0 && scopeIds.length === 0) return undefined;
  if (scopeTypes.length !== 1 || scopeIds.length !== 1) {
    throw new HttpError(400, "Conversation list requires one scopeType and one scopeId");
  }
  return parseConversationScope({ type: scopeTypes[0], id: scopeIds[0] }, projectId);
}

async function requireConversationScopeOwnership(
  deps: AppDeps,
  projectId: string,
  scope: ConversationScope,
): Promise<void> {
  if (scope.type === "workspace") return;
  const workspace = await ensureStandardProjectWorkspace(deps, projectId);
  if (workspace.status === "unsupported") {
    throw new HttpError(409, "Artifact and Resource conversations require a Standard project");
  }
  const owned = scope.type === "artifact"
    ? workspace.artifacts.some((artifact) => artifact.id === scope.id && artifact.workspaceId === workspace.workspace.id)
    : deps.store.workspace.listResources(projectId, { includeArchived: true }).some((resource) => resource.id === scope.id);
  if (!owned) throw new HttpError(404, `${scope.type} scope not found`);
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try { new URL(s); return true; } catch { return false; }
}

/** A one-shot hand-off from the browser extension: captured reference images + a note. */
interface PendingCapture {
  images: { name: string; base64: string }[];
  note: string;
  source: string;
}
let pendingCapture: PendingCapture | null = null;

function projectPayload(dataDir: string, project: Project): Project & { projectPath: string } {
  return { ...project, projectPath: projectDir(dataDir, project.id) };
}

function activeVariantId(store: Store, projectId: string): string | undefined {
  return store.getActiveVariantId(projectId) ?? store.listVariants(projectId)[0]?.id;
}

function sharinganRequestTarget(req: IncomingMessage, projectId: string, deps: AppDeps): {
  captureId: string;
  scope: { projectId: string; variantId?: string; runId?: string };
} {
  const raw = req.headers["x-dezin-run-id"];
  const runId = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!runId) return { captureId: projectId, scope: { projectId } };
  const run = deps.store.getRun(runId);
  if (!run || run.projectId !== projectId) throw new HttpError(404, "Sharingan Run scope not found");
  if (run.status !== "pending" && run.status !== "running") throw new HttpError(409, "Sharingan Run scope is no longer active");
  return {
    captureId: sharinganRunCaptureId(projectId, runId),
    scope: { projectId, variantId: run.variantId ?? undefined, runId },
  };
}

export function createRuntimeSupervisor(deps: Pick<AppDeps, "store" | "dataDir" | "previewLeaseManager">): RuntimeSupervisor {
  const cleanupDeps = deps as AppDeps;
  const previewLeases = cleanupDeps.previewLeaseManager ?? previewLeaseManager;
  return new RuntimeSupervisor({
    dataDir: deps.dataDir,
    store: deps.store,
    previewLeaseManager: previewLeases,
    releaseProjectResources: async ({ projectId, runIds }) => {
      await releaseProjectRuntime(projectId);
      await Promise.all([
        releaseSharinganProject(projectId, { dataDir: deps.dataDir, profileCleanup: "project", deferProfileCleanup: true }),
        ...runIds.map((runId) => releaseSharinganProject(
          sharinganRunCaptureId(projectId, runId),
          { dataDir: deps.dataDir, profileCleanup: "project", deferProfileCleanup: true },
        )),
      ]);
      await removeSharinganProjectProfiles(projectId, deps.dataDir);
      const project = deps.store.getProject(projectId);
      if (project?.mode === "standard") {
        for (const runId of runIds) {
          await removeStandardRunTransaction(deps.dataDir, projectId, runId);
          await removeStandardVersionWorktree(cleanupDeps, projectId, runId);
        }
        for (const variant of deps.store.listVariants(projectId)) {
          if (!isStandardRootVariant(cleanupDeps, projectId, variant.id)) {
            await removeStandardVariantWorktree(cleanupDeps, projectId, variant.id);
          }
        }
      }
    },
    releaseVariantResources: async ({ projectId, variantId, runIds }) => {
      await releaseVariantRuntime(projectId, variantId, runIds);
      await Promise.all(runIds.map(async (runId) => {
        const captureId = sharinganRunCaptureId(projectId, runId);
        await releaseSharinganProject(captureId, { dataDir: deps.dataDir, profileCleanup: "capture" });
      }));
      const project = deps.store.getProject(projectId);
      if (project?.mode === "standard") {
        for (const runId of runIds) {
          await removeStandardRunTransaction(deps.dataDir, projectId, runId);
          await removeStandardVersionWorktree(cleanupDeps, projectId, runId);
        }
        if (!isStandardRootVariant(cleanupDeps, projectId, variantId)) {
          await removeStandardVariantWorktree(cleanupDeps, projectId, variantId);
        }
      }
    },
    shutdownResources: async () => {
      await Promise.allSettled([stopAllProjectRuntimes(), closeAllSharinganSessions(deps.dataDir)]);
    },
  });
}

function validateRouteParams(params: Record<string, string>): void {
  for (const [key, value] of Object.entries(params)) {
    if (key === "rest") continue;
    assertSafeId(value, key);
  }
}

async function withRequestAbortSignal(
  req: IncomingMessage,
  res: ServerResponse,
  scopeSignal: AbortSignal,
  operation: (signal: AbortSignal) => void | Promise<void>,
): Promise<void> {
  const requestController = new AbortController();
  const abortRequest = (): void => {
    if (!requestController.signal.aborted) {
      requestController.abort(new DOMException("request closed", "AbortError"));
    }
  };
  const closeResponse = (): void => {
    if (!res.writableEnded) abortRequest();
  };
  req.once("aborted", abortRequest);
  res.once("close", closeResponse);
  try {
    try {
      await operation(AbortSignal.any([scopeSignal, requestController.signal]));
    } catch (error) {
      if (
        scopeSignal.aborted
        && !requestController.signal.aborted
        && error instanceof Error
        && error.name === "AbortError"
      ) {
        throw new HttpError(409, "Runtime scope operation was cancelled");
      }
      throw error;
    }
  } finally {
    req.off("aborted", abortRequest);
    res.off("close", closeResponse);
  }
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: "/api/projects/:id/workspace",
    handler: handleGetWorkspace,
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/workspace/graph/commands",
    handler: handleGraphCommands,
  },
  {
    method: "PUT",
    pattern: "/api/projects/:id/workspace/layout",
    handler: handlePutWorkspaceLayout,
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/workspace/proposals",
    handler: handleListProposals,
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/workspace/proposals",
    handler: handleCreateProposal,
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/workspace/proposals/:proposalId",
    handler: handleGetProposal,
  },
  {
    method: "PATCH",
    pattern: "/api/projects/:id/workspace/proposals/:proposalId",
    handler: handleUpdateProposal,
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/workspace/proposals/:proposalId/approve",
    handler: handleApproveProposal,
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/workspace/proposals/:proposalId/reject",
    handler: handleRejectProposal,
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/resources",
    handler: handleListResources,
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/resources",
    handler: handleCreateResource,
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/resources/:resourceId",
    handler: handleGetResource,
  },
  {
    method: "PATCH",
    pattern: "/api/projects/:id/resources/:resourceId",
    handler: handleUpdateResource,
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/resources/:resourceId/revisions",
    handler: handleListResourceRevisions,
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/resources/:resourceId/revisions",
    handler: handleCreateResourceRevision,
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/resources/:resourceId/revisions/:revisionId/publish",
    handler: handlePublishResourceRevision,
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/artifacts",
    handler: handleListWorkspaceArtifacts,
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/artifacts/:artifactId",
    handler: handleGetWorkspaceArtifact,
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/artifacts/:artifactId/tracks",
    handler: handleListArtifactTracks,
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/artifacts/:artifactId/revisions",
    handler: handleListArtifactRevisions,
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/artifacts/:artifactId/revisions/:revisionId",
    handler: handleGetArtifactRevision,
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/artifacts/:artifactId/mutations",
    handler: (req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: params.id! },
      (scopeSignal) => withRequestAbortSignal(
        req,
        res,
        scopeSignal,
        (signal) => handleArtifactMutation(req, res, params, deps, signal),
      ),
    ),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/artifacts/:artifactId/revisions/:revisionId/thumbnail",
    handler: (req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: params.id! },
      (scopeSignal) => withRequestAbortSignal(
        req,
        res,
        scopeSignal,
        (signal) => handleArtifactThumbnail(req, res, params, deps, signal),
      ),
    ),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/workspace/snapshots",
    handler: handleListWorkspaceSnapshots,
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/workspace/snapshots/:snapshotId",
    handler: handleGetWorkspaceSnapshot,
  },
  {
    method: "GET",
    pattern: "/api/health",
    handler: (_req, res, _p, deps) => sendJson(res, 200, { ok: true, version: deps.version ?? "0.0.0" }),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/preview-targets/resolve",
    handler: (req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: params.id! },
      (scopeSignal) => withRequestAbortSignal(
        req,
        res,
        scopeSignal,
        (signal) => handleResolvePreviewTarget(req, res, params, deps, signal),
      ),
    ),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/preview-targets/leases",
    handler: (req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: params.id! },
      (scopeSignal) => withRequestAbortSignal(
        req,
        res,
        scopeSignal,
        (signal) => handleAcquirePreviewTargetLease(req, res, params, deps, signal),
      ),
    ),
  },
  {
    method: "PATCH",
    pattern: "/api/preview-leases/:leaseId",
    handler: async (_req, res, { leaseId }, deps) => {
      const renewed = await deps.previewLeaseManager!.renew(leaseId!);
      if (!renewed) return sendError(res, 404, "preview lease not found");
      const lease = requirePreviewLease(renewed, "preview lease renewal");
      sendJson(res, 200, {
        leaseId: lease.leaseId,
        url: lease.url,
        bridgeNonce: lease.bridgeNonce,
        expiresAt: lease.expiresAt,
      });
    },
  },
  {
    method: "DELETE",
    pattern: "/api/preview-leases/:leaseId",
    handler: async (_req, res, { leaseId }, deps) => {
      sendJson(res, 200, { released: await deps.previewLeaseManager!.release(leaseId!) });
    },
  },
  {
    method: "POST",
    pattern: "/api/extension/pairing-code",
    handler: (_req, res, _p, _deps, extensionPairing) => sendJson(res, 201, extensionPairing.createCode()),
  },
  {
    method: "POST",
    pattern: "/api/extension/pair",
    extensionPairing: true,
    handler: async (req, res, _p, _deps, extensionPairing) => {
      const body = (await readJsonBody(req)) as { code?: unknown } | null;
      const code = typeof body?.code === "string" ? body.code.trim() : "";
      if (!code) return sendError(res, 400, "pairing code required");
      sendJson(res, 200, extensionPairing.exchange(code, requireExtensionPairingRequest(req)));
    },
  },
  {
    method: "GET",
    pattern: "/api/extension/credentials",
    handler: (_req, res, _p, { store }) =>
      sendJson(
        res,
        200,
        store.listExtensionCredentials().map(({ tokenHash: _tokenHash, ...credential }) => credential),
      ),
  },
  {
    method: "DELETE",
    pattern: "/api/extension/credentials/:id",
    handler: (_req, res, p, _deps, extensionPairing) => {
      if (!extensionPairing.revoke(p.id!)) return sendError(res, 404, "extension credential not found");
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: "POST",
    pattern: "/api/fig/parse",
    handler: async (req, res) => {
      let name = "design.fig";
      try {
        name = decodeURIComponent((req.headers["x-filename"] as string) || "") || name;
      } catch {
        /* keep default on malformed header */
      }
      try {
        const bytes = await readRawBody(req);
        if (bytes.length === 0) return sendError(res, 400, "empty body");
        const summary = summarizeFig(figToJson(new Uint8Array(bytes)), name);
        sendJson(res, 200, { name, summary });
      } catch (e) {
        sendError(res, 422, `Couldn't read ${name}: ${e instanceof Error ? e.message : "parse failed"}`);
      }
    },
  },
  {
    // Browser extension → Dezin hand-off. The background worker (host_permissions) POSTs here.
    method: "POST",
    pattern: "/api/capture",
    extensionScope: "capture:write",
    handler: async (req, res) => {
      const body = (await readJsonBody(req)) as Partial<PendingCapture> | null;
      const images = Array.isArray(body?.images)
        ? body!.images.filter((i) => i && typeof i.base64 === "string" && i.base64.length > 0).slice(0, 8)
        : [];
      if (images.length === 0) return sendError(res, 400, "no images");
      pendingCapture = {
        images: images.map((i, n) => ({ name: typeof i.name === "string" && i.name ? i.name : `capture-${n + 1}.png`, base64: i.base64 })),
        note: typeof body?.note === "string" ? body!.note : "",
        source: typeof body?.source === "string" ? body!.source : "extension",
      };
      sendJson(res, 200, { ok: true, count: images.length });
    },
  },
  {
    // Peek at the pending browser-extension handoff without consuming it.
    method: "GET",
    pattern: "/api/capture",
    handler: (_req, res) => {
      sendJson(res, 200, pendingCapture ?? { images: [], note: "", source: "" });
    },
  },
  {
    // Dezin home explicitly consumes the handoff; passive GETs must not clear it.
    method: "POST",
    pattern: "/api/capture/consume",
    handler: (_req, res) => {
      const cap = pendingCapture;
      pendingCapture = null;
      sendJson(res, 200, cap ?? { images: [], note: "", source: "" });
    },
  },
  {
    // Browser extension "Analyze": run the configured agent's fast model on a captured
    // screenshot and return a one-paragraph recreation brief.
    method: "POST",
    pattern: "/api/analyze-image",
    extensionScope: "image:analyze",
    handler: async (req, res, _p, deps) => {
      const body = (await readJsonBody(req)) as { image?: string; agentCommand?: string; model?: string } | null;
      const image = typeof body?.image === "string" ? body.image : "";
      if (!image) return sendError(res, 400, "no image");
      const settings = deps.store.getSettings();
      const command = (typeof body?.agentCommand === "string" && body.agentCommand) || settings.agentCommand || "claude";
      const model = typeof body?.model === "string" ? body.model : undefined;
      try {
        const brief = await (deps.imageAnalyzer ?? analyzeImage)(command, image, model, undefined, buildAgentEnv(settings, command));
        sendJson(res, 200, { brief, agent: command });
      } catch (e) {
        sendError(res, 502, e instanceof Error ? e.message : "analysis failed");
      }
    },
  },
  {
    method: "POST",
    pattern: "/api/prompts/optimize",
    handler: async (req, res, _p, deps) => {
      const body = (await readJsonBody(req)) as {
        prompt?: unknown;
        agentCommand?: unknown;
        model?: unknown;
        mode?: unknown;
        skillId?: unknown;
        designSystemId?: unknown;
      } | null;
      const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) return sendError(res, 400, "prompt is required");
      const settings = deps.store.getSettings();
      const command = (typeof body?.agentCommand === "string" && body.agentCommand.trim()) || settings.agentCommand || "claude";
      const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
      const mode = body?.mode === "standard" ? "standard" : body?.mode === "prototype" ? "prototype" : undefined;
      const skillId = typeof body?.skillId === "string" && body.skillId.trim() ? body.skillId.trim() : undefined;
      const designSystemId = typeof body?.designSystemId === "string" && body.designSystemId.trim() ? body.designSystemId.trim() : undefined;
      try {
        const optimized = await (deps.promptOptimizer ?? optimizePrompt)({
          prompt,
          agentCommand: command,
          model,
          mode,
          skillId,
          designSystemId,
          cwd: deps.dataDir,
          env: buildAgentEnv(settings, command),
        });
        sendJson(res, 200, { prompt: optimized });
      } catch (e) {
        sendError(res, 502, e instanceof Error ? e.message : "prompt optimization failed");
      }
    },
  },
  {
    method: "GET",
    pattern: "/api/settings",
    handler: (_req, res, _p, { store }) => sendJson(res, 200, redactSettings(store.getSettings())),
  },
  {
    method: "PUT",
    pattern: "/api/settings",
    handler: async (req, res, _p, { store }) => {
      const body = await readJsonBody(req);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return sendError(res, 400, "settings body must be an object");
      }
      const patch = body as Partial<Settings>;
      if (typeof patch.aiProviderProfiles === "string") {
        patch.aiProviderProfiles = mergeProviderProfilesForUpdate(store.getSettings().aiProviderProfiles, patch.aiProviderProfiles);
      }
      sendJson(res, 200, redactSettings(store.updateSettings(patch)));
    },
  },
  {
    method: "POST",
    pattern: "/api/model-providers/test",
    handler: (req, res, _p, deps) => handleTestModelProvider(req, res, deps),
  },
  {
    method: "POST",
    pattern: "/api/model-providers/models",
    handler: (req, res, _p, deps) => handleListModelProviderModels(req, res, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects",
    handler: (_req, res, _p, { store, dataDir }) =>
      sendJson(
        res,
        200,
        store.listProjects().map((p) => ({
          ...projectPayload(dataDir, p),
          hasArtifact: existsSync(join(projectDir(dataDir, p.id), "index.html")),
          coverUrl: existsSync(join(projectDir(dataDir, p.id), ".cover.png")) ? `/api/projects/${p.id}/cover?t=${p.updatedAt}` : null,
          runStatus: store.listRuns(p.id).find((r) => r.status === "running" || r.status === "pending")?.status ?? null,
        })),
      ),
  },
  {
    method: "GET",
    pattern: "/api/design-systems",
    handler: (_req, res, _p, deps) => handleListDesignSystems(res, deps),
  },
  {
    method: "POST",
    pattern: "/api/design-systems/import",
    handler: (req, res, _p, deps) => handleImportBrand(req, res, deps),
  },
  {
    method: "GET",
    pattern: "/api/design-systems/:id",
    handler: (_req, res, params, deps) => handleGetDesignSystem(res, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/effects",
    handler: (req, res, _p, deps) => handleListEffects(req, res, deps),
  },
  {
    method: "POST",
    pattern: "/api/effects",
    handler: (req, res, _p, deps) => handleCreateEffect(req, res, deps),
  },
  {
    method: "GET",
    pattern: "/api/effects/:id",
    handler: (_req, res, params, deps) => handleGetEffect(res, params, deps),
  },
  {
    method: "PATCH",
    pattern: "/api/effects/:id",
    handler: (req, res, params, deps) => handleUpdateEffect(req, res, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/skills",
    handler: (_req, res) => handleListSkills(res),
  },
  {
    method: "GET",
    pattern: "/api/agents",
    handler: (_req, res, _p, deps) => handleListAgents(res, deps),
  },
  {
    method: "POST",
    pattern: "/api/agents/rescan",
    handler: (_req, res, _p, deps) => handleRescanAgents(res, deps),
  },
  {
    method: "POST",
    pattern: "/api/agents/rescan-stream",
    handler: (_req, res, _p, deps) => handleScanAgentsStream(res, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects",
    handler: async (req, res, _p, deps) => {
      const { store, dataDir } = deps;
      const body = (await readJsonBody(req)) as Partial<CreateProjectInput>;
      if (!isNonEmptyString(body.name)) return sendError(res, 400, "name is required");
      const sharingan = body.sharingan === true;
      if (sharingan && !isHttpUrl(body.sourceUrl)) return sendError(res, 400, "sharingan requires a valid http(s) sourceUrl");
      // Sharingan always reconstructs into a Standard project.
      const mode = sharingan || body.mode === "standard" ? "standard" : "prototype";
      const project = store.createProject({
        name: body.name,
        skillId: body.skillId ?? null,
        designSystemId: sharingan ? null : (body.designSystemId ?? null),
        mode,
        sharingan,
        sourceUrl: sharingan ? body.sourceUrl : undefined,
      });
      // Standard projects scaffold a real Vite project + install deps in the background.
      if (mode === "standard") {
        void deps.runtimeSupervisor!
          .trackOperation(
            { projectId: project.id },
            (signal) => (deps.standardProjectSetup ?? setupStandardProject)(project.id, projectDir(dataDir, project.id), signal),
          )
          .catch(() => {});
      }
      sendJson(res, 201, projectPayload(dataDir, project));
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/import",
    handler: (req, res, _p, deps) => handleImportProject(req, res, deps),
  },
  {
    method: "GET",
    pattern: "/api/moodboards",
    handler: (_req, res, _p, deps) => handleListMoodboards(res, deps),
  },
  {
    method: "POST",
    pattern: "/api/moodboards",
    handler: (req, res, _p, deps) => handleCreateMoodboard(req, res, deps),
  },
  {
    method: "POST",
    pattern: "/api/moodboards/start",
    handler: (req, res, _p, deps) => handleStartMoodboard(req, res, deps),
  },
  {
    method: "GET",
    pattern: "/api/moodboards/:id",
    handler: (_req, res, params, deps) => handleGetMoodboard(res, params, deps),
  },
  {
    method: "PATCH",
    pattern: "/api/moodboards/:id",
    handler: (req, res, params, deps) => handlePatchMoodboard(req, res, params, deps),
  },
  {
    method: "DELETE",
    pattern: "/api/moodboards/:id",
    handler: (_req, res, params, deps) => handleDeleteMoodboard(res, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/moodboards/:id/nodes",
    handler: (_req, res, params, deps) => handleListMoodboardNodes(res, params, deps),
  },
  {
    method: "PUT",
    pattern: "/api/moodboards/:id/nodes",
    handler: (req, res, params, deps) => handlePutMoodboardNodes(req, res, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/moodboards/:id/conversations",
    handler: (_req, res, params, deps) => handleListMoodboardConversations(res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/moodboards/:id/conversations",
    handler: (req, res, params, deps) => handleCreateMoodboardConversation(req, res, params, deps),
  },
  {
    method: "PATCH",
    pattern: "/api/moodboards/:id/conversations/:cid",
    handler: (req, res, params, deps) => handleRenameMoodboardConversation(req, res, params, deps),
  },
  {
    method: "DELETE",
    pattern: "/api/moodboards/:id/conversations/:cid",
    handler: (_req, res, params, deps) => handleDeleteMoodboardConversation(res, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/moodboards/:id/conversations/:cid/messages",
    handler: (_req, res, params, deps) => handleListMoodboardConversationMessages(res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/moodboards/:id/conversations/:cid/messages",
    handler: (req, res, params, deps) => handlePostMoodboardMessage(req, res, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/moodboards/:id/messages",
    handler: (_req, res, params, deps) => handleListMoodboardMessages(res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/moodboards/:id/messages",
    handler: (req, res, params, deps) => handlePostMoodboardMessage(req, res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/moodboards/:id/assets",
    handler: (req, res, params, deps) => handleUploadMoodboardAsset(req, res, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/moodboards/:id/assets/:assetId",
    publicRead: true,
    handler: (_req, res, params, deps) => handleServeMoodboardAsset(res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/moodboards/:id/generate-image",
    handler: (req, res, params, deps) => handleGenerateMoodboardImage(req, res, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/setup",
    handler: (_req, res, { id }, { store, dataDir }) =>
      store.getProject(id!)
        ? sendJson(res, 200, getSetup(id!, projectDir(dataDir, id!)))
        : sendError(res, 404, "project not found"),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/devserver",
    handler: async (_req, res, { id }, deps) => {
      const project = deps.store.getProject(id!);
      if (!project) return sendError(res, 404, "project not found");
      try {
        const active = deps.store.getActiveVariantId(id!) ?? deps.store.ensureMainVariant(id!).id;
        const lease = requirePreviewLease(await deps.runtimeSupervisor!.trackOperation(
          { projectId: id!, variantId: active },
          async (signal) => {
            const dir = await activeArtifactDir(deps, project);
            signal.throwIfAborted();
            return (deps.ensureDevServer ?? ensureDevServer)(
              id!,
              dir,
              variantRuntimeKey(id!, active),
              signal,
              deps.previewLeaseManager,
            );
          },
        ), "project dev server");
        sendJson(res, 200, {
          url: lease.url,
          leaseId: lease.leaseId,
          bridgeNonce: lease.bridgeNonce,
          expiresAt: lease.expiresAt,
        });
      } catch (err) {
        sendError(res, 409, err instanceof Error ? err.message : "dev server unavailable");
      }
    },
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:id/devserver",
    handler: async (_req, res, { id }, deps) => {
      const project = deps.store.getProject(id!);
      if (!project) return sendError(res, 404, "project not found");
      const active = deps.store.getActiveVariantId(id!) ?? deps.store.ensureMainVariant(id!).id;
      const released = deps.releaseDevServer
        ? await deps.releaseDevServer(variantRuntimeKey(id!, active))
        : await deps.previewLeaseManager!.stopScope({ projectId: id!, variantId: active }).then(() => true);
      sendJson(res, 200, { released });
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:id",
    handler: (_req, res, { id }, { store, dataDir }) => {
      const p = store.getProject(id!);
      return p ? sendJson(res, 200, projectPayload(dataDir, p)) : sendError(res, 404, "project not found");
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/title",
    handler: (req, res, params, deps) => handleGenerateProjectTitle(req, res, params, deps),
  },
  {
    method: "PATCH",
    pattern: "/api/projects/:id",
    handler: async (req, res, { id }, { store, dataDir }) => {
      if (!store.getProject(id!)) return sendError(res, 404, "project not found");
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      if (typeof body.archived === "boolean") {
        const archived = store.setArchived(id!, body.archived);
        return archived ? sendJson(res, 200, projectPayload(dataDir, archived)) : sendError(res, 404, "project not found");
      }
      const patch: Record<string, unknown> = {};
      if (typeof body.name === "string") patch.name = body.name;
      if ("skillId" in body) patch.skillId = body.skillId ?? null;
      if ("designSystemId" in body) patch.designSystemId = body.designSystemId ?? null;
      sendJson(res, 200, projectPayload(dataDir, store.updateProject(id!, patch)));
    },
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:id",
    handler: async (_req, res, { id }, deps) => {
      await deps.runtimeSupervisor!.releaseProject(id!);
      res.writeHead(204);
      res.end();
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/conversations",
    handler: async (req, res, { id }, deps) => {
      if (!deps.store.getProject(id!)) return sendError(res, 404, "project not found");
      const scope = conversationScopeFromQuery(req, id!);
      if (scope) await requireConversationScopeOwnership(deps, id!, scope);
      sendJson(res, 200, deps.store.listConversations(id!, scope));
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/conversations",
    handler: async (req, res, { id }, deps) => {
      if (!deps.store.getProject(id!)) return sendError(res, 404, "project not found");
      const body = exactRequestRecord(await readJsonBody(req), "Create Conversation request", ["title", "scope"]);
      const title = body.title === undefined
        ? "Untitled"
        : typeof body.title === "string" && body.title.trim().length > 0 && body.title.trim().length <= 500
          ? body.title.trim()
          : null;
      if (title === null) return sendError(res, 400, "Conversation title must contain 1-500 characters");
      const scope = body.scope === undefined
        ? { type: "workspace" as const, id: id! }
        : parseConversationScope(body.scope, id!);
      await requireConversationScopeOwnership(deps, id!, scope);
      sendJson(res, 201, deps.store.createConversation(id!, title, scope));
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/conversations/:cid",
    handler: (_req, res, { id, cid }, { store }) => {
      const conv = store.getConversation(cid!);
      if (!store.getProject(id!) || !conv || conv.projectId !== id) return sendError(res, 404, "not found");
      sendJson(res, 200, conv);
    },
  },
  {
    method: "PATCH",
    pattern: "/api/projects/:id/conversations/:cid",
    handler: async (req, res, { id, cid }, { store }) => {
      const conv = store.getConversation(cid!);
      if (!store.getProject(id!) || !conv || conv.projectId !== id) return sendError(res, 404, "not found");
      const body = (await readJsonBody(req)) as { title?: string } | null;
      if (typeof body?.title !== "string" || body.title.trim().length === 0) return sendError(res, 400, "title is required");
      sendJson(res, 200, store.renameConversation(cid!, body.title.trim()));
    },
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:id/conversations/:cid",
    handler: (_req, res, { id, cid }, { store }) => {
      const conv = store.getConversation(cid!);
      if (!store.getProject(id!) || !conv || conv.projectId !== id) return sendError(res, 404, "not found");
      store.deleteConversation(cid!);
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/conversations/:cid/messages",
    handler: (_req, res, { id, cid }, { store }) => {
      const conv = store.getConversation(cid!);
      if (!store.getProject(id!) || !conv || conv.projectId !== id) return sendError(res, 404, "not found");
      sendJson(res, 200, store.listMessages(cid!));
    },
  },
  {
    method: "POST",
    pattern: "/api/runs",
    handler: (req, res, _p, deps) => handleRun(req, res, deps),
  },
  {
    method: "GET",
    pattern: "/api/runs/:id/stream",
    handler: (req, res, params, deps) => handleRunStream(req, res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/runs/:id/cancel",
    handler: (_req, res, params) => handleCancelRun(res, params),
  },
  {
    method: "POST",
    pattern: "/api/runs/:id/feedback",
    handler: (req, res, params, deps) => handleRunFeedback(req, res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/preferences/suggest",
    handler: (req, res, _p, deps) => handlePreferenceSuggest(req, res, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/files",
    handler: (_req, res, params, deps) => handleListFiles(res, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/research",
    handler: (_req, res, params, deps) => handleGetResearch(res, params, deps),
  },
  {
    // Serve a collected research asset image (publicRead so <img src> works). safeJoin blocks traversal.
    method: "GET",
    pattern: "/api/projects/:id/research/assets/*rest",
    publicRead: true,
    handler: (_req, res, { id, rest }, { dataDir }) => serveProjectFile(res, dataDir, id!, join(".research", "assets", rest ?? "")),
  },
  {
    // Serve a collected VISUAL research asset image (publicRead so <img src> works). safeJoin blocks traversal.
    method: "GET",
    pattern: "/api/projects/:id/research/visual/assets/*rest",
    publicRead: true,
    handler: (_req, res, { id, rest }, { dataDir }) => serveProjectFile(res, dataDir, id!, join(".research", "visual", "assets", rest ?? "")),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/runs",
    handler: (req, res, params, deps) => {
      if (!deps.store.getProject(params.id!)) return sendError(res, 404, "project not found");
      const all = new URL(req.url ?? "", "http://localhost").searchParams.get("all") === "1";
      if (all) return sendJson(res, 200, deps.store.listRuns(params.id!));
      const active = deps.store.ensureMainVariant(params.id!);
      sendJson(res, 200, deps.store.listRuns(params.id!, active.id));
    },
  },
  {
    // Immutable, run-scoped Visual QA evidence. The run ownership check prevents a valid
    // project id from being combined with another project's run id; serveFileFromBase keeps
    // evidence outside generated Git repositories and rejects filename traversal.
    method: "GET",
    pattern: "/api/projects/:id/runs/:runId/evidence/*rest",
    publicRead: true,
    handler: (_req, res, { id, runId, rest }, deps) => {
      const run = deps.store.getRun(runId!);
      if (!deps.store.getProject(id!) || !run || run.projectId !== id) return sendError(res, 404, "run evidence not found");
      return serveFileFromBase(res, join(deps.dataDir, "version-evidence", id!, runId!, "visual"), rest ?? "");
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/quality-ignores",
    handler: (_req, res, params, deps) => {
      if (!deps.store.getProject(params.id!)) return sendError(res, 404, "project not found");
      sendJson(res, 200, deps.store.listQualityIgnores(params.id!));
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/quality-ignores",
    handler: async (req, res, params, deps) => {
      if (!deps.store.getProject(params.id!)) return sendError(res, 404, "project not found");
      const body = (await readJsonBody(req)) as { ruleId?: string; selector?: string | null } | null;
      if (!body || typeof body.ruleId !== "string" || !body.ruleId.trim()) return sendError(res, 400, "ruleId is required");
      sendJson(res, 201, deps.store.addQualityIgnore(params.id!, body.ruleId.trim(), body.selector?.trim() || null));
    },
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:id/quality-ignores/:ignoreId",
    handler: (_req, res, params, deps) => {
      deps.store.removeQualityIgnore(params.ignoreId!);
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/quality-trend",
    handler: (_req, res, params, deps) => {
      if (!deps.store.getProject(params.id!)) return sendError(res, 404, "project not found");
      const scores = deps.store.listRuns(params.id!).map((r) => r.score).filter((s): s is number => typeof s === "number");
      sendJson(res, 200, scoreTrend(scores));
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/variants",
    handler: (_req, res, params, deps) => handleListVariants(res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/variants",
    handler: (req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: params.id! },
      (signal) => handleCreateVariant(req, res, params, deps, signal),
    ),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/variants/fanout",
    handler: (req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: params.id! },
      (signal) => handleVariantFanout(req, res, params, deps, signal),
    ),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/messages/:messageId/fork",
    handler: (req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: params.id! },
      (signal) => handleForkMessage(req, res, params, deps, signal),
    ),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/variants/:vid/activate",
    handler: (_req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: params.id!, variantId: params.vid! },
      (signal) => handleActivateVariant(res, params, deps, signal),
    ),
  },
  {
    method: "PATCH",
    pattern: "/api/projects/:id/variants/:vid",
    handler: (req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: params.id!, variantId: params.vid! },
      (signal) => handleRenameVariant(req, res, params, deps, signal),
    ),
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:id/variants/:vid",
    handler: (_req, res, params, deps) => handleDeleteVariant(res, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/variants/:vid/preview/*rest",
    publicRead: true,
    handler: async (_req, res, { id, vid, rest }, deps) => {
      const project = deps.store.getProject(id!);
      if (!project) return sendError(res, 404, "project not found");
      return deps.runtimeSupervisor!.trackOperation(
        { projectId: id!, variantId: vid! },
        async () => {
          const base = await variantArtifactDir(deps, project, vid!);
          if (!base) return sendError(res, 404, "variant not found");
          return serveFileFromBase(res, base, rest ?? "");
        },
      );
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/versions/:runId/files/*rest",
    publicRead: true,
    handler: (_req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      {
        projectId: params.id!,
        variantId: deps.store.getRun(params.runId!)?.variantId ?? undefined,
        runId: params.runId!,
      },
      () => handleGetVersionFile(res, params, deps),
    ),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/versions/:runId/source",
    handler: (_req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      {
        projectId: params.id!,
        variantId: deps.store.getRun(params.runId!)?.variantId ?? undefined,
        runId: params.runId!,
      },
      () => handleGetVersionSource(res, params, deps),
    ),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/versions/:runId",
    publicRead: true,
    handler: (_req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      {
        projectId: params.id!,
        variantId: deps.store.getRun(params.runId!)?.variantId ?? undefined,
        runId: params.runId!,
      },
      () => handleGetVersion(res, params, deps),
    ),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/versions/:runId/preview-url",
    handler: (_req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      {
        projectId: params.id!,
        variantId: deps.store.getRun(params.runId!)?.variantId ?? undefined,
        runId: params.runId!,
      },
      (signal) => handleGetVersionPreviewUrl(res, params, deps, signal),
    ),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/versions/:runId/diff",
    handler: (_req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      {
        projectId: params.id!,
        variantId: deps.store.getRun(params.runId!)?.variantId ?? undefined,
        runId: params.runId!,
      },
      () => handleGetVersionDiff(res, params, deps),
    ),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/versions/:runId/restore",
    handler: (_req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      {
        projectId: params.id!,
        variantId: activeVariantId(deps.store, params.id!),
        runId: params.runId!,
      },
      () => handleRestoreVersion(res, params, deps),
    ),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/versions/:runId/cover",
    handler: (req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      {
        projectId: params.id!,
        variantId: deps.store.getRun(params.runId!)?.variantId ?? undefined,
        runId: params.runId!,
      },
      (signal) => handleSetVersionCover(req, res, params, deps, signal),
    ),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/refs",
    handler: (req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: params.id! },
      (signal) => handleUploadRef(req, res, params, deps, signal),
    ),
  },
  {
    // Serve an uploaded reference file (image thumbnails in the chat). safeJoin blocks traversal.
    method: "GET",
    pattern: "/api/projects/:id/refs/*rest",
    publicRead: true,
    handler: (_req, res, { id, rest }, { dataDir }) => serveProjectFile(res, dataDir, id!, join(".refs", rest ?? "")),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/export",
    publicRead: true,
    handler: (req, res, params, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: params.id! },
      async (scopeSignal) => {
        const requestController = new AbortController();
        const abortRequest = (): void => {
          if (!requestController.signal.aborted) requestController.abort(new Error("export request closed"));
        };
        const closeResponse = (): void => {
          if (!res.writableEnded) abortRequest();
        };
        req.once("aborted", abortRequest);
        res.once("close", closeResponse);
        try {
          await handleExport(req, res, params, deps, AbortSignal.any([scopeSignal, requestController.signal]));
        } finally {
          req.off("aborted", abortRequest);
          res.off("close", closeResponse);
        }
      },
    ),
  },
  {
    method: "GET",
    pattern: "/projects/:id/preview/*rest",
    publicRead: true,
    handler: async (_req, res, { id, rest }, deps) => {
      const project = deps.store.getProject(id!);
      if (!project) return serveProjectFile(res, deps.dataDir, id!, rest ?? "");
      return serveFileFromBase(res, await activeArtifactDir(deps, project), rest ?? "");
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/cover/capture",
    handler: async (req, res, { id }, deps) => {
      const project = deps.store.getProject(id!);
      if (!project) return sendError(res, 404, "project not found");
      if (project.mode !== "standard") return sendJson(res, 200, { captured: false, reason: "unsupported" });
      const active = deps.store.getActiveVariantId(id!) ?? deps.store.ensureMainVariant(id!).id;
      return deps.runtimeSupervisor!.trackOperation(
        { projectId: id!, variantId: active },
        async (signal) => {
          const root = projectDir(deps.dataDir, id!);
          const coverPath = join(root, ".cover.png");
          if (existsSync(coverPath)) return sendJson(res, 200, { captured: false, reason: "exists" });
          const runtimeKey = variantRuntimeKey(id!, active);
          const releaseAfter = new URL(req.url ?? "", "http://localhost").searchParams.get("release") === "1";
          let lease: DevServerLease | undefined;
          try {
            const dir = await activeArtifactDir(deps, project);
            lease = await (deps.ensureDevServer ?? ensureDevServer)(
              id!,
              dir,
              runtimeKey,
              signal,
              deps.previewLeaseManager,
            );
            signal.throwIfAborted();
            const captured = await (deps.captureCoverUrl ?? captureCoverUrl)(lease.url, coverPath, signal);
            sendJson(res, 200, { captured });
          } catch (err) {
            sendError(res, 409, err instanceof Error ? err.message : "cover capture failed");
          } finally {
            if (lease?.release) await lease.release();
            else if (releaseAfter) await (deps.releaseDevServer ?? releaseDevServer)(runtimeKey);
          }
        },
      );
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/cover",
    handler: (req, res, { id }, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: id! },
      async (signal) => {
        if (!deps.store.getProject(id!)) return sendError(res, 404, "project not found");
        const body = (await readJsonBody(req, undefined, signal)) as { dataUrl?: string } | null;
        signal.throwIfAborted();
        const m = body?.dataUrl?.match(/^data:image\/png;base64,(.+)$/);
        if (!m) return sendError(res, 400, "dataUrl must be a base64 png");
        const dir = projectDir(deps.dataDir, id!);
        if (!deps.store.getProject(id!) || !existsSync(dir)) return sendError(res, 404, "project not found");
        signal.throwIfAborted();
        writeFileSync(join(dir, ".cover.png"), Buffer.from(m[1]!, "base64"));
        sendJson(res, 200, { ok: true });
      },
    ),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/cover",
    publicRead: true,
    handler: (_req, res, { id }, { dataDir }) => {
      const f = join(projectDir(dataDir, id!), ".cover.png");
      if (!existsSync(f)) return sendError(res, 404, "no cover");
      send(res, 200, readFileSync(f), "image/png");
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/start",
    handler: (req, res, p, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: p.id! },
      (signal) => handleSharinganStart(req, res, p.id!, deps.dataDir, deps.sharinganOpen, signal),
    ),
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/cancel",
    handler: (req, res, p, deps) => {
      if (!deps.store.getProject(p.id!)) return sendError(res, 404, "project not found");
      const target = sharinganRequestTarget(req, p.id!, deps);
      return deps.runtimeSupervisor!.trackOperation(target.scope, () => handleSharinganCancel(res, target.captureId, deps.dataDir));
    },
  },
  {
    method: "GET",
    pattern: "/api/sharingan/:id/status",
    handler: (req, res, p, deps) => {
      if (!deps.store.getProject(p.id!)) return sendError(res, 404, "project not found");
      const target = sharinganRequestTarget(req, p.id!, deps);
      handleSharinganStatus(res, target.captureId, deps.dataDir);
    },
  },
  {
    // Serve a captured-page screenshot (publicRead so <img src> works — it cannot send the daemon token header).
    method: "GET",
    pattern: "/api/sharingan/:id/shot",
    publicRead: true,
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(req, p.id!, deps);
      handleSharinganShot(res, target.captureId, new URL(req.url ?? "", "http://x").searchParams.get("path") ?? "", deps.dataDir);
    },
  },
  {
    method: "GET",
    pattern: "/api/sharingan/:id/events",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(req, p.id!, deps);
      deps.runtimeSupervisor!.assertAdmission(target.scope);
      handleSharinganEvents(res, target.captureId);
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/continue",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(req, p.id!, deps);
      return deps.runtimeSupervisor!.trackOperation(target.scope, () => handleSharinganContinue(res, target.captureId, deps.dataDir));
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/focus",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(req, p.id!, deps);
      deps.runtimeSupervisor!.assertAdmission(target.scope);
      handleSharinganFocus(res, target.captureId);
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/navigate",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(req, p.id!, deps);
      return deps.runtimeSupervisor!.trackOperation(target.scope, (signal) => handleSharinganNavigate(req, res, target.captureId, deps.dataDir, signal));
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/capture",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(req, p.id!, deps);
      return deps.runtimeSupervisor!.trackOperation(target.scope, (signal) => handleSharinganCapture(req, res, target.captureId, deps.dataDir, signal));
    },
  },
  {
    method: "GET",
    pattern: "/api/sharingan/:id/read-dom",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(req, p.id!, deps);
      return deps.runtimeSupervisor!.trackOperation(target.scope, () => handleSharinganReadDom(res, target.captureId, deps.dataDir));
    },
  },
  {
    method: "GET",
    pattern: "/api/sharingan/:id/computed-styles",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(req, p.id!, deps);
      return deps.runtimeSupervisor!.trackOperation(target.scope, () => handleSharinganComputedStyles(res, target.captureId, deps.dataDir));
    },
  },
  {
    method: "GET",
    pattern: "/api/sharingan/:id/links",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(req, p.id!, deps);
      return deps.runtimeSupervisor!.trackOperation(target.scope, () => handleSharinganLinks(res, target.captureId, deps.dataDir));
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/click",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(req, p.id!, deps);
      return deps.runtimeSupervisor!.trackOperation(target.scope, (signal) => handleSharinganClick(req, res, target.captureId, deps.dataDir, signal));
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/scroll",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(req, p.id!, deps);
      return deps.runtimeSupervisor!.trackOperation(target.scope, (signal) => handleSharinganScroll(req, res, target.captureId, deps.dataDir, signal));
    },
  },
];

export function createApp(deps: AppDeps): http.Server {
  const resolvedPreviewLeaseManager = deps.previewLeaseManager ?? previewLeaseManager;
  const appDeps: AppDeps = {
    ...deps,
    previewLeaseManager: resolvedPreviewLeaseManager,
    runtimeSupervisor: deps.runtimeSupervisor ?? createRuntimeSupervisor({
      ...deps,
      previewLeaseManager: resolvedPreviewLeaseManager,
    }),
  };
  const webDir = appDeps.webDir ?? defaultWebDir();
  const hasWeb = existsSync(webDir);
  const extensionPairing = appDeps.extensionPairing ?? new StoreExtensionPairingService(appDeps.store);
  recoverIncompleteMoodboards(appDeps);
  warmAgents(appDeps.agentProber, appDeps.dataDir); // reload the persisted scan (or probe once) at startup
  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return sendError(res, 400, "bad url");
    }

    try {
      let matchedPathButNotMethod = false;
      for (const route of routes) {
        const m = matchPath(route.pattern, pathname);
        if (!m) continue;
        if (route.method !== method) {
          matchedPathButNotMethod = true;
          continue;
        }
        validateRouteParams(m.params);
        if (route.extensionPairing) requireExtensionPairingRequest(req);
        else requireDaemonRequest(req, { ...appDeps.security, allowMissingToken: route.publicRead === true }, extensionPairing, route.extensionScope);
        await route.handler(req, res, m.params, appDeps, extensionPairing);
        return;
      }
      if (matchedPathButNotMethod) {
        requireDaemonRequest(req, appDeps.security);
        return sendError(res, 405, "method not allowed");
      }
      // Unmatched GET → serve the built web app (SPA) when present (Electron / prod).
      if (method === "GET" && hasWeb && !pathname.startsWith("/api/")) {
        requireDaemonRequest(req, { ...appDeps.security, allowMissingToken: true });
        return serveWeb(res, webDir, pathname, { daemonToken: appDeps.security?.token });
      }
      requireDaemonRequest(req, appDeps.security);
      sendError(res, 404, "not found");
    } catch (err) {
      if (req.aborted || res.destroyed || res.writableEnded) return;
      if (err instanceof RuntimeScopeUnavailableError) {
        if (!res.headersSent) sendError(res, 409, err.message);
        else res.end();
        return;
      }
      if (isHttpError(err)) {
        if (!res.headersSent) sendError(res, err.status, err.message);
        else res.end();
        return;
      }
      const message = err instanceof Error ? err.message : "internal error";
      if (!res.headersSent) sendError(res, 500, message);
      else res.end();
    }
  });
}
