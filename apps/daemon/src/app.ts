/**
 * The Dezin daemon HTTP app. A tiny node:http server with a hand-rolled router —
 * a lean HTTP server scoped to exactly what Dezin needs. This iteration: health,
 * project CRUD, conversations, and static artifact serving. POST /api/runs (the
 * generate loop) lands in the next iteration.
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "../../../packages/core/src/index.ts";
import type { CreateProjectInput, Project, Settings } from "../../../packages/core/src/index.ts";
import type { AgentRunner } from "../../../packages/agent/src/index.ts";
import type { DesignRegistry } from "../../../packages/design/src/index.ts";
import { sendJson, sendError, send, readJsonBody, readRawBody, matchPath, isHttpError } from "./http-util.ts";
import { serveProjectFile, serveFileFromBase, projectDir } from "./serve-static.ts";
import { figToJson, summarizeFig } from "./parse-fig.ts";
import { serveWeb, defaultWebDir } from "./serve-web.ts";
import { handleRun, handleRunStream, handleCancelRun } from "./run-handler.ts";
import type { ResearchPhaseRunner } from "./research-phase.ts";
import { handleExport, handleImportProject } from "./export-handler.ts";
import { handleListFiles } from "./files-handler.ts";
import {
  handleListVariants,
  handleCreateVariant,
  handleForkMessage,
  handleActivateVariant,
  handleRenameVariant,
  handleDeleteVariant,
} from "./variants-handler.ts";
import { handleGetVersion, handleGetVersionPreviewUrl, handleGetVersionDiff, handleRestoreVersion, handleSetVersionCover } from "./versions-handler.ts";
import { handleUploadRef } from "./refs-handler.ts";
import { setupStandardProject, getSetup, ensureDevServer, releaseDevServer } from "./project-runtime.ts";
import { activeArtifactDir, variantArtifactDir, variantRuntimeKey } from "./variant-workspaces.ts";
import { handleListDesignSystems, handleGetDesignSystem, handleImportBrand, handleListSkills } from "./catalog-handler.ts";
import { handleCreateEffect, handleGetEffect, handleListEffects, handleUpdateEffect } from "./effects-handler.ts";
import { handleListAgents, handleRescanAgents, handleScanAgentsStream, warmAgents, type AgentProber } from "./agents-handler.ts";
import { handleListModelProviderModels, handleTestModelProvider } from "./model-provider-handler.ts";
import { analyzeImage } from "./analyze-image.ts";
import { buildAgentEnv } from "./agent-env.ts";
import { optimizePrompt, type PromptOptimizer } from "./prompt-optimize.ts";
import { captureCover, captureCoverUrl } from "./capture-cover.ts";
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
  handleServeMoodboardAsset,
  handleUploadMoodboardAsset,
} from "./moodboard-handler.ts";
import type { MoodboardAgentTextRunner } from "./moodboard-agent.ts";
import { assertSafeId, redactSettings, requireDaemonRequest, type DaemonSecurityOptions } from "./security.ts";
import { mergeProviderProfilesForUpdate } from "./provider-profile-config.ts";

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
  standardProjectSetup?: (projectId: string, projectDir: string) => void | Promise<void>;
  /** Standard dev-server hooks; tests can avoid spawning npm. */
  ensureDevServer?: typeof ensureDevServer;
  releaseDevServer?: typeof releaseDevServer;
  /** Cover capture hook for Standard dev-server URLs; tests can avoid launching Chrome. */
  captureCoverUrl?: (url: string, outPath: string) => Promise<boolean>;
  /** Cover capture hook for HTML snapshot files; tests can avoid launching Chrome. */
  captureCover?: typeof captureCover;
  /** Background title generator hook; tests can avoid launching an agent. */
  titleGenerator?: TitleGenerator;
  /** Prompt optimizer hook; tests can avoid launching a real agent. */
  promptOptimizer?: PromptOptimizer;
  /** Research phase hook; tests can avoid launching a real research agent. */
  researchPhase?: ResearchPhaseRunner;
  /** Moodboard chat one-shot agent hook; tests can avoid launching a real CLI. */
  moodboardAgentText?: MoodboardAgentTextRunner;
  /** Provider model-list fetcher; tests can avoid real network calls. */
  modelProviderFetch?: typeof fetch;
  /** Optional local API boundary guard. */
  security?: DaemonSecurityOptions;
  /** Unique owner id for this daemon process; persisted on newly-created runs. */
  daemonOwnerId?: string;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
  publicRead?: boolean;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
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

