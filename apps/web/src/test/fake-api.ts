import type { ApiClient, Project, Settings } from "../lib/api.ts";
import type {
  DesignCanvas,
  DesignJob,
  DesignThread,
} from "../design-canvas/types.ts";

export type FakeApiOverrides = Partial<ApiClient>;

const NOW = 1_700_000_000_000;

function fakeProject(id: string, patch: Partial<Project> = {}): Project {
  return {
    id,
    name: "Untitled design",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    coverUrl: null,
    ...patch,
  };
}

function emptyCanvas(projectId: string): DesignCanvas {
  return {
    schemaVersion: 2,
    projectId,
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodeOrder: [],
    nodes: [],
    undoDepth: 0,
    redoDepth: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function emptyThread(scope: DesignThread["scope"]): DesignThread {
  return {
    schemaVersion: 2,
    id: scope.type === "main" ? "thread-main" : `thread-node-${scope.nodeId}`,
    scope,
    messages: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fakeJob(id: string, patch: Partial<DesignJob> = {}): DesignJob {
  return {
    schemaVersion: 2,
    id,
    kind: "node-generation",
    runnerId: "fixture",
    model: null,
    status: "queued",
    nodeId: null,
    parentJobId: null,
    contextHash: null,
    canvasRevision: null,
    expectedHeadVersionId: null,
    versionId: null,
    exportId: null,
    error: null,
    cancelRequested: false,
    activity: [],
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
    ...patch,
  };
}

const defaultSettings: Settings = {
  agentCommand: "claude",
  model: "",
  apiBaseUrl: "",
  apiKey: "",
  customInstructions: "",
  imageApiBaseUrl: "",
  imageApiKey: "",
  imageModel: "",
  removeBackgroundModel: "",
  editRegionModel: "",
  extractLayerModel: "",
  videoApiBaseUrl: "",
  videoApiKey: "",
  videoModel: "",
  aiProviderId: "openai",
  aiProviderEnabled: false,
  aiProviderModels: "gpt-image-1",
  aiProviderOrganization: "",
  aiProviderProfiles: "",
  sharinganAffirmed: false,
};

/** Build a current ApiClient fake; tests override only the behavior they exercise. */
export function makeFakeApi(overrides: FakeApiOverrides = {}): ApiClient {
  const api: ApiClient = {
    listProjects: async () => [],
    createProject: async (input) => fakeProject("project-new", {
      name: input.name,
      sharingan: input.sharingan,
      sourceUrl: input.sourceUrl,
    }),
    bootstrapDesignProject: async (input) => {
      const project = fakeProject("project-bootstrap", { name: input.name });
      return {
        project,
        bootstrap: {
          job: {
            schemaVersion: 1,
            id: "bootstrap-fake",
            projectId: project.id,
            requestHash: "0".repeat(64),
            status: "ready",
            completedPhase: "ready",
            mainJobId: input.prompt.trim() ? "job-fake" : null,
            error: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
          reused: false,
        },
      };
    },
    importFigmaProject: async (projectId, input) => {
      return {
        canvas: emptyCanvas(projectId),
        import: {
          manifest: {
            schemaVersion: 1,
            importId: input.idempotencyKey,
            projectId,
            source: {
              normalizedUrl: input.url,
              fileType: "design",
              fileKey: "AbCdEf123456",
              branchKey: null,
              fileName: "Figma import",
              requestedVersionId: null,
              resolvedVersion: "1",
              selectedNodeIds: input.nodeIds ?? [],
              depth: input.depth ?? 4,
            },
            access: { editorType: null, role: null, linkAccess: null },
            credential: { mode: "personal-access-token", subject: "fake" },
            tokenAuthority: "style-values-inferred",
            artifacts: [],
            incomplete: [],
            warnings: [],
            canvasRevision: 0,
            createdAt: NOW,
          },
          reused: false,
        },
      };
    },
    getFigmaCredential: async () => ({ configured: true, source: "local" }),
    setFigmaCredential: async () => ({ configured: true, source: "local" }),
    forgetFigmaCredential: async () => ({ configured: false, source: null }),
    generateProjectTitle: async (id) => fakeProject(id),
    getProject: async (id) => fakeProject(id),
    patchProject: async (id, patch) => fakeProject(id, patch),
    deleteProject: async () => {},
    getDesignCanvas: async (projectId) => emptyCanvas(projectId),
    mutateDesignCanvas: async (projectId, input) => ({ ...emptyCanvas(projectId), revision: input.expectedRevision + 1 }),
    undoDesignCanvas: async (projectId, expectedRevision) => ({ ...emptyCanvas(projectId), revision: expectedRevision + 1 }),
    redoDesignCanvas: async (projectId, expectedRevision) => ({ ...emptyCanvas(projectId), revision: expectedRevision + 1 }),
    listDesignCanvasAssets: async () => [],
    createDesignCanvasAsset: async (_projectId, input) => ({
      id: "asset-fake",
      name: input.name,
      mimeType: input.mimeType,
      checksum: "0".repeat(64),
      bytes: 0,
      createdAt: NOW,
    }),
    uploadDesignCanvasVideo: async (_projectId, file) => ({
      uploadedFileId: ".refs/design-upload-fake",
      bytes: file.size,
    }),
    importDesignCanvasAssets: async (projectId, input) => ({
      ...emptyCanvas(projectId),
      revision: input.expectedRevision + 1,
    }),
    designCanvasAssetUrl: (projectId, assetId) =>
      `/api/projects/${projectId}/design-canvas/assets/${assetId}/content`,
    listDesignNodeVersions: async () => [],
    designNodeVersionPreviewUrl: (projectId, nodeId, versionId) =>
      `/api/projects/${projectId}/design-canvas/nodes/${nodeId}/versions/${versionId}/preview/`,
    downloadDesignNodeVersionHtml: async () => new Blob(["<!doctype html>"], { type: "text/html" }),
    getDesignThread: async (_projectId, scope) => emptyThread(scope),
    submitDesignAgentTurn: async (projectId, scope, input) => ({
      thread: {
        ...emptyThread(scope),
        messages: [{
          id: "message-user",
          role: "user",
          content: input.message,
          jobId: "job-fake",
          createdAt: NOW,
        }],
      },
      job: fakeJob("job-fake", {
        kind: scope.type === "main" ? "main-agent" : "node-generation",
        nodeId: scope.type === "node" ? scope.nodeId : null,
      }),
      canvas: emptyCanvas(projectId),
    }),
    listDesignJobs: async () => [],
    // eslint-disable-next-line require-yield
    streamDesignCanvasInvalidations: async function* () {},
    cancelDesignJob: async (_projectId, jobId) => fakeJob(jobId, {
      status: "cancelled",
      finishedAt: NOW,
    }),
    retryDesignJob: async (projectId, jobId) => ({
      retryOfJobId: jobId,
      thread: emptyThread({ type: "main" }),
      job: fakeJob(`retry-${jobId}`),
      canvas: emptyCanvas(projectId),
    }),
    startDesignImplementationExport: async () => ({
      exportId: "export-fake",
      job: fakeJob("job-export", { kind: "implementation-export", exportId: "export-fake" }),
    }),

    listDesignSystems: async () => [],
    getDesignSystem: async (id) => ({ id, name: id, category: "design", summary: "", designMd: "", tokensCss: "" }),
    importBrand: async () => ({ id: "brand-import", name: "Imported brand", category: "design", summary: "" }),
    listEffects: async () => [],
    getEffect: async (id) => ({ id, name: id, origin: "built-in", category: "visual", summary: "", parameters: [], presets: [], code: "" }),
    createEffect: async (input) => ({ id: "effect-new", ...input, origin: "custom", category: "visual", summary: "", parameters: [], presets: [], code: "" }),
    updateEffect: async (id, patch) => ({ id, name: patch.name ?? id, origin: "custom", category: patch.category ?? "visual", summary: patch.summary ?? "", parameters: patch.parameters ?? [], presets: patch.presets ?? [], code: patch.code ?? "" }),

    createExtensionPairingCode: async () => ({ code: "123456", expiresAt: NOW + 60_000 }),
    listExtensionCredentials: async () => [],
    revokeExtensionCredential: async () => {},
    getSettings: async () => defaultSettings,
    updateSettings: async (patch) => ({ ...defaultSettings, ...patch }),
    testModelProvider: async () => ({ ok: true, message: "Connected." }),
    listModelProviderModels: async () => ({ models: [] }),
    listAgents: async () => [],
    rescanAgents: async () => [],
    async *scanAgentsStream() {
      yield { type: "done", agents: [] };
    },
    getHealth: async () => ({ ok: true, version: "0.0.0" }),
    optimizePrompt: async (input) => ({ prompt: input.prompt }),

    parseFig: async (_file, name) => ({ name, summary: "" }),
    getCapture: async () => ({ images: [], note: "", source: "" }),

    listMoodboards: async () => [],
    createMoodboard: async (input) => ({ id: "moodboard-new", name: input.name, coverAssetId: null, createdAt: NOW, updatedAt: NOW }),
    startMoodboard: async (input) => ({ id: "moodboard-new", name: input.name, coverAssetId: null, createdAt: NOW, updatedAt: NOW }),
    getMoodboard: async (id) => ({
      id,
      name: "Moodboard",
      coverAssetId: null,
      createdAt: NOW,
      updatedAt: NOW,
      nodes: [],
      assets: [],
      messages: [],
    }),
    patchMoodboard: async (id, patch) => ({ id, name: patch.name ?? "Moodboard", coverAssetId: patch.coverAssetId ?? null, createdAt: NOW, updatedAt: NOW }),
    deleteMoodboard: async () => {},
    listMoodboardNodes: async () => [],
    saveMoodboardNodes: async (id, nodes) => nodes.map((node, index) => ({
      id: node.id ?? `node-${index}`,
      boardId: id,
      type: node.type,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rotation: node.rotation ?? 0,
      zIndex: node.zIndex ?? index,
      data: node.data ?? {},
      createdAt: NOW,
      updatedAt: NOW,
    })),
    listMoodboardConversations: async () => [],
    createMoodboardConversation: async (id, title) => ({ id: "conversation-new", boardId: id, title: title ?? "New conversation", createdAt: NOW }),
    renameMoodboardConversation: async (id, conversationId, title) => ({ id: conversationId, boardId: id, title, createdAt: NOW }),
    deleteMoodboardConversation: async () => ({ ok: true, conversations: [] }),
    listMoodboardMessages: async () => [],
    postMoodboardMessage: async () => ({ messages: [] }),
    uploadMoodboardAsset: async (_id, input) => ({
      id: "asset-moodboard",
      boardId: _id,
      kind: input.mimeType?.startsWith("video/") ? "video" : "image",
      fileName: input.name,
      mimeType: input.mimeType ?? "application/octet-stream",
      width: input.width ?? null,
      height: input.height ?? null,
      source: "upload",
      createdAt: NOW,
      url: "/asset-moodboard",
    }),
    generateMoodboardImage: async () => ({
      asset: {
        id: "asset-generated",
        boardId: "moodboard",
        kind: "image",
        fileName: "generated.png",
        mimeType: "image/png",
        width: null,
        height: null,
        source: "generated",
        createdAt: NOW,
        url: "/asset-generated",
      },
      nodes: [],
      messages: [],
    }),

    suggestPreferences: async () => ({ suggestion: "", signals: 0 }),
    startSharingan: async () => {},
    cancelSharingan: async () => {},
    sharinganStatus: async () => ({ phase: "idle", steps: 0, pages: [] }),
    continueSharingan: async () => {},
    focusSharingan: async () => {},
    // eslint-disable-next-line require-yield
    streamSharinganEvents: async function* () {},
    sharinganShotUrl: (id, relPath) => `/shot/${id}/${relPath}`,
  };
  return { ...api, ...overrides };
}
