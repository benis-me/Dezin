/**
 * Typed client for the Dezin daemon. fetch is injectable so it can be unit-tested
 * with a mock (no live daemon). Types mirror @dezin/core but are declared locally —
 * the browser bundle must not import the node packages.
 */

export type ProjectMode = "prototype" | "standard";

export interface Project {
  id: string;
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  mode: ProjectMode;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
  hasArtifact?: boolean;
  /** A screenshot of the generated design, used as the gallery cover. */
  coverUrl?: string | null;
}

export type SetupPhase = "scaffolding" | "installing" | "ready" | "error";
export interface SetupStatus {
  phase: SetupPhase;
  error?: string;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  turns?: number;
}

export interface Variant {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  active?: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
}

export interface CreateProjectInput {
  name: string;
  skillId?: string | null;
  designSystemId?: string | null;
  mode?: ProjectMode;
}

export interface RunInput {
  projectId: string;
  brief: string;
  conversationId?: string;
  variantId?: string;
  maxRounds?: number;
  /** Per-run overrides (fall back to Settings). */
  agentCommand?: string;
  model?: string;
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

export interface BrandImportInput {
  name: string;
  accent: string;
  displayFont?: string;
  bodyFont?: string;
  vibe?: string;
  category?: string;
}

export interface SkillCard {
  id: string;
  name: string;
  description: string;
  mode: string;
  triggers: string[];
  designSystem: boolean;
}

export interface Settings {
  agentCommand: string;
  model: string;
  apiBaseUrl: string;
  apiKey: string;
  defaultDesignSystemId: string;
  customInstructions: string;
  imageApiBaseUrl: string;
  imageApiKey: string;
  imageModel: string;
  visualQaEnabled: boolean;
}

export interface AgentInfo {
  id: string;
  command: string;
  available: boolean;
  version?: string;
  models: string[];
}

/** Streamed progress from a rescan: per-agent "probe"/"models" steps, then a final "done". */
export type ScanEvent =
  | { type: "progress"; id: string; label: string; phase: "probe" | "models" }
  | { type: "done"; agents: AgentInfo[] };

export interface Health {
  ok: boolean;
  version: string;
}

/**
 * A server-sent run event. Known `type`s: run-start, turn-start, turn-end, lint,
 * done, run-done, run-error. Extra fields vary by type, so this stays open.
 */
export type RunEvent = { type: string } & Record<string, unknown>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText ?? "";
  }
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/** Parse one SSE block ("data: {...}" possibly multi-line) into a RunEvent. */
export function parseSseBlock(block: string): RunEvent | null {
  const dataLines = block
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => (l.startsWith("data: ") ? l.slice(6) : l.slice(5)));
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n")) as RunEvent;
  } catch {
    return null;
  }
}

export interface ProjectFile {
  path: string;
  size: number;
}

/** One anti-slop finding, as emitted on a run's `lint` SSE event and persisted on runs. */
export interface QualityFinding {
  severity: string;
  id: string;
  message: string;
  fix?: string;
}

export interface RunSummary {
  id: string;
  conversationId?: string;
  variantId?: string | null;
  status: string;
  score: number | null;
  repairRounds: number;
  lintPassed: boolean;
  findings?: QualityFinding[];
  createdAt: number;
  finishedAt: number | null;
}