function validateRouteParams(params: Record<string, string>): void {
  for (const [key, value] of Object.entries(params)) {
    if (key === "rest") continue;
    assertSafeId(value, key);
  }
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: "/api/health",
    handler: (_req, res, _p, deps) => sendJson(res, 200, { ok: true, version: deps.version ?? "0.0.0" }),
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
    handler: async (req, res, _p, { store }) => {
      const body = (await readJsonBody(req)) as { image?: string; agentCommand?: string; model?: string } | null;
      const image = typeof body?.image === "string" ? body.image : "";
      if (!image) return sendError(res, 400, "no image");
      const settings = store.getSettings();
      const command = (typeof body?.agentCommand === "string" && body.agentCommand) || settings.agentCommand || "claude";
      const model = typeof body?.model === "string" ? body.model : undefined;
      try {
        const brief = await analyzeImage(command, image, model, undefined, buildAgentEnv(settings, command));
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
      const mode = body.mode === "standard" ? "standard" : "prototype";
      const project = store.createProject({
        name: body.name,
        skillId: body.skillId ?? null,
        designSystemId: body.designSystemId ?? null,
        mode,
      });
      // Standard projects scaffold a real Vite project + install deps in the background.
      if (mode === "standard") void (deps.standardProjectSetup ?? setupStandardProject)(project.id, projectDir(dataDir, project.id));
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
        const { url } = await (deps.ensureDevServer ?? ensureDevServer)(id!, await activeArtifactDir(deps, project), variantRuntimeKey(id!, active));
        sendJson(res, 200, { url });
      } catch (err) {
        sendError(res, 409, err instanceof Error ? err.message : "dev server unavailable");
      }
    },
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:id/devserver",
    handler: (_req, res, { id }, deps) => {
      const project = deps.store.getProject(id!);
      if (!project) return sendError(res, 404, "project not found");
      const active = deps.store.getActiveVariantId(id!) ?? deps.store.ensureMainVariant(id!).id;
      const released = (deps.releaseDevServer ?? releaseDevServer)(variantRuntimeKey(id!, active));
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
    handler: async (_req, res, { id }, { store, dataDir }) => {
      store.deleteProject(id!);
      await rm(projectDir(dataDir, id!), { recursive: true, force: true });
      res.writeHead(204);
      res.end();
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/conversations",
    handler: (_req, res, { id }, { store }) => {
      if (!store.getProject(id!)) return sendError(res, 404, "project not found");
      sendJson(res, 200, store.listConversations(id!));
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/conversations",
    handler: async (req, res, { id }, { store }) => {
      if (!store.getProject(id!)) return sendError(res, 404, "project not found");
      const body = (await readJsonBody(req)) as { title?: string };
      sendJson(res, 201, store.createConversation(id!, body.title?.trim() || "Untitled"));
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
    method: "GET",
    pattern: "/api/projects/:id/files",
    handler: (_req, res, params, deps) => handleListFiles(res, params, deps),
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
    method: "GET",
    pattern: "/api/projects/:id/variants",
    handler: (_req, res, params, deps) => handleListVariants(res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/variants",
    handler: (req, res, params, deps) => handleCreateVariant(req, res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/messages/:messageId/fork",
    handler: (req, res, params, deps) => handleForkMessage(req, res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/variants/:vid/activate",
    handler: (_req, res, params, deps) => handleActivateVariant(res, params, deps),
  },
  {
    method: "PATCH",
    pattern: "/api/projects/:id/variants/:vid",
    handler: (req, res, params, deps) => handleRenameVariant(req, res, params, deps),
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
      const base = await variantArtifactDir(deps, project, vid!);
      if (!base) return sendError(res, 404, "variant not found");
      return serveFileFromBase(res, base, rest ?? "");
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/versions/:runId",
    publicRead: true,
    handler: (_req, res, params, deps) => handleGetVersion(res, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/versions/:runId/preview-url",
    publicRead: true,
    handler: (_req, res, params, deps) => handleGetVersionPreviewUrl(res, params, deps),
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/versions/:runId/diff",
    handler: (_req, res, params, deps) => handleGetVersionDiff(res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/versions/:runId/restore",
    handler: (_req, res, params, deps) => handleRestoreVersion(res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/versions/:runId/cover",
    handler: (_req, res, params, deps) => handleSetVersionCover(res, params, deps),
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/refs",
    handler: (req, res, params, deps) => handleUploadRef(req, res, params, deps),
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
    handler: (req, res, params, deps) => handleExport(req, res, params, deps),
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

      const root = projectDir(deps.dataDir, id!);
      const coverPath = join(root, ".cover.png");
      if (existsSync(coverPath)) return sendJson(res, 200, { captured: false, reason: "exists" });

      const active = deps.store.getActiveVariantId(id!) ?? deps.store.ensureMainVariant(id!).id;
      const runtimeKey = variantRuntimeKey(id!, active);
      const releaseAfter = new URL(req.url ?? "", "http://localhost").searchParams.get("release") === "1";
      try {
        const dir = await activeArtifactDir(deps, project);
        const { url } = await (deps.ensureDevServer ?? ensureDevServer)(id!, dir, runtimeKey);
        const captured = await (deps.captureCoverUrl ?? captureCoverUrl)(url, coverPath);
        sendJson(res, 200, { captured });
      } catch (err) {
        sendError(res, 409, err instanceof Error ? err.message : "cover capture failed");
      } finally {
        if (releaseAfter) (deps.releaseDevServer ?? releaseDevServer)(runtimeKey);
      }
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/cover",
    handler: async (req, res, { id }, { dataDir }) => {
      const body = (await readJsonBody(req)) as { dataUrl?: string } | null;
      const m = body?.dataUrl?.match(/^data:image\/png;base64,(.+)$/);
      if (!m) return sendError(res, 400, "dataUrl must be a base64 png");
      const dir = projectDir(dataDir, id!);
      if (!existsSync(dir)) return sendError(res, 404, "project not found");
      writeFileSync(join(dir, ".cover.png"), Buffer.from(m[1]!, "base64"));
      sendJson(res, 200, { ok: true });
    },
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
];

export function createApp(deps: AppDeps): http.Server {
  const webDir = deps.webDir ?? defaultWebDir();
  const hasWeb = existsSync(webDir);
  warmAgents(deps.agentProber, deps.dataDir); // reload the persisted scan (or probe once) at startup
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
        requireDaemonRequest(req, { ...deps.security, allowMissingToken: route.publicRead === true });
        await route.handler(req, res, m.params, deps);
        return;
      }
      if (matchedPathButNotMethod) {
        requireDaemonRequest(req, deps.security);
        return sendError(res, 405, "method not allowed");
      }
      // Unmatched GET → serve the built web app (SPA) when present (Electron / prod).
      if (method === "GET" && hasWeb && !pathname.startsWith("/api/")) {
        requireDaemonRequest(req, { ...deps.security, allowMissingToken: true });
        return serveWeb(res, webDir, pathname, { daemonToken: deps.security?.token });
      }
      requireDaemonRequest(req, deps.security);
      sendError(res, 404, "not found");
    } catch (err) {
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
