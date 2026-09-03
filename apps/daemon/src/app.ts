/**
 * The Dezin daemon HTTP app. A tiny node:http server with a hand-rolled router —
 * a lean HTTP server scoped to current Dezin surfaces: project CRUD, Design Canvas,
 * settings/catalogs, Moodboards, browser capture, and Sharingan.
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, type SecretCipher } from "@dezin/core";
import type { ExtensionScope, Project, Settings } from "@dezin/core";
import type { AgentRunner } from "@dezin/agent";
import type { DesignRegistry } from "@dezin/design";
import { HttpError, sendJson, sendError, send, readJsonBody, readRawBody, matchPath, isHttpError } from "./http-util.ts";
import { projectDir } from "./serve-static.ts";
import { figToJson, summarizeFig } from "./parse-fig.ts";
import { serveWeb, defaultWebDir } from "./serve-web.ts";
import { handleSharinganStart, handleSharinganCancel, handleSharinganStatus, handleSharinganShot, handleSharinganEvents, handleSharinganContinue, handleSharinganFocus, handleSharinganNavigate, handleSharinganReadDom, handleSharinganComputedStyles, handleSharinganLinks, handleSharinganClick, handleSharinganScroll, handleSharinganCapture, closeAllSharinganSessions, releaseSharinganProject, type SharinganOpen } from "./sharingan-handler.ts";
import { RuntimeScopeUnavailableError, RuntimeSupervisor } from "./runtime-supervisor.ts";
import { handleListDesignSystems, handleGetDesignSystem, handleImportBrand } from "./catalog-handler.ts";
import { handleCreateEffect, handleGetEffect, handleListEffects, handleUpdateEffect } from "./effects-handler.ts";
import { handleListAgents, handleRescanAgents, handleScanAgentsStream, warmAgents, type AgentProber } from "./agents-handler.ts";
import { handleListModelProviderModels, handleTestModelProvider } from "./model-provider-handler.ts";
import { analyzeImage } from "./analyze-image.ts";
import { buildAgentEnv } from "./agent-env.ts";
import { optimizePrompt, type PromptOptimizer } from "./prompt-optimize.ts";
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
import type { SharinganBootstrapPort } from "./sharingan-bootstrap.ts";
import {
  initializeDesignProject,
  recoverInterruptedDesignJobs,
  DesignRevisionConflictError,
  DesignStorageError,
} from "./design/design-storage.ts";
import {
  createDesignProject,
  designProjectPayload,
  ensureDesignProjectAtId,
  getDesignProject,
  listDesignProjects,
  listInitializedDesignProjectIds,
  updateDesignProject,
  type DesignProjectMetadata,
} from "./design/design-project-store.ts";
import {
  handleCancelDesignJob,
  handleRetryDesignJob,
  handleCreateDesignAsset,
  handleDesignMainTurn,
  handleDesignNodeTurn,
  handleDownloadPortableDesignVersionPreview,
  handleDownloadDesignVersionExportBundle,
  handleGetDesignCanvas,
  handleGetMainDesignThread,
  handleGetNodeDesignThread,
  handleListMainDesignSessions,
  handleCreateMainDesignSession,
  handleActivateMainDesignSession,
  handleRenameMainDesignSession,
  handleDeleteMainDesignSession,
  handleImportDesignAssets,
  handleListDesignAssets,
  handleListDesignJobs,
  handleListDesignVersions,
  handlePutDesignCanvas,
  handleRedoDesignCanvas,
  handleServeDesignCover,
  handleServeDesignAssetContent,
  handleServeDesignVersionPreview,
  handleServeEmbeddedDesignVersionPreview,
  handleServePinnedDesignAsset,
  handleStageDesignVideo,
  handleStartDesignImplementationExport,
  handleUndoDesignCanvas,
} from "./design/design-http-handler.ts";
import { handleDesignInvalidationEvents } from "./design/design-invalidation-http.ts";
import {
  handleBootstrapDesignProject,
  type DesignProjectBootstrapExecutionPorts,
} from "./design/design-project-bootstrap-http.ts";
import { recoverDesignProjectBootstraps } from "./design/design-project-bootstrap.ts";
import { createProductionDesignProjectBootstrapPorts } from "./design/design-project-bootstrap-adapter.ts";
import {
  handleDeleteFigmaCredential,
  handleGetFigmaCredential,
  handleImportFigmaProject,
  handlePutFigmaCredential,
  type FigmaCredentialProvider,
  type FigmaProjectLease,
} from "./design/figma-import-http.ts";
import { recoverFigmaImports } from "./design/figma-import.ts";
import { resolveFigmaCredential } from "./design/figma-credential-store.ts";
import { createFigmaRestClient, type FigmaRestClient } from "./design/figma-rest-client.ts";
import { log } from "./log.ts";

export interface AppDeps {
  store: Store;
  /** Root for on-disk artifacts: <dataDir>/projects/<id>/... */
  dataDir: string;
  version?: string;
  /** Design-system registry (defaults to the bundled one). */
  designRegistry?: DesignRegistry;
  /** Agent availability prober for GET /api/agents (defaults to a real spawn probe). */
  agentProber?: AgentProber;
  /** Optional deterministic runner for scoped Design Canvas Node Agent tests. */
  designRunner?: AgentRunner;
  /** Serve the built web app from here (SPA). Defaults to apps/web/dist when it exists. */
  webDir?: string;
  /** Sharingan browser opener; tests can delay session creation without launching Chrome. */
  sharinganOpen?: SharinganOpen;
  /** Background title generator hook; tests can avoid launching an agent. */
  titleGenerator?: TitleGenerator;
  /** Prompt optimizer hook; tests can avoid launching a real agent. */
  promptOptimizer?: PromptOptimizer;
  /** Moodboard chat one-shot agent hook; tests can avoid launching a real CLI. */
  moodboardAgentText?: MoodboardAgentTextRunner;
  /** Provider model-list fetcher; tests can avoid real network calls. */
  modelProviderFetch?: typeof fetch;
  /** Optional local API boundary guard. */
  security?: DaemonSecurityOptions;
  /** Seals secrets kept outside SQLite (the Figma token file); the Store carries its own copy. */
  secretCipher?: SecretCipher | null;
  /** Scoped browser-extension pairing service; defaults to the persistent Store implementation. */
  extensionPairing?: ExtensionPairingService;
  /** Image analyzer hook; tests can avoid launching a real agent. */
  imageAnalyzer?: typeof analyzeImage;
  /** Daemon-owned scoped runtime lifecycle; createApp supplies the production instance by default. */
  runtimeSupervisor?: RuntimeSupervisor;
  /** Daemon-owned immutable source capture required before a Sharingan project becomes usable. */
  sharinganBootstrap?: SharinganBootstrapPort;
  /** Deterministic startup-recovery seam; production enumerates every initialized Design Canvas. */
  designStartupRecovery?: () => Promise<void>;
  /** Durable Home bootstrap execution supplied by the Design Asset and Agent ledger adapters. */
  designProjectBootstrapPorts?: DesignProjectBootstrapExecutionPorts;
  /** Optional deterministic Figma REST seam; production uses the fixed official API origin. */
  figmaClient?: FigmaRestClient;
  /** Optional deterministic credential seam; production resolves environment/local daemon secrets. */
  figmaCredentialProvider?: FigmaCredentialProvider;
  /** Project-lifecycle admission held from a Figma receipt's reserved identity through publication. */
  withFigmaProjectLease?: FigmaProjectLease;
  /** Test-only deterministic pause before a leased Figma Project response is projected. */
  beforeFigmaProjectResponse?: (projectId: string) => void | Promise<void>;
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
  /** Project DELETE owns the admission transition itself; every other scoped route is leased automatically. */
  projectAdmission?: "skip";
  publicRead?: boolean;
  extensionScope?: ExtensionScope;
  extensionPairing?: boolean;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
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