export interface ApiClient {
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  getSetup(id: string): Promise<SetupStatus>;
  getDevServerUrl(id: string): Promise<{ url: string }>;
  releaseDevServer(id: string): Promise<void>;
  getProject(id: string): Promise<Project>;
  patchProject(id: string, patch: Partial<CreateProjectInput> & { archived?: boolean }): Promise<Project>;
  saveCover(id: string, dataUrl: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  listConversations(id: string): Promise<Conversation[]>;
  createConversation(id: string, title?: string): Promise<Conversation>;
  getConversation(projectId: string, cid: string): Promise<Conversation>;
  renameConversation(projectId: string, cid: string, title: string): Promise<Conversation>;
  deleteConversation(projectId: string, cid: string): Promise<void>;
  listVariants(id: string): Promise<Variant[]>;
  createVariant(id: string, name?: string): Promise<Variant[]>;
  activateVariant(id: string, vid: string): Promise<Variant[]>;
  renameVariant(id: string, vid: string, name: string): Promise<Variant[]>;
  deleteVariant(id: string, vid: string): Promise<Variant[]>;
  listMessages(projectId: string, cid: string): Promise<Message[]>;
  listDesignSystems(): Promise<DesignSystemCard[]>;
  getDesignSystem(id: string): Promise<DesignSystemDetail>;
  importBrand(input: BrandImportInput): Promise<DesignSystemCard>;
  listSkills(): Promise<SkillCard[]>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  listAgents(): Promise<AgentInfo[]>;
  rescanAgents(): Promise<AgentInfo[]>;
  /** Rescan with per-agent progress (SSE). Yields progress events, then a final "done". */
  scanAgentsStream(): AsyncGenerator<ScanEvent>;
  getHealth(): Promise<Health>;
  listFiles(id: string): Promise<ProjectFile[]>;
  getFileText(id: string, path: string): Promise<string>;
  listRuns(id: string, options?: { all?: boolean }): Promise<RunSummary[]>;
  versionPreviewUrl(id: string, runId: string): string;
  getVersionText(id: string, runId: string): Promise<string>;
  restoreVersion(id: string, runId: string): Promise<void>;
  uploadRef(id: string, name: string, contentBase64: string): Promise<{ name: string; path: string }>;
  /** Parse a Figma .fig file into an agent-ready design summary. */
  parseFig(file: Blob, name: string): Promise<{ name: string; summary: string }>;
  /** Explicitly consume the one-shot pending capture from the browser extension. */
  getCapture(): Promise<{ images: { name: string; base64: string }[]; note: string; source: string }>;
  previewUrl(id: string): string;
  /** URL serving an uploaded reference file (e.g. an image), given its `.refs/<name>` path. */
  refUrl(id: string, refPath: string): string;
  variantPreviewUrl(id: string, vid: string): string;
  exportUrl(id: string, scope?: "source" | "full"): string;
  importProject(file: Blob): Promise<Project>;
  streamRun(input: RunInput, signal?: AbortSignal): AsyncGenerator<RunEvent>;
  /** Reattach to an in-flight (or finished) run: replays its events, then streams live. */
  reattachRun(runId: string, signal?: AbortSignal): AsyncGenerator<RunEvent>;
  /** Explicitly stop a run (the composer "Stop"); works across pages. */
  cancelRun(runId: string): Promise<{ cancelled: boolean }>;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const baseUrl = opts.baseUrl ?? "";
  const f: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await f(baseUrl + path, init);
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async function* consumeSse(res: Response): AsyncGenerator<RunEvent> {
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    if (!res.body) {
      // Environments without a streaming body: parse the whole text.
      for (const block of (await res.text()).split("\n\n")) {
        const ev = parseSseBlock(block);
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
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSseBlock(block);
        if (ev) yield ev;
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      const ev = parseSseBlock(tail);
      if (ev) yield ev;
    }
  }

  async function* streamRun(input: RunInput, signal?: AbortSignal): AsyncGenerator<RunEvent> {
    yield* consumeSse(await f(baseUrl + "/api/runs", { ...jsonInit("POST", input), signal }));
  }

  async function* reattachRun(runId: string, signal?: AbortSignal): AsyncGenerator<RunEvent> {
    yield* consumeSse(await f(`${baseUrl}/api/runs/${enc(runId)}/stream`, { signal }));
  }

  async function* scanAgentsStream(): AsyncGenerator<ScanEvent> {
    const res = await f(baseUrl + "/api/agents/rescan-stream", { method: "POST" });
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
    getSetup: (id) => json<SetupStatus>(`/api/projects/${enc(id)}/setup`),
    getDevServerUrl: (id) => json<{ url: string }>(`/api/projects/${enc(id)}/devserver`),
    releaseDevServer: (id) => json<{ released: boolean }>(`/api/projects/${enc(id)}/devserver`, { method: "DELETE" }).then(() => {}),
    getProject: (id) => json<Project>(`/api/projects/${enc(id)}`),
    patchProject: (id, patch) => json<Project>(`/api/projects/${enc(id)}`, jsonInit("PATCH", patch)),
    saveCover: (id, dataUrl) => json<{ ok: boolean }>(`/api/projects/${enc(id)}/cover`, jsonInit("POST", { dataUrl })).then(() => {}),
    deleteProject: (id) => json<void>(`/api/projects/${enc(id)}`, { method: "DELETE" }),
    listConversations: (id) => json<Conversation[]>(`/api/projects/${enc(id)}/conversations`),
    createConversation: (id, title) =>
      json<Conversation>(`/api/projects/${enc(id)}/conversations`, jsonInit("POST", { title })),
    getConversation: (projectId, cid) =>
      json<Conversation>(`/api/projects/${enc(projectId)}/conversations/${enc(cid)}`),
    renameConversation: (projectId, cid, title) =>
      json<Conversation>(`/api/projects/${enc(projectId)}/conversations/${enc(cid)}`, jsonInit("PATCH", { title })),
    deleteConversation: (projectId, cid) =>
      json<{ ok: boolean }>(`/api/projects/${enc(projectId)}/conversations/${enc(cid)}`, { method: "DELETE" }).then(() => {}),
    listVariants: (id) => json<Variant[]>(`/api/projects/${enc(id)}/variants`),
    createVariant: (id, name) => json<Variant[]>(`/api/projects/${enc(id)}/variants`, jsonInit("POST", { name })),
    activateVariant: (id, vid) => json<Variant[]>(`/api/projects/${enc(id)}/variants/${enc(vid)}/activate`, { method: "POST" }),
    renameVariant: (id, vid, name) => json<Variant[]>(`/api/projects/${enc(id)}/variants/${enc(vid)}`, jsonInit("PATCH", { name })),
    deleteVariant: (id, vid) => json<Variant[]>(`/api/projects/${enc(id)}/variants/${enc(vid)}`, { method: "DELETE" }),
    listMessages: (projectId, cid) =>
      json<Message[]>(`/api/projects/${enc(projectId)}/conversations/${enc(cid)}/messages`),
    listDesignSystems: () => json<DesignSystemCard[]>("/api/design-systems"),
    getDesignSystem: (id) => json<DesignSystemDetail>(`/api/design-systems/${enc(id)}`),
    importBrand: (input) => json<DesignSystemCard>("/api/design-systems/import", jsonInit("POST", input)),
    listSkills: () => json<SkillCard[]>("/api/skills"),
    getSettings: () => json<Settings>("/api/settings"),
    updateSettings: (patch) => json<Settings>("/api/settings", jsonInit("PUT", patch)),
    listAgents: () => json<AgentInfo[]>("/api/agents"),
    rescanAgents: () => json<AgentInfo[]>("/api/agents/rescan", { method: "POST" }),
    getHealth: () => json<Health>("/api/health"),
    listFiles: (id) => json<ProjectFile[]>(`/api/projects/${enc(id)}/files`),
    listRuns: (id, options) => json<RunSummary[]>(`/api/projects/${enc(id)}/runs${options?.all ? "?all=1" : ""}`),
    versionPreviewUrl: (id, runId) => `${baseUrl}/api/projects/${enc(id)}/versions/${enc(runId)}`,
    getVersionText: async (id, runId) => {
      const res = await f(`${baseUrl}/api/projects/${enc(id)}/versions/${enc(runId)}`);
      if (!res.ok) throw new ApiError(res.status, await safeText(res));
      return res.text();
    },
    restoreVersion: (id, runId) => json<void>(`/api/projects/${enc(id)}/versions/${enc(runId)}/restore`, { method: "POST" }),
    uploadRef: (id, name, contentBase64) =>
      json<{ name: string; path: string }>(`/api/projects/${enc(id)}/refs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, contentBase64 }),
      }),
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
    getFileText: async (id, path) => {
      const rel = path.split("/").map(enc).join("/");
      const res = await f(`${baseUrl}/projects/${enc(id)}/preview/${rel}`);
      if (!res.ok) throw new ApiError(res.status, await safeText(res));
      return res.text();
    },
    previewUrl: (id) => `${baseUrl}/projects/${enc(id)}/preview/`,
    refUrl: (id, refPath) => `${baseUrl}/api/projects/${enc(id)}/refs/${refPath.replace(/^\.refs\//, "").split("/").map(encodeURIComponent).join("/")}`,
    variantPreviewUrl: (id, vid) => `${baseUrl}/api/projects/${enc(id)}/variants/${enc(vid)}/preview/`,
    exportUrl: (id, scope = "source") => `${baseUrl}/api/projects/${enc(id)}/export${scope === "full" ? "?scope=full" : ""}`,
    importProject: (file) =>
      json<Project>("/api/projects/import", {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: file,
      }),
    streamRun,
    reattachRun,
    cancelRun: (runId) => json<{ cancelled: boolean }>(`/api/runs/${enc(runId)}/cancel`, { method: "POST" }),
  };
}
