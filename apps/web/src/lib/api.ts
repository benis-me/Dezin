import type {
  DesignAgentTurnResult,
  DesignCanvas,
  DesignCanvasIntent,
  DesignExportResult,
  DesignJob,
  DesignNodeGeometry,
  DesignNodeKind,
  DesignNodeVersion,
  DesignThread,
} from "../design-canvas/types.ts";

/**
 * Typed client for the Dezin daemon. fetch is injectable so it can be unit-tested
 * with a mock (no live daemon). Types mirror @dezin/core but are declared locally —
 * the browser bundle must not import the node packages.
 */

export type ExtensionScope = "capture:write" | "image:analyze";
export interface ExtensionCredential {
  id: string;
  extensionId: string;
  scopes: ExtensionScope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
  /** A screenshot of the generated design, used as the gallery cover. */
  coverUrl?: string | null;
  /** Absolute on-disk project folder, when served by the local daemon. */
  projectPath?: string;
  /** Whether this project was created by cloning a website via Sharingan. */
  sharingan?: boolean;
  /** The source URL Sharingan cloned this project from, when sharingan is true. */
  sourceUrl?: string;
}

export interface CreateProjectInput {
  name: string;
  sharingan?: boolean;
  sourceUrl?: string;
}

export type DesignCanvasAssetImportSource =
  | { name: string; mimeType: string; base64: string; sourceVersion?: never }
  | {
      name: string;
      mimeType: string;
      sourceVersion: { projectId: string; nodeId: string; versionId: string };
      base64?: never;
    };

export interface DesignCanvasAssetImportItem {
  asset: DesignCanvasAssetImportSource;
  node: {
    id?: string;
    kind: DesignNodeKind;
    name?: string;
    geometry?: Partial<DesignNodeGeometry>;
  };
}

export type MoodboardNodeType = "image" | "image-generator" | "note" | "section" | "video";

export interface Moodboard {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
  coverAssetId?: string | null;
  coverUrl?: string | null;
}

export interface MoodboardAsset {
  id: string;
  boardId: string;
  kind: "image" | "video";
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  source: "upload" | "generated" | "edited";
  createdAt: number;
  url?: string;
}