type PublicProject = Omit<Project, "mode"> & { projectPath: string };

function projectPayload(dataDir: string, project: Project): PublicProject {
  const { mode: _mode, ...current } = project;
  return { ...current, projectPath: projectDir(dataDir, project.id) };
}

type CurrentProject =
  | { kind: "design"; project: DesignProjectMetadata }
  | { kind: "sharingan"; project: Project };

async function getCurrentProject(dataDir: string, store: Store, projectId: string): Promise<CurrentProject | null> {
  const design = await getDesignProject(dataDir, projectId);
  if (design) return { kind: "design", project: design };
  const sharingan = store.getProject(projectId);
  return sharingan?.sharingan === true ? { kind: "sharingan", project: sharingan } : null;
}

function currentProjectPayload(dataDir: string, current: CurrentProject): PublicProject | ReturnType<typeof designProjectPayload> {
  return current.kind === "design"
    ? designProjectPayload(dataDir, current.project)
    : projectPayload(dataDir, current.project);
}

function sharinganRequestTarget(projectId: string): {
  captureId: string;
  scope: { projectId: string };
} {
  return { captureId: projectId, scope: { projectId } };
}

export function createRuntimeSupervisor(deps: Pick<AppDeps, "store" | "dataDir">): RuntimeSupervisor {
  return new RuntimeSupervisor({
    dataDir: deps.dataDir,
    store: deps.store,
    releaseProjectResources: async ({ projectId }) => {
      await releaseSharinganProject(projectId, {
        dataDir: deps.dataDir,
        profileCleanup: "project",
      });
      // This boundary only quiesces live owners. RuntimeSupervisor owns the
      // Project database and filesystem deletion that follows.
    },
    shutdownResources: async () => {
      await closeAllSharinganSessions(deps.dataDir);
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

const REQUEST_LIFETIME_ONLY_SIGNAL = new AbortController().signal;

const routes: Route[] = [
  { method: "POST", pattern: "/api/projects/bootstrap", handler: handleBootstrapDesignProject },
  { method: "GET", pattern: "/api/figma/credential", handler: handleGetFigmaCredential },
  { method: "PUT", pattern: "/api/figma/credential", handler: handlePutFigmaCredential },
  { method: "DELETE", pattern: "/api/figma/credential", handler: handleDeleteFigmaCredential },
  {
    method: "POST",
    pattern: "/api/projects/:id/design-canvas/imports/figma",
    projectAdmission: "skip",
    handler: (req, res, params, deps) => withRequestAbortSignal(
      req,
      res,
      REQUEST_LIFETIME_ONLY_SIGNAL,
      (signal) => handleImportFigmaProject(req, res, params, deps, signal),
    ),
  },
  { method: "GET", pattern: "/api/projects/:id/design-canvas", handler: handleGetDesignCanvas },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/cover", handler: handleServeDesignCover, publicRead: true },
  { method: "HEAD", pattern: "/api/projects/:id/design-canvas/cover", handler: handleServeDesignCover, publicRead: true },
  {
    method: "GET",
    pattern: "/api/projects/:id/design-canvas/events",
    projectAdmission: "skip",
    handler: (req, res, p, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: p.id! },
      (scopeSignal) => withRequestAbortSignal(
        req,
        res,
        scopeSignal,
        (signal) => handleDesignInvalidationEvents(req, res, {
          dataDir: deps.dataDir,
          projectId: p.id!,
          signal,
        }),
      ),
    ),
  },
  { method: "PUT", pattern: "/api/projects/:id/design-canvas", handler: handlePutDesignCanvas },
  { method: "POST", pattern: "/api/projects/:id/design-canvas/undo", handler: handleUndoDesignCanvas },
  { method: "POST", pattern: "/api/projects/:id/design-canvas/redo", handler: handleRedoDesignCanvas },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/assets", handler: handleListDesignAssets },
  { method: "POST", pattern: "/api/projects/:id/design-canvas/assets", handler: handleCreateDesignAsset },
  { method: "POST", pattern: "/api/projects/:id/design-canvas/assets/uploads", handler: handleStageDesignVideo },
  { method: "POST", pattern: "/api/projects/:id/design-canvas/assets/import", handler: handleImportDesignAssets },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/assets/:assetId/content", handler: handleServeDesignAssetContent, publicRead: true },
  { method: "HEAD", pattern: "/api/projects/:id/design-canvas/assets/:assetId/content", handler: handleServeDesignAssetContent, publicRead: true },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/assets/:assetId/*rest", handler: handleServePinnedDesignAsset, publicRead: true },
  { method: "HEAD", pattern: "/api/projects/:id/design-canvas/assets/:assetId/*rest", handler: handleServePinnedDesignAsset, publicRead: true },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/nodes/:nodeId/versions", handler: handleListDesignVersions },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/nodes/:nodeId/versions/:versionId/preview", handler: handleServeDesignVersionPreview, publicRead: true },
  { method: "HEAD", pattern: "/api/projects/:id/design-canvas/nodes/:nodeId/versions/:versionId/preview", handler: handleServeDesignVersionPreview, publicRead: true },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/nodes/:nodeId/versions/:versionId/preview/embed", handler: handleServeEmbeddedDesignVersionPreview, publicRead: true },
  { method: "HEAD", pattern: "/api/projects/:id/design-canvas/nodes/:nodeId/versions/:versionId/preview/embed", handler: handleServeEmbeddedDesignVersionPreview, publicRead: true },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/nodes/:nodeId/versions/:versionId/preview/download", handler: handleDownloadPortableDesignVersionPreview },
  { method: "HEAD", pattern: "/api/projects/:id/design-canvas/nodes/:nodeId/versions/:versionId/preview/download", handler: handleDownloadPortableDesignVersionPreview },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/nodes/:nodeId/versions/:versionId/preview/export", handler: handleDownloadDesignVersionExportBundle },
  { method: "HEAD", pattern: "/api/projects/:id/design-canvas/nodes/:nodeId/versions/:versionId/preview/export", handler: handleDownloadDesignVersionExportBundle },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/agent/thread", handler: handleGetMainDesignThread },
  { method: "POST", pattern: "/api/projects/:id/design-canvas/agent/turns", handler: handleDesignMainTurn },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/agent/sessions", handler: handleListMainDesignSessions },
  { method: "POST", pattern: "/api/projects/:id/design-canvas/agent/sessions", handler: handleCreateMainDesignSession },
  { method: "POST", pattern: "/api/projects/:id/design-canvas/agent/sessions/:sessionId/activate", handler: handleActivateMainDesignSession },
  { method: "PATCH", pattern: "/api/projects/:id/design-canvas/agent/sessions/:sessionId", handler: handleRenameMainDesignSession },
  { method: "DELETE", pattern: "/api/projects/:id/design-canvas/agent/sessions/:sessionId", handler: handleDeleteMainDesignSession },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/nodes/:nodeId/agent/thread", handler: handleGetNodeDesignThread },
  { method: "POST", pattern: "/api/projects/:id/design-canvas/nodes/:nodeId/agent/turns", handler: handleDesignNodeTurn },
  { method: "POST", pattern: "/api/projects/:id/design-canvas/exports", handler: handleStartDesignImplementationExport },
  { method: "GET", pattern: "/api/projects/:id/design-canvas/jobs", handler: handleListDesignJobs },
  { method: "POST", pattern: "/api/projects/:id/design-canvas/jobs/:jobId/retry", handler: handleRetryDesignJob },
  { method: "DELETE", pattern: "/api/projects/:id/design-canvas/jobs/:jobId", handler: handleCancelDesignJob },
  {
    method: "GET",
    pattern: "/api/health",
    handler: (_req, res, _p, deps) => sendJson(res, 200, { ok: true, version: deps.version ?? "0.0.0" }),
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
      const decoded = await readJsonBody(req);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        return sendError(res, 400, "prompt optimization body must be an object");
      }
      const body = decoded as Record<string, unknown>;
      const unexpected = Object.keys(body).find((field) => !["prompt", "agentCommand", "model"].includes(field));
      if (unexpected) return sendError(res, 400, `prompt optimization contains unexpected field: ${unexpected}`);
      const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) return sendError(res, 400, "prompt is required");
      const settings = deps.store.getSettings();
      const command = (typeof body?.agentCommand === "string" && body.agentCommand.trim()) || settings.agentCommand || "claude";
      const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
      try {
        const optimized = await (deps.promptOptimizer ?? optimizePrompt)({
          prompt,
          agentCommand: command,
          model,
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
    handler: async (_req, res, _p, { store, dataDir }) => {
      const design = (await listDesignProjects(dataDir)).map((project) => designProjectPayload(dataDir, project));
      const sharingan = store.listProjects()
        .filter((project) => project.sharingan === true
          && existsSync(join(projectDir(dataDir, project.id), "design", "project.json")))
        .map((project) => projectPayload(dataDir, project));
      const projects = [...design, ...sharingan]
        .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
        .map((project) => ({
          ...project,
          coverUrl: project.sharingan === false
            ? project.coverUrl
            : existsSync(join(projectDir(dataDir, project.id), ".cover.png"))
              ? `/api/projects/${project.id}/cover?t=${project.updatedAt}`
              : null,
        }));
      sendJson(res, 200, projects);
    },
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
    pattern: "/api/agents",
    handler: (req, res, _p, deps) => withRequestAbortSignal(
      req,
      res,
      REQUEST_LIFETIME_ONLY_SIGNAL,
      (signal) => handleListAgents(res, deps, signal),
    ),
  },
  {
    method: "POST",
    pattern: "/api/agents/rescan",
    handler: (req, res, _p, deps) => withRequestAbortSignal(
      req,
      res,
      REQUEST_LIFETIME_ONLY_SIGNAL,
      (signal) => handleRescanAgents(res, deps, signal),
    ),
  },
  {
    method: "POST",
    pattern: "/api/agents/rescan-stream",
    handler: (req, res, _p, deps) => withRequestAbortSignal(
      req,
      res,
      REQUEST_LIFETIME_ONLY_SIGNAL,
      (signal) => handleScanAgentsStream(res, deps, signal),
    ),
  },
  {
    method: "POST",
    pattern: "/api/projects",
    handler: async (req, res, _p, deps) => {
      const { store, dataDir } = deps;
      const decoded = await readJsonBody(req);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        return sendError(res, 400, "project body must be an object");
      }
      const body = decoded as Record<string, unknown>;
      const allowedFields = new Set(["name", "sharingan", "sourceUrl", "initialTurnId"]);
      const unexpected = Object.keys(body).find((field) => !allowedFields.has(field));
      if (unexpected) return sendError(res, 400, `project body contains unexpected field: ${unexpected}`);
      if (!isNonEmptyString(body.name)) return sendError(res, 400, "name is required");
      if (body.sharingan !== undefined && typeof body.sharingan !== "boolean") {
        return sendError(res, 400, "sharingan must be a boolean");
      }
      const sharingan = body.sharingan === true;
      if (sharingan && !isHttpUrl(body.sourceUrl)) return sendError(res, 400, "sharingan requires a valid http(s) sourceUrl");
      if (!sharingan && (body.sourceUrl !== undefined || body.initialTurnId !== undefined)) {
        return sendError(res, 400, "sourceUrl and initialTurnId require sharingan");
      }
      if (sharingan && body.initialTurnId !== undefined
        && (typeof body.initialTurnId !== "string"
          || !/^turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.initialTurnId))) {
        return sendError(res, 400, "sharingan initialTurnId is invalid");
      }
      if (sharingan && !deps.sharinganBootstrap) {
        return sendJson(res, 503, {
          error: "Sharingan capture service is unavailable",
          code: "SHARINGAN_BOOTSTRAP_UNAVAILABLE",
        });
      }
      if (!sharingan) {
        const project = await createDesignProject(dataDir, { name: body.name });
        return sendJson(res, 201, designProjectPayload(dataDir, project));
      }

      // Sharingan remains an independent capture domain with its existing SQLite
      // identity until that domain is migrated separately.
      const sourceUrl = new URL(String(body.sourceUrl).trim()).href;
      const project = store.createProject({
        name: body.name,
        mode: "standard",
        sharingan: true,
        sourceUrl,
      });
      try {
        await initializeDesignProject(dataDir, project.id);
      } catch (error) {
        store.deleteProject(project.id);
        throw error;
      }
      try {
        await deps.sharinganBootstrap!.register(
          project.id,
          typeof body.initialTurnId === "string" ? body.initialTurnId : null,
        );
      } catch (error) {
        store.deleteProject(project.id);
        await deps.sharinganBootstrap!.remove(project.id).catch(() => {});
        throw error;
      }
      void deps.runtimeSupervisor!
        .trackOperation(
          { projectId: project.id },
          async (signal) => {
            await deps.sharinganBootstrap!.ensure(project.id, signal);
          },
        )
        .catch(() => {});
      sendJson(res, 201, projectPayload(dataDir, project));
    },
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
    pattern: "/api/projects/:id",
    handler: async (_req, res, { id }, { store, dataDir }) => {
      const project = await getCurrentProject(dataDir, store, id!);
      return project
        ? sendJson(res, 200, currentProjectPayload(dataDir, project))
        : sendError(res, 404, "project not found");
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
      const decoded = await readJsonBody(req);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        return sendError(res, 400, "project patch must be an object");
      }
      const body = decoded as Record<string, unknown>;
      const unexpected = Object.keys(body).find((field) => field !== "name" && field !== "archived");
      if (unexpected) return sendError(res, 400, `project patch contains unexpected field: ${unexpected}`);
      if (body.name === undefined && body.archived === undefined) return sendError(res, 400, "project patch is empty");
      if (body.name !== undefined && !isNonEmptyString(body.name)) return sendError(res, 400, "name is required");
      if (body.archived !== undefined && typeof body.archived !== "boolean") {
        return sendError(res, 400, "archived must be a boolean");
      }

      const design = await getDesignProject(dataDir, id!);
      if (design) {
        const project = await updateDesignProject(dataDir, id!, {
          ...(body.name === undefined ? {} : { name: body.name.trim() }),
          ...(body.archived === undefined ? {} : { archived: body.archived }),
        });
        return sendJson(res, 200, designProjectPayload(dataDir, project));
      }

      let project = store.getProject(id!);
      if (project?.sharingan !== true) return sendError(res, 404, "project not found");
      if (body.name !== undefined) {
        project = store.updateProject(id!, { name: body.name.trim() });
      }
      if (body.archived !== undefined) {
        project = store.setArchived(id!, body.archived)!;
      }
      sendJson(res, 200, projectPayload(dataDir, project));
    },
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:id",
    projectAdmission: "skip",
    handler: async (_req, res, { id }, deps) => {
      const project = await getCurrentProject(deps.dataDir, deps.store, id!);
      if (!project) return sendError(res, 404, "project not found");
      await deps.runtimeSupervisor!.releaseProject(id!, {
        deleteProjectRecord: project.kind === "sharingan",
        afterBlock: project.kind === "sharingan" ? () => deps.sharinganBootstrap?.cancel(id!) : undefined,
        onPrecommitFailure() {
          if (project.kind === "sharingan") deps.sharinganBootstrap?.resume(id!);
        },
        afterDelete: project.kind === "sharingan" ? () => deps.sharinganBootstrap?.remove(id!) : undefined,
      });
      if (project.kind === "sharingan") deps.sharinganBootstrap?.resume(id!);
      res.writeHead(204);
      res.end();
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/cover",
    handler: (req, res, { id }, deps) => deps.runtimeSupervisor!.trackOperation(
      { projectId: id! },
      async (signal) => {
        if (!(await getCurrentProject(deps.dataDir, deps.store, id!))) {
          return sendError(res, 404, "project not found");
        }
        const body = (await readJsonBody(req, undefined, signal)) as { dataUrl?: string } | null;
        signal.throwIfAborted();
        const m = body?.dataUrl?.match(/^data:image\/png;base64,(.+)$/);
        if (!m) return sendError(res, 400, "dataUrl must be a base64 png");
        const dir = projectDir(deps.dataDir, id!);
        if (!(await getCurrentProject(deps.dataDir, deps.store, id!)) || !existsSync(dir)) {
          return sendError(res, 404, "project not found");
        }
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
      const target = sharinganRequestTarget(p.id!);
      return deps.runtimeSupervisor!.trackOperation(target.scope, () => handleSharinganCancel(res, target.captureId, deps.dataDir));
    },
  },
  {
    method: "GET",
    pattern: "/api/sharingan/:id/status",
    handler: (req, res, p, deps) => {
      if (!deps.store.getProject(p.id!)) return sendError(res, 404, "project not found");
      const target = sharinganRequestTarget(p.id!);
      handleSharinganStatus(res, target.captureId, deps.dataDir);
    },
  },
  {
    // Serve a captured-page screenshot (publicRead so <img src> works — it cannot send the daemon token header).
    method: "GET",
    pattern: "/api/sharingan/:id/shot",
    publicRead: true,
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(p.id!);
      handleSharinganShot(res, target.captureId, new URL(req.url ?? "", "http://x").searchParams.get("path") ?? "", deps.dataDir);
    },
  },
  {
    method: "GET",
    pattern: "/api/sharingan/:id/events",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(p.id!);
      deps.runtimeSupervisor!.assertAdmission(target.scope);
      handleSharinganEvents(res, target.captureId);
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/continue",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(p.id!);
      return deps.runtimeSupervisor!.trackOperation(target.scope, () => handleSharinganContinue(res, target.captureId, deps.dataDir));
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/focus",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(p.id!);
      deps.runtimeSupervisor!.assertAdmission(target.scope);
      handleSharinganFocus(res, target.captureId);
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/navigate",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(p.id!);
      return deps.runtimeSupervisor!.trackOperation(target.scope, (signal) => handleSharinganNavigate(req, res, target.captureId, deps.dataDir, signal));
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/capture",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(p.id!);
      return deps.runtimeSupervisor!.trackOperation(target.scope, (signal) => handleSharinganCapture(req, res, target.captureId, deps.dataDir, signal));
    },
  },
  {
    method: "GET",
    pattern: "/api/sharingan/:id/read-dom",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(p.id!);
      return deps.runtimeSupervisor!.trackOperation(target.scope, () => handleSharinganReadDom(res, target.captureId, deps.dataDir));
    },
  },
  {
    method: "GET",
    pattern: "/api/sharingan/:id/computed-styles",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(p.id!);
      return deps.runtimeSupervisor!.trackOperation(target.scope, () => handleSharinganComputedStyles(res, target.captureId, deps.dataDir));
    },
  },
  {
    method: "GET",
    pattern: "/api/sharingan/:id/links",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(p.id!);
      return deps.runtimeSupervisor!.trackOperation(target.scope, () => handleSharinganLinks(res, target.captureId, deps.dataDir));
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/click",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(p.id!);
      return deps.runtimeSupervisor!.trackOperation(target.scope, (signal) => handleSharinganClick(req, res, target.captureId, deps.dataDir, signal));
    },
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/scroll",
    handler: (req, res, p, deps) => {
      const target = sharinganRequestTarget(p.id!);
      return deps.runtimeSupervisor!.trackOperation(target.scope, (signal) => handleSharinganScroll(req, res, target.captureId, deps.dataDir, signal));
    },
  },
];

export function createApp(deps: AppDeps): http.Server {
  const appDeps: AppDeps = {
    ...deps,
    runtimeSupervisor: deps.runtimeSupervisor ?? createRuntimeSupervisor(deps),
  };
  appDeps.designProjectBootstrapPorts ??= createProductionDesignProjectBootstrapPorts(appDeps);
  appDeps.withFigmaProjectLease ??= async (projectId, operation) => {
    const lease = appDeps.runtimeSupervisor!.acquireOperationLease({ projectId });
    try {
      return await operation();
    } finally {
      lease.release();
    }
  };
  const webDir = appDeps.webDir ?? defaultWebDir();
  const hasWeb = existsSync(webDir);
  const extensionPairing = appDeps.extensionPairing ?? new StoreExtensionPairingService(appDeps.store);
  recoverIncompleteMoodboards(appDeps);
  const designStartupRecovery = Promise.resolve()
    .then(async () => {
      if (appDeps.designStartupRecovery) return appDeps.designStartupRecovery();
      const projectIds = await listInitializedDesignProjectIds(appDeps.dataDir);
      await Promise.all(projectIds.map((projectId) => recoverInterruptedDesignJobs(appDeps.dataDir, projectId)));
      await recoverDesignProjectBootstraps({
        dataDir: appDeps.dataDir,
        ports: {
          ensureProject: (project) => ensureDesignProjectAtId(appDeps.dataDir, project).then(() => undefined),
          ...appDeps.designProjectBootstrapPorts!,
        },
      });
      await recoverFigmaImports({
        dataDir: appDeps.dataDir,
        projectIds,
        client: appDeps.figmaClient ?? createFigmaRestClient(),
        credentialProvider: appDeps.figmaCredentialProvider
          ?? (() => resolveFigmaCredential({ dataDir: appDeps.dataDir, secretCipher: appDeps.secretCipher ?? null })),
        withProjectLease: appDeps.withFigmaProjectLease,
      });
    })
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => {
        log.error("Design startup recovery failed; Design routes will remain unavailable", error);
        return { ok: false as const, error };
      },
    );
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
        const needsDesignRecovery = route.pattern.includes("/design-canvas")
          || route.pattern === "/api/projects"
          || route.pattern === "/api/projects/bootstrap"
          || route.pattern === "/api/projects/:id"
          || route.pattern === "/api/projects/:id/title";
        if (needsDesignRecovery) {
          const recovery = await designStartupRecovery;
          if (!recovery.ok) {
            sendJson(res, 503, {
              error: "Design startup recovery did not complete; Design routes are unavailable",
              code: "design-recovery-unavailable",
            });
            return;
          }
        }
        const projectId = route.projectAdmission !== "skip"
          && (route.pattern.startsWith("/api/projects/:id")
            || route.pattern.startsWith("/api/sharingan/:id"))
          ? m.params.id
          : undefined;
        if (projectId === undefined) {
          await route.handler(req, res, m.params, appDeps, extensionPairing);
        } else {
          // One outer lease covers every project-scoped handler, including
          // bootstrap/read routes and async filesystem materializers that do
          // not own an inner RuntimeSupervisor operation. Deletion closes
          // admission synchronously, cancels what it can, and waits for this
          // lease before it snapshots cleanup identities and commits SQLite.
          const lease = appDeps.runtimeSupervisor!.acquireOperationLease({ projectId });
          try {
            await route.handler(req, res, m.params, appDeps, extensionPairing);
          } finally {
            lease.release();
          }
        }
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
      if (err instanceof DesignRevisionConflictError) {
        if (!res.headersSent) {
          sendJson(res, 409, {
            error: err.message,
            code: err.code,
            expectedRevision: err.expectedRevision,
            actualRevision: err.actualRevision,
          });
        } else res.end();
        return;
      }
      if (err instanceof DesignStorageError) {
        const status = err.code === "not-found" || err.code === "missing" ? 404
          : err.code === "forbidden" ? 403
            : err.code === "conflict" ? 409
              : err.code === "limit" ? 413
                : err.code === "corrupt" ? 409
                  : err.code === "invalid-html" ? 422
                    : 400;
        if (!res.headersSent) sendJson(res, status, { error: err.message, code: err.code });
        else res.end();
        return;
      }
      const message = err instanceof Error ? err.message : "internal error";
      if (!res.headersSent) sendError(res, 500, message);
      else res.end();
    }
  });
}
