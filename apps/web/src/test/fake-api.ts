import type { ApiClient, Conversation, ConversationScope } from "../lib/api.ts";

const FAKE_BRIDGE_NONCE = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

/** Build a fake ApiClient for tests; override only the methods a test needs. */
type FakeConversation = Omit<Conversation, "scope"> & { scope?: ConversationScope };
type FakeApiOverrides = Omit<Partial<ApiClient>, "listConversations" | "createConversation" | "getConversation" | "renameConversation"> & {
  listConversations?: (id: string, scope?: ConversationScope) => Promise<FakeConversation[]>;
  createConversation?: (id: string, title?: string, scope?: ConversationScope) => Promise<FakeConversation>;
  getConversation?: (projectId: string, conversationId: string) => Promise<FakeConversation>;
  renameConversation?: (projectId: string, conversationId: string, title: string) => Promise<FakeConversation>;
};

function normalizeFakeConversation(conversation: FakeConversation): Conversation {
  return { ...conversation, scope: conversation.scope ?? { type: "workspace", id: conversation.projectId } };
}

export function makeFakeApi(over: FakeApiOverrides = {}): ApiClient {
  const {
    listConversations: listConversationsOverride,
    createConversation: createConversationOverride,
    getConversation: getConversationOverride,
    renameConversation: renameConversationOverride,
    ...apiOverrides
  } = over;
  const notImpl = () => {
    throw new Error("not implemented in fake");
  };
  return {
    listProjects: async () => [],
    createProject: notImpl as ApiClient["createProject"],
    generateProjectTitle: async (id: string) => (apiOverrides.getProject ? apiOverrides.getProject(id) : notImpl()),
    getSetup: async () => ({ phase: "ready" as const }),
    getDevServerUrl: async (id: string) => ({
      leaseId: `lease-${id}`,
      url: `http://127.0.0.1:5300/${id}#dezin-bridge=${FAKE_BRIDGE_NONCE}`,
      bridgeNonce: FAKE_BRIDGE_NONCE,
      expiresAt: Date.now() + 60_000,
    }),
    releaseDevServer: async () => {},
    renewPreviewLease: async (leaseId: string) => ({
      leaseId,
      url: `http://127.0.0.1:5300/#dezin-bridge=${FAKE_BRIDGE_NONCE}`,
      bridgeNonce: FAKE_BRIDGE_NONCE,
      expiresAt: Date.now() + 60_000,
    }),
    releasePreviewLease: async () => {},
    resolvePreviewTarget: async (projectId, target) => {
      const artifactId = target.kind === "artifact-current"
        ? target.artifactId
        : target.kind === "workspace-flow"
          ? target.startArtifactId
          : "artifact-test";
      const revisionId = target.kind === "artifact-revision" || target.kind === "component-state"
        ? target.revisionId
        : "revision-test";
      return {
        version: 1,
        targetKey: `${target.kind}:${revisionId}`,
        requestedKind: target.kind,
        projectId,
        workspaceId: `workspace-${projectId}`,
        artifactId,
        artifactKind: "page",
        revisionId,
        trackId: target.kind === "artifact-current" ? target.trackId ?? "track-test" : "track-test",
        snapshotId: target.kind === "workspace-flow" ? target.snapshotId : null,
        sourceCommitHash: `commit-${revisionId}`,
        sourceTreeHash: `tree-${revisionId}`,
        dependencyLockHash: `dependencies-${revisionId}`,
        assemblyHash: `assembly-${revisionId}`,
        artifactRoot: artifactId === "artifact-test" ? "." : `artifacts/${artifactId}`,
        renderSpec: {},
        variantKey: target.kind === "component-state" ? target.variantKey : null,
        stateKey: target.kind === "component-state" ? target.stateKey : null,
        runId: target.kind === "run-candidate" ? target.runId : null,
      };
    },
    acquirePreviewTargetLease: async (_projectId, resolved) => ({
      leaseId: `lease-${resolved.revisionId}`,
      url: `http://127.0.0.1:5300/${resolved.revisionId}#dezin-bridge=${FAKE_BRIDGE_NONCE}`,
      bridgeNonce: FAKE_BRIDGE_NONCE,
      expiresAt: Date.now() + 60_000,
      resolved,
    }),
    renewPreviewTargetLease: async (leaseId: string) => ({
      leaseId,
      url: `http://127.0.0.1:5300/#dezin-bridge=${FAKE_BRIDGE_NONCE}`,
      bridgeNonce: FAKE_BRIDGE_NONCE,
      expiresAt: Date.now() + 60_000,
    }),
    releasePreviewTargetLease: async () => {},
    captureProjectCover: async () => ({ captured: false }),
    getProject: notImpl as ApiClient["getProject"],
    getWorkspace: async (projectId) => ({
      status: "unsupported",
      code: "workspace_requires_standard_project",
      projectId,
      projectMode: "prototype",
    }),
    listWorkspaceProposals: async () => [],
    getWorkspaceProposal: notImpl as ApiClient["getWorkspaceProposal"],
    createWorkspaceProposal: notImpl as ApiClient["createWorkspaceProposal"],
    updateWorkspaceProposal: notImpl as ApiClient["updateWorkspaceProposal"],
    approveWorkspaceProposal: notImpl as ApiClient["approveWorkspaceProposal"],
    rejectWorkspaceProposal: notImpl as ApiClient["rejectWorkspaceProposal"],
    applyWorkspaceGraphCommands: notImpl as ApiClient["applyWorkspaceGraphCommands"],
    saveWorkspaceLayout: notImpl as ApiClient["saveWorkspaceLayout"],
    listResources: async () => [],
    createResource: notImpl as ApiClient["createResource"],
    getResource: notImpl as ApiClient["getResource"],
    updateResource: notImpl as ApiClient["updateResource"],
    listResourceRevisions: async () => [],
    createResourceRevision: notImpl as ApiClient["createResourceRevision"],
    publishResourceRevision: notImpl as ApiClient["publishResourceRevision"],
    getArtifact: notImpl as ApiClient["getArtifact"],
    listArtifactTracks: async () => [],
    listArtifactRevisions: async () => [],
    getArtifactRevision: notImpl as ApiClient["getArtifactRevision"],
    applyArtifactMutation: notImpl as ApiClient["applyArtifactMutation"],
    getArtifactThumbnail: async () => new Blob(),
    artifactThumbnailUrl: (projectId, artifactId, revisionId) =>
      `/api/projects/${projectId}/artifacts/${artifactId}/revisions/${revisionId}/thumbnail`,
    listWorkspaceSnapshots: async () => [],
    getWorkspaceSnapshot: notImpl as ApiClient["getWorkspaceSnapshot"],
    patchProject: notImpl as ApiClient["patchProject"],
    saveCover: async () => {},
    deleteProject: notImpl as ApiClient["deleteProject"],
    listConversations: async (id, scope) =>
      (await (listConversationsOverride
        ? scope === undefined
          ? listConversationsOverride(id)
          : listConversationsOverride(id, scope)
        : Promise.resolve([]))).map(normalizeFakeConversation),
    createConversation: async (id, title, scope) =>
      normalizeFakeConversation(createConversationOverride
        ? await (scope !== undefined
          ? createConversationOverride(id, title, scope)
          : title !== undefined
            ? createConversationOverride(id, title)
            : createConversationOverride(id))
        : notImpl()),
    getConversation: async (projectId, conversationId) =>
      normalizeFakeConversation(getConversationOverride ? await getConversationOverride(projectId, conversationId) : notImpl()),
    renameConversation: async (projectId, conversationId, title) =>
      normalizeFakeConversation(renameConversationOverride ? await renameConversationOverride(projectId, conversationId, title) : notImpl()),
    deleteConversation: async () => {},
    listVariants: async () => [],
    createVariant: async () => [],
    fanoutVariants: async () => ({ plan: { count: 3 }, created: [], variants: [] }),
    forkMessage: async () => ({ conversationId: "c1", variantId: "v1", variants: [] }),
    activateVariant: async () => [],
    renameVariant: async () => [],
    deleteVariant: async () => [],
    listMessages: async () => [],
    listDesignSystems: async () => [],
    getDesignSystem: notImpl as ApiClient["getDesignSystem"],
    importBrand: notImpl as ApiClient["importBrand"],
    listEffects: async () => [],
    getEffect: notImpl as ApiClient["getEffect"],
    createEffect: notImpl as ApiClient["createEffect"],
    updateEffect: notImpl as ApiClient["updateEffect"],
    listSkills: async () => [],
    createExtensionPairingCode: notImpl as ApiClient["createExtensionPairingCode"],
    listExtensionCredentials: async () => [],
    revokeExtensionCredential: async () => {},
    getSettings: async () => ({
      agentCommand: "claude",
      model: "",
      apiBaseUrl: "",
      apiKey: "",
      defaultDesignSystemId: "modern-minimal",
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
      visualQaEnabled: false,
      autoFixLiveRuntimeErrors: false,
      sharinganAffirmed: false,
      researchEnabled: false,
      researchAgentCommand: "",
      researchModel: "",
      visualQaAgentCommand: "",
      visualQaModel: "",
      autoImproveEnabled: true,
      autoImproveMaxRounds: 8,
    }),
    updateSettings: notImpl as ApiClient["updateSettings"],
    testModelProvider: async () => ({ ok: true, message: "Connected." }),
    listModelProviderModels: async () => ({ models: [] }),
    listAgents: async () => [],
    rescanAgents: async () => [],
    async *scanAgentsStream() {
      yield { type: "done" as const, agents: await (apiOverrides.rescanAgents ?? (async () => []))() };
    },
    getHealth: async () => ({ ok: true, version: "0.0.0" }),
    optimizePrompt: async (input) => ({ prompt: input.prompt }),
    listFiles: async () => [],
    getFileText: async () => "",
    listRuns: async () => [],
    versionPreviewUrl: (id: string, runId: string) => `/api/projects/${id}/versions/${runId}`,
    getVersionPreview: async (id: string, runId: string) => ({
      url: `/api/projects/${id}/versions/${runId}#dezin-bridge=${FAKE_BRIDGE_NONCE}`,
      bridgeNonce: FAKE_BRIDGE_NONCE,
      mode: "prototype" as const,
    }),
    getVersionText: async () => "",
    getVersionDiff: async () => [],
    restoreVersion: notImpl as ApiClient["restoreVersion"],
    setVersionCover: async () => ({ captured: true }),
    uploadRef: async (_id: string, name: string) => ({ name, path: `.refs/${name}` }),
    parseFig: async (_file, name: string) => ({ name, summary: "" }),
    getCapture: async () => ({ images: [], note: "", source: "" }),
    previewUrl: (id: string) => `/projects/${id}/preview/`,
    refUrl: (id: string, refPath: string) => `/api/projects/${id}/refs/${refPath.replace(/^\.refs\//, "")}`,
    getResearch: async () => ({ exists: false }),
    researchAssetUrl: (id: string, assetPath: string) => `/api/projects/${id}/research/assets/${assetPath.replace(/^assets\//, "")}`,
    researchVisualAssetUrl: (_id: string, p: string) => `/v/${p}`,
    variantPreviewUrl: (id: string, vid: string) => `/api/projects/${id}/variants/${vid}/preview/`,
    exportUrl: (id: string, scope = "source") => `/api/projects/${id}/export${scope === "full" ? "?scope=full" : ""}`,
    importProject: notImpl as ApiClient["importProject"],
    listMoodboards: async () => [],
    createMoodboard: notImpl as ApiClient["createMoodboard"],
    startMoodboard: notImpl as ApiClient["startMoodboard"],
    getMoodboard: notImpl as ApiClient["getMoodboard"],
    patchMoodboard: notImpl as ApiClient["patchMoodboard"],
    deleteMoodboard: notImpl as ApiClient["deleteMoodboard"],
    listMoodboardNodes: async () => [],
    saveMoodboardNodes: async (_id, nodes) =>
      nodes.map((node, index) => ({
        id: node.id ?? `n${index}`,
        boardId: _id,
        type: node.type,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation ?? 0,
        zIndex: node.zIndex ?? index,
        data: node.data ?? {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })),
    listMoodboardConversations: async () => [],
    createMoodboardConversation: notImpl as ApiClient["createMoodboardConversation"],
    renameMoodboardConversation: notImpl as ApiClient["renameMoodboardConversation"],
    deleteMoodboardConversation: notImpl as ApiClient["deleteMoodboardConversation"],
    listMoodboardMessages: async () => [],
    postMoodboardMessage: async () => ({ messages: [] }),
    uploadMoodboardAsset: notImpl as ApiClient["uploadMoodboardAsset"],
    generateMoodboardImage: notImpl as ApiClient["generateMoodboardImage"],
    // eslint-disable-next-line require-yield
    streamRun: async function* () {},
    // eslint-disable-next-line require-yield
    reattachRun: async function* () {},
    cancelRun: async () => ({ cancelled: true }),
    setRunFeedback: async (runId, feedback) => ({
      run: { id: runId, status: "succeeded", score: 100, repairRounds: 0, lintPassed: true, feedback: feedback ?? null, createdAt: 0, finishedAt: 0 },
    }),
    suggestPreferences: async () => ({ suggestion: "", signals: 0 }),
    startSharingan: async () => {},
    cancelSharingan: async () => {},
    sharinganStatus: async () => ({ phase: "idle", steps: 0, pages: [] }),
    continueSharingan: async () => {},
    focusSharingan: async () => {},
    // eslint-disable-next-line require-yield
    streamSharinganEvents: async function* () {},
    sharinganShotUrl: (id: string, relPath: string) => `/shot/${id}/${relPath}`,
    ...apiOverrides,
  };
}