export interface MoodboardNode {
  id: string;
  boardId: string;
  type: MoodboardNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SaveMoodboardNodeInput {
  id?: string;
  type: MoodboardNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  zIndex?: number;
  data?: Record<string, unknown>;
}

export interface StartMoodboardInput {
  name: string;
  prompt?: string;
  mode: "agent" | "generate";
  images?: Array<{
    name: string;
    contentBase64: string;
    mimeType?: string;
    width?: number;
    height?: number;
  }>;
  agentCommand?: string;
  agentModel?: string;
  imageModel?: string;
}

export interface MoodboardMessage {
  id: string;
  boardId: string;
  conversationId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
}

export interface MoodboardConversation {
  id: string;
  boardId: string;
  title: string;
  createdAt: number;
  turns?: number;
}

export type ImageGenerationParams = {
  quality?: "auto" | "low" | "medium" | "high";
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
  background?: "auto" | "transparent" | "opaque";
  outputFormat?: "png" | "jpeg" | "webp";
  outputCompression?: number;
  moderation?: "auto" | "low";
  count?: number;
};

export interface GenerateMoodboardImageOptions {
  x?: number;
  y?: number;
  generatorId?: string;
  model?: string;
  sourceAssetId?: string;
  referenceAssetIds?: string[];
  conversationId?: string;
  params?: ImageGenerationParams;
}

export interface MoodboardDetail extends Moodboard {
  assets: MoodboardAsset[];
  nodes: MoodboardNode[];
  conversations?: MoodboardConversation[];
  activeConversationId?: string;
  messages: MoodboardMessage[];
}

export interface PromptOptimizeInput {
  prompt: string;
  agentCommand?: string;
  model?: string;
}

export interface PromptOptimizeResult {
  prompt: string;
}

export interface Swatch {
  bg: string;
  surface: string;
  fg: string;
  accent: string;
}

export interface DesignSystemCard {
  id: string;
  name: string;
  category: string;
  summary: string;
  swatch?: Swatch;
  origin?: "built-in" | "custom";
}

export interface DesignSystemDetail extends DesignSystemCard {
  designMd: string;
  tokensCss: string;
}

export type EffectOrigin = "built-in" | "custom";
export type EffectParamKind = "number" | "color" | "select" | "boolean" | "image";
export type EffectParamValue = string | number | boolean;

export interface EffectParamOption {
  label: string;
  value: string;
}

export interface EffectParamDefinition {
  id: string;
  label: string;
  type: EffectParamKind;
  defaultValue: EffectParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: EffectParamOption[];
  description?: string;
}

export interface EffectPreset {
  id: string;
  name: string;
  values: Record<string, EffectParamValue>;
}

export interface EffectCard {
  id: string;
  name: string;
  origin: EffectOrigin;
  category: string;
  summary: string;
  previewUrl?: string;
}

export interface EffectDetail extends EffectCard {
  parameters: EffectParamDefinition[];
  presets: EffectPreset[];
  code: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface CreateEffectInput {
  name: string;
}

export type UpdateEffectInput = Partial<Pick<EffectDetail, "name" | "category" | "summary" | "code" | "parameters" | "presets">>;

export interface BrandImportInput {
  name: string;
  accent: string;
  displayFont?: string;
  bodyFont?: string;
  vibe?: string;
  category?: string;
  agentCommand?: string;
  model?: string;
}

export interface Settings {
  agentCommand: string;
  model: string;
  apiBaseUrl: string;
  apiKey: string;
  apiKeyConfigured?: boolean;
  customInstructions: string;
  imageApiBaseUrl: string;
  imageApiKey: string;
  imageApiKeyConfigured?: boolean;
  imageModel: string;
  removeBackgroundModel: string;
  editRegionModel: string;
  extractLayerModel: string;
  videoApiBaseUrl: string;
  videoApiKey: string;
  videoApiKeyConfigured?: boolean;
  videoModel: string;
  aiProviderId: string;
  aiProviderEnabled: boolean;
  aiProviderModels: string;
  aiProviderOrganization: string;
  aiProviderProfiles: string;
  sharinganAffirmed: boolean;
}

export interface ModelProviderModel {
  id: string;
  name?: string;
  capabilities?: string[];
}

export interface ModelProviderTestResult {
  ok: boolean;
  message: string;
}

export interface ModelProviderModelsResult {
  models: ModelProviderModel[];
  source?: string;
}

export interface AgentInfo {
  id: string;
  command: string;
  available: boolean;
  availability?: "ready" | "not-installed" | "authentication-required" | "verification-required";
  unavailableReason?: string;
  version?: string;
  models: string[];
}

/** Streamed progress from a rescan: presence/readiness/model steps, then a final "done". */
export type ScanEvent =
  | { type: "progress"; id: string; label: string; phase: "probe" | "readiness" | "models" }
  | { type: "done"; agents: AgentInfo[] };

export interface Health {
  ok: boolean;
  version: string;
}

/**
 * A server-sent run event. Known `type`s: run-start, turn-start, turn-end, lint,
 * done, run-done, run-error. Extra fields vary by type, so this stays open.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  daemonToken?: string;
}

export type ApiErrorDetails = Record<string, unknown>;

export class ApiError extends Error {
  status: number;
  details: ApiErrorDetails | null;
  constructor(status: number, message: string, details: ApiErrorDetails | null = null) {
    super(message || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

function defaultDaemonToken(): string {
  const g = globalThis as typeof globalThis & { __DEZIN_DAEMON_TOKEN__?: string };
  return typeof g.__DEZIN_DAEMON_TOKEN__ === "string" ? g.__DEZIN_DAEMON_TOKEN__ : "";
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText ?? "";
  }
}

async function readApiError(res: Response): Promise<{ message: string; details: ApiErrorDetails | null }> {
  const text = await safeText(res);
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const details = parsed as ApiErrorDetails;
        const error = details.error;
        const message = details.message;
        if (typeof error === "string" && error.trim()) return { message: error.trim(), details };
        if (typeof message === "string" && message.trim()) return { message: message.trim(), details };
        return { message: text, details };
      }
    } catch {
      // Keep the raw response text if the JSON body is malformed.
    }
  }
  return { message: text, details: null };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

interface ParsedSseBlock {
  event: string | null;
  data: unknown;
}

function parseSseEnvelope(block: string): ParsedSseBlock | null {
  const eventLine = block
    .split("\n")
    .find((line) => line.startsWith("event:"));
  const dataLines = block
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => (l.startsWith("data: ") ? l.slice(6) : l.slice(5)));
  if (dataLines.length === 0) return null;
  try {
    return {
      event: eventLine === undefined ? null : eventLine.slice(6).trim() || null,
      data: JSON.parse(dataLines.join("\n")) as unknown,
    };
  } catch {
    return null;
  }
}

/** Parse one SSE block ("data: {...}" possibly multi-line) into its JSON payload. */
export function parseSseBlock<T = unknown>(block: string): T | null {
  return (parseSseEnvelope(block)?.data as T | undefined) ?? null;
}

export interface SharinganStep {
  at: number;
  kind: "navigate" | "screenshot" | "dom" | "styles" | "links" | "assets" | "login-required" | "done";
  text: string;
  /** For a "screenshot" step: the project-dir-relative path of the shot it produced (feed to sharinganShotUrl). */
  shot?: string;
}

/** A single captured page: its URL, title, and screenshots keyed by viewport/label. */
export interface SharinganPage {
  url: string;
  title: string;
  screenshots: Record<string, string>;
}

/** Overall capture status for a Sharingan clone job. */
export type SharinganPhase = "idle" | "capturing" | "login-required" | "captured" | "error" | "probing" | "cancelled";
export interface SharinganStatus {
  phase: SharinganPhase;
  steps: number;
  pages: SharinganPage[];
  error?: string;
}

/** Generic SSE consumer for JSON-shaped events such as Sharingan steps. */
export async function* consumeSseJson<T>(res: Response): AsyncGenerator<T> {
  if (!res.ok) throw new ApiError(res.status, await safeText(res));
  if (!res.body) {
    // Environments without a streaming body: parse the whole text.
    for (const block of (await res.text()).split("\n\n")) {
      const parsed = parseSseBlock(block) as T | null;
      if (parsed) yield parsed;
    }
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseSseBlock(block) as T | null;
      if (parsed) yield parsed;
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    const parsed = parseSseBlock(tail) as T | null;
    if (parsed) yield parsed;
  }
}

export interface ApiClient {
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  generateProjectTitle(id: string, brief: string): Promise<Project>;
  getProject(id: string): Promise<Project>;
  patchProject(id: string, patch: Partial<CreateProjectInput> & { archived?: boolean }): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  getDesignCanvas(projectId: string, signal?: AbortSignal): Promise<DesignCanvas>;
  mutateDesignCanvas(
    projectId: string,
    input: { expectedRevision: number; intents: readonly DesignCanvasIntent[] },
  ): Promise<DesignCanvas>;
  undoDesignCanvas(projectId: string, expectedRevision: number): Promise<DesignCanvas>;
  redoDesignCanvas(projectId: string, expectedRevision: number): Promise<DesignCanvas>;
  listDesignCanvasAssets(projectId: string, signal?: AbortSignal): Promise<Array<{
    id: string;
    name: string;
    mimeType: string;
    checksum: string;
    bytes: number;
    fileName?: string;
    createdAt: number;
  }>>;
  createDesignCanvasAsset(
    projectId: string,
    input:
      | { name: string; mimeType: string; base64: string; uploadedFileId?: never; sourceVersion?: never }
      | { name: string; mimeType: string; uploadedFileId: string; base64?: never; sourceVersion?: never }
      | {
          name: string;
          mimeType: string;
          sourceVersion: { projectId: string; nodeId: string; versionId: string };
          base64?: never;
          uploadedFileId?: never;
        },
  ): Promise<{
    id: string;
    name: string;
    mimeType: string;
    checksum: string;
    bytes: number;
    fileName?: string;
    createdAt: number;
  }>;
  importDesignCanvasAssets(
    projectId: string,
    input: { expectedRevision: number; items: readonly DesignCanvasAssetImportItem[] },
  ): Promise<DesignCanvas>;
  designCanvasAssetUrl(projectId: string, assetId: string): string;
  listDesignNodeVersions(projectId: string, nodeId: string, signal?: AbortSignal): Promise<DesignNodeVersion[]>;
  designNodeVersionPreviewUrl(projectId: string, nodeId: string, versionId: string): string;
  getDesignThread(
    projectId: string,
    scope: { type: "main" } | { type: "node"; nodeId: string },
    signal?: AbortSignal,
  ): Promise<DesignThread>;
  submitDesignAgentTurn(
    projectId: string,
    scope: { type: "main" } | { type: "node"; nodeId: string },
    input: {
      message: string;
      context?: { nodeIds: string[] };
      agentCommand?: string;
      model?: string;
      idempotencyKey?: string;
    },
  ): Promise<DesignAgentTurnResult>;
  listDesignJobs(projectId: string, signal?: AbortSignal): Promise<DesignJob[]>;
  cancelDesignJob(projectId: string, jobId: string): Promise<DesignJob>;
  startDesignImplementationExport(
    projectId: string,
    input: { canvasRevision: number; agentCommand?: string; model?: string },
  ): Promise<DesignExportResult>;
  listDesignSystems(): Promise<DesignSystemCard[]>;
  getDesignSystem(id: string): Promise<DesignSystemDetail>;
  importBrand(input: BrandImportInput): Promise<DesignSystemCard>;
  listEffects(options?: { query?: string }): Promise<EffectCard[]>;
  getEffect(id: string): Promise<EffectDetail>;
  createEffect(input: CreateEffectInput): Promise<EffectDetail>;
  updateEffect(id: string, patch: UpdateEffectInput): Promise<EffectDetail>;
  createExtensionPairingCode(): Promise<{ code: string; expiresAt: number }>;
  listExtensionCredentials(): Promise<ExtensionCredential[]>;
  revokeExtensionCredential(id: string): Promise<void>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  testModelProvider(providerId: string): Promise<ModelProviderTestResult>;
  listModelProviderModels(providerId: string): Promise<ModelProviderModelsResult>;
  listAgents(): Promise<AgentInfo[]>;
  rescanAgents(): Promise<AgentInfo[]>;
  /** Rescan with per-agent progress (SSE). Yields progress events, then a final "done". */
  scanAgentsStream(): AsyncGenerator<ScanEvent>;
  getHealth(): Promise<Health>;
  optimizePrompt(input: PromptOptimizeInput): Promise<PromptOptimizeResult>;
  /** Parse a Figma .fig file into an agent-ready design summary. */
  parseFig(file: Blob, name: string): Promise<{ name: string; summary: string }>;
  /** Explicitly consume the one-shot pending capture from the browser extension. */
  getCapture(): Promise<{ images: { name: string; base64: string }[]; note: string; source: string }>;
  listMoodboards(): Promise<Moodboard[]>;
  createMoodboard(input: { name: string }): Promise<Moodboard>;
  startMoodboard(input: StartMoodboardInput): Promise<Moodboard>;
  getMoodboard(id: string): Promise<MoodboardDetail>;
  patchMoodboard(id: string, patch: Partial<Pick<Moodboard, "name" | "coverAssetId">> & { archived?: boolean }): Promise<Moodboard>;
  deleteMoodboard(id: string): Promise<void>;
  listMoodboardNodes(id: string): Promise<MoodboardNode[]>;
  saveMoodboardNodes(id: string, nodes: SaveMoodboardNodeInput[]): Promise<MoodboardNode[]>;
  listMoodboardConversations(id: string): Promise<MoodboardConversation[]>;
  createMoodboardConversation(id: string, title?: string): Promise<MoodboardConversation>;
  renameMoodboardConversation(id: string, conversationId: string, title: string): Promise<MoodboardConversation>;
  deleteMoodboardConversation(id: string, conversationId: string): Promise<{ ok: boolean; conversations: MoodboardConversation[] }>;
  listMoodboardMessages(id: string, conversationId?: string): Promise<MoodboardMessage[]>;
  postMoodboardMessage(
    id: string,
    content: string,
    options?: { agentCommand?: string; model?: string; conversationId?: string },
  ): Promise<{ messages: MoodboardMessage[]; nodes?: MoodboardNode[] }>;
  uploadMoodboardAsset(
    id: string,
    input: { name: string; contentBase64: string; mimeType?: string; width?: number; height?: number },
  ): Promise<MoodboardAsset & { url: string }>;
  generateMoodboardImage(
    id: string,
    prompt: string,
    options?: GenerateMoodboardImageOptions,
  ): Promise<{
    asset: MoodboardAsset & { url: string };
    nodes: MoodboardNode[];
    messages: MoodboardMessage[];
  }>;
  suggestPreferences(): Promise<{ suggestion: string; signals: number }>;
  /** Start a Sharingan clone capture for the given source URL. */
  startSharingan(id: string, url: string): Promise<void>;
  /** Cancel the capture and wait until the daemon has released its browser/session resources. */
  cancelSharingan(id: string): Promise<void>;
  /** Current capture status: phase, step count, and pages captured so far. */
  sharinganStatus(id: string): Promise<SharinganStatus>;
  /** Resume a capture that's paused (e.g. waiting after a login-required step). */
  continueSharingan(id: string): Promise<void>;
  /** Bring the capture's browser window to the foreground (e.g. for manual login). */
  focusSharingan(id: string): Promise<void>;
  /** Stream capture steps live (SSE) as Sharingan navigates and screenshots the site. */
  streamSharinganEvents(id: string, signal?: AbortSignal): AsyncGenerator<SharinganStep>;
  /** URL serving a captured screenshot, given its relative path within the capture. */
  sharinganShotUrl(id: string, relPath: string): string;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const baseUrl = opts.baseUrl ?? "";
  const f: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const daemonToken = (opts.daemonToken ?? defaultDaemonToken()).trim();

  function initWithDaemonToken(init?: RequestInit): RequestInit | undefined {
    if (!daemonToken) return init;
    const rawHeaders = init?.headers;
    const headers =
      rawHeaders instanceof Headers
        ? Object.fromEntries(rawHeaders.entries())
        : Array.isArray(rawHeaders)
          ? Object.fromEntries(rawHeaders)
          : { ...(rawHeaders as Record<string, string> | undefined) };
    headers["x-dezin-daemon-token"] = daemonToken;
    return { ...init, headers };
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await f(baseUrl + path, initWithDaemonToken(init));
    if (!res.ok) {
      const error = await readApiError(res);
      throw new ApiError(res.status, error.message, error.details);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async function* scanAgentsStream(): AsyncGenerator<ScanEvent> {
    const res = await f(baseUrl + "/api/agents/rescan-stream", initWithDaemonToken({ method: "POST" }));
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    const handle = (block: string): ScanEvent | null => {
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) return null;
      try {
        return JSON.parse(data) as ScanEvent;
      } catch {
        return null;
      }
    };
    if (!res.body) {
      for (const block of (await res.text()).split("\n\n")) {
        const ev = handle(block);
        if (ev) yield ev;
      }
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const ev = handle(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (ev) yield ev;
      }
    }
    buffer += decoder.decode();
    const ev = handle(buffer.trim());
    if (ev) yield ev;
  }

  const enc = (id: string) => encodeURIComponent(id);
  return {
    scanAgentsStream,
    listProjects: () => json<Project[]>("/api/projects"),
    createProject: (input) => json<Project>("/api/projects", jsonInit("POST", input)),
    generateProjectTitle: (id, brief) => json<Project>(`/api/projects/${enc(id)}/title`, jsonInit("POST", { brief })),
    getProject: (id) => json<Project>(`/api/projects/${enc(id)}`),
    getDesignCanvas: (projectId, signal) =>
      json<DesignCanvas>(`/api/projects/${enc(projectId)}/design-canvas`, signal === undefined ? undefined : { signal }),
    mutateDesignCanvas: (projectId, input) =>
      json<DesignCanvas>(`/api/projects/${enc(projectId)}/design-canvas`, jsonInit("PUT", input)),
    undoDesignCanvas: (projectId, expectedRevision) =>
      json<DesignCanvas>(`/api/projects/${enc(projectId)}/design-canvas/undo`, jsonInit("POST", { expectedRevision })),
    redoDesignCanvas: (projectId, expectedRevision) =>
      json<DesignCanvas>(`/api/projects/${enc(projectId)}/design-canvas/redo`, jsonInit("POST", { expectedRevision })),
    listDesignCanvasAssets: (projectId, signal) =>
      json<Array<{
        id: string;
        name: string;
        mimeType: string;
        checksum: string;
        bytes: number;
        fileName?: string;
        createdAt: number;
      }>>(
        `/api/projects/${enc(projectId)}/design-canvas/assets`,
        signal === undefined ? undefined : { signal },
      ),
    createDesignCanvasAsset: (projectId, input) =>
      json<{
        id: string;
        name: string;
        mimeType: string;
        checksum: string;
        bytes: number;
        fileName?: string;
        createdAt: number;
      }>(`/api/projects/${enc(projectId)}/design-canvas/assets`, jsonInit("POST", input)),
    importDesignCanvasAssets: (projectId, input) =>
      json<DesignCanvas>(`/api/projects/${enc(projectId)}/design-canvas/assets/import`, jsonInit("POST", input)),
    designCanvasAssetUrl: (projectId, assetId) =>
      `${baseUrl}/api/projects/${enc(projectId)}/design-canvas/assets/${enc(assetId)}/content`,
    listDesignNodeVersions: (projectId, nodeId, signal) =>
      json<DesignNodeVersion[]>(
        `/api/projects/${enc(projectId)}/design-canvas/nodes/${enc(nodeId)}/versions`,
        signal === undefined ? undefined : { signal },
      ),
    designNodeVersionPreviewUrl: (projectId, nodeId, versionId) =>
      `${baseUrl}/api/projects/${enc(projectId)}/design-canvas/nodes/${enc(nodeId)}/versions/${enc(versionId)}/preview/`,
    getDesignThread: (projectId, scope, signal) =>
      json<DesignThread>(
        scope.type === "main"
          ? `/api/projects/${enc(projectId)}/design-canvas/agent/thread`
          : `/api/projects/${enc(projectId)}/design-canvas/nodes/${enc(scope.nodeId)}/agent/thread`,
        signal === undefined ? undefined : { signal },
      ),
    submitDesignAgentTurn: (projectId, scope, input) =>
      json<DesignAgentTurnResult>(
        scope.type === "main"
          ? `/api/projects/${enc(projectId)}/design-canvas/agent/turns`
          : `/api/projects/${enc(projectId)}/design-canvas/nodes/${enc(scope.nodeId)}/agent/turns`,
        jsonInit("POST", input),
      ),
    listDesignJobs: (projectId, signal) =>
      json<DesignJob[]>(
        `/api/projects/${enc(projectId)}/design-canvas/jobs`,
        signal === undefined ? undefined : { signal },
      ),
    cancelDesignJob: (projectId, jobId) =>
      json<DesignJob>(`/api/projects/${enc(projectId)}/design-canvas/jobs/${enc(jobId)}`, { method: "DELETE" }),
    startDesignImplementationExport: (projectId, input) =>
      json<DesignExportResult>(`/api/projects/${enc(projectId)}/design-canvas/exports`, jsonInit("POST", input)),
    patchProject: (id, patch) => json<Project>(`/api/projects/${enc(id)}`, jsonInit("PATCH", patch)),
    deleteProject: (id) => json<void>(`/api/projects/${enc(id)}`, { method: "DELETE" }),
    listDesignSystems: () => json<DesignSystemCard[]>("/api/design-systems"),
    getDesignSystem: (id) => json<DesignSystemDetail>(`/api/design-systems/${enc(id)}`),
    importBrand: (input) => json<DesignSystemCard>("/api/design-systems/import", jsonInit("POST", input)),
    listEffects: (options) => json<EffectCard[]>(`/api/effects${options?.query?.trim() ? `?query=${enc(options.query.trim())}` : ""}`),
    getEffect: (id) => json<EffectDetail>(`/api/effects/${enc(id)}`),
    createEffect: (input) => json<EffectDetail>("/api/effects", jsonInit("POST", input)),
    updateEffect: (id, patch) => json<EffectDetail>(`/api/effects/${enc(id)}`, jsonInit("PATCH", patch)),
    createExtensionPairingCode: () => json<{ code: string; expiresAt: number }>("/api/extension/pairing-code", { method: "POST" }),
    listExtensionCredentials: () => json<ExtensionCredential[]>("/api/extension/credentials"),
    revokeExtensionCredential: (id) => json<void>(`/api/extension/credentials/${enc(id)}`, { method: "DELETE" }),
    getSettings: () => json<Settings>("/api/settings"),
    updateSettings: (patch) => json<Settings>("/api/settings", jsonInit("PUT", patch)),
    testModelProvider: (providerId) => json<ModelProviderTestResult>("/api/model-providers/test", jsonInit("POST", { providerId })),
    listModelProviderModels: (providerId) => json<ModelProviderModelsResult>("/api/model-providers/models", jsonInit("POST", { providerId })),
    listAgents: () => json<AgentInfo[]>("/api/agents"),
    rescanAgents: () => json<AgentInfo[]>("/api/agents/rescan", { method: "POST" }),
    getHealth: () => json<Health>("/api/health"),
    optimizePrompt: (input) => json<PromptOptimizeResult>("/api/prompts/optimize", jsonInit("POST", input)),
    parseFig: (file, name) =>
      json<{ name: string; summary: string }>("/api/fig/parse", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(name) },
        body: file,
      }),
    getCapture: () =>
      json<{ images: { name: string; base64: string }[]; note: string; source: string }>("/api/capture/consume", {
        method: "POST",
      }),
    listMoodboards: () => json<Moodboard[]>("/api/moodboards"),
    createMoodboard: (input) => json<Moodboard>("/api/moodboards", jsonInit("POST", input)),
    startMoodboard: (input) => json<Moodboard>("/api/moodboards/start", jsonInit("POST", input)),
    getMoodboard: (id) => json<MoodboardDetail>(`/api/moodboards/${enc(id)}`),
    patchMoodboard: (id, patch) => json<Moodboard>(`/api/moodboards/${enc(id)}`, jsonInit("PATCH", patch)),
    deleteMoodboard: (id) => json<void>(`/api/moodboards/${enc(id)}`, { method: "DELETE" }),
    listMoodboardNodes: (id) => json<MoodboardNode[]>(`/api/moodboards/${enc(id)}/nodes`),
    saveMoodboardNodes: (id, nodes) => json<MoodboardNode[]>(`/api/moodboards/${enc(id)}/nodes`, jsonInit("PUT", { nodes })),
    listMoodboardConversations: (id) => json<MoodboardConversation[]>(`/api/moodboards/${enc(id)}/conversations`),
    createMoodboardConversation: (id, title) =>
      json<MoodboardConversation>(`/api/moodboards/${enc(id)}/conversations`, jsonInit("POST", { title })),
    renameMoodboardConversation: (id, conversationId, title) =>
      json<MoodboardConversation>(`/api/moodboards/${enc(id)}/conversations/${enc(conversationId)}`, jsonInit("PATCH", { title })),
    deleteMoodboardConversation: (id, conversationId) =>
      json<{ ok: boolean; conversations: MoodboardConversation[] }>(`/api/moodboards/${enc(id)}/conversations/${enc(conversationId)}`, { method: "DELETE" }),
    listMoodboardMessages: (id, conversationId) =>
      json<MoodboardMessage[]>(
        conversationId ? `/api/moodboards/${enc(id)}/conversations/${enc(conversationId)}/messages` : `/api/moodboards/${enc(id)}/messages`,
      ),
    postMoodboardMessage: (id, content, options) => {
      const { conversationId, ...bodyOptions } = options ?? {};
      return json<{ messages: MoodboardMessage[]; nodes?: MoodboardNode[] }>(
        conversationId ? `/api/moodboards/${enc(id)}/conversations/${enc(conversationId)}/messages` : `/api/moodboards/${enc(id)}/messages`,
        jsonInit("POST", { content, ...bodyOptions }),
      );
    },
    uploadMoodboardAsset: (id, input) =>
      json<MoodboardAsset & { url: string }>(`/api/moodboards/${enc(id)}/assets`, jsonInit("POST", input)),
    generateMoodboardImage: (id, prompt, options) =>
      json<{ asset: MoodboardAsset & { url: string }; nodes: MoodboardNode[]; messages: MoodboardMessage[] }>(
        `/api/moodboards/${enc(id)}/generate-image`,
        jsonInit("POST", { prompt, ...options }),
      ),
    suggestPreferences: () => json<{ suggestion: string; signals: number }>("/api/preferences/suggest", { method: "POST" }),
    startSharingan: (id, url) => json<void>(`/api/sharingan/${enc(id)}/start`, jsonInit("POST", { url })),
    cancelSharingan: (id) => json<void>(`/api/sharingan/${enc(id)}/cancel`, { method: "POST" }),
    sharinganStatus: (id) => json<SharinganStatus>(`/api/sharingan/${enc(id)}/status`),
    continueSharingan: (id) => json<void>(`/api/sharingan/${enc(id)}/continue`, jsonInit("POST")),
    focusSharingan: (id) => json<void>(`/api/sharingan/${enc(id)}/focus`, jsonInit("POST")),
    streamSharinganEvents: async function* (id, signal) {
      yield* consumeSseJson<SharinganStep>(await f(baseUrl + `/api/sharingan/${enc(id)}/events`, initWithDaemonToken({ signal })));
    },
    sharinganShotUrl: (id, relPath) => `${baseUrl}/api/sharingan/${enc(id)}/shot?path=${encodeURIComponent(relPath)}`,
  };
}
