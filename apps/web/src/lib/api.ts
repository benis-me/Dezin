/**
 * Typed client for the Dezin daemon. fetch is injectable so it can be unit-tested
 * with a mock (no live daemon). Types mirror @dezin/core but are declared locally —
 * the browser bundle must not import the node packages.
 */

export type ProjectMode = "prototype" | "standard";

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
  skillId: string | null;
  designSystemId: string | null;
  mode: ProjectMode;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
  hasArtifact?: boolean;
  /** A screenshot of the generated design, used as the gallery cover. */
  coverUrl?: string | null;
  /** Active generation state for the project card, if a run is still in flight. */
  runStatus?: "pending" | "running" | null;
  /** Absolute on-disk project folder, when served by the local daemon. */
  projectPath?: string;
  /** Whether this project was created by cloning a website via Sharingan. */
  sharingan?: boolean;
  /** The source URL Sharingan cloned this project from, when sharingan is true. */
  sourceUrl?: string;
}

export type WorkspaceNodeKind = "page" | "component" | "resource";
export type WorkspaceEdgeKind = "prototype" | "uses" | "informs" | "derives-from";
export type WorkspaceArtifactKind = "page" | "component";
export type WorkspacePrototypeEdgeStatus = "planned" | "interactive" | "broken";

export interface WorkspaceQualityFinding {
  severity: "P0" | "P1" | "P2";
  id: string;
  message: string;
  fix: string;
  snippet?: string;
  selector?: string;
  screenshotPath?: string;
  screenshotUrl?: string;
  reviewSummary?: string;
  reviewStatus?: "active" | "resolved";
  reviewRound?: number;
  corroborated?: boolean;
}

export interface WorkspaceArtifactQualitySummary {
  state: "passed" | "needs-attention" | "failed" | "unassessed";
  score: number | null;
  findings: WorkspaceQualityFinding[];
}

interface WorkspaceNodeBase {
  id: string;
  workspaceId: string;
  name: string;
}

export interface WorkspaceArtifactNode extends WorkspaceNodeBase {
  kind: WorkspaceArtifactKind;
  artifactId: string;
  resourceId?: never;
  quality?: WorkspaceArtifactQualitySummary;
}

export interface WorkspaceResourceNode extends WorkspaceNodeBase {
  kind: "resource";
  resourceId: string;
  artifactId?: never;
}

export type WorkspaceNode = WorkspaceArtifactNode | WorkspaceResourceNode;

export interface WorkspaceDesignNodeLocator {
  designNodeId: string;
  sourcePath?: string;
  selector?: string;
}

export interface WorkspacePrototypeBinding {
  sourceArtifactId: string;
  sourceRevisionId: string;
  sourceLocator: WorkspaceDesignNodeLocator;
  trigger: "click" | "submit";
  targetArtifactId: string;
  targetState?: string;
  transition?: {
    type: "none" | "fade" | "slide";
    durationMs?: number;
    easing?: string;
  };
}

interface WorkspaceEdgeBase {
  id: string;
  workspaceId: string;
  sourceNodeId: string;
  targetNodeId: string;
}

export type WorkspaceEdge =
  | (WorkspaceEdgeBase & {
      kind: "prototype";
      prototype:
        | { status: "planned"; binding?: never; brokenReason?: never }
        | { status: "interactive"; binding: WorkspacePrototypeBinding; brokenReason?: never }
        | { status: "broken"; binding?: WorkspacePrototypeBinding; brokenReason: string };
    })
  | (WorkspaceEdgeBase & { kind: Exclude<WorkspaceEdgeKind, "prototype">; prototype?: never });

export interface WorkspaceGraph {
  workspaceId: string;
  revision: number;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
}

export interface ProjectWorkspace {
  id: string;
  projectId: string;
  mode: ProjectMode;
  graphRevision: number;
  activeSnapshotId: string;
  activeKernelRevisionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceArtifact {
  id: string;
  workspaceId: string;
  kind: WorkspaceArtifactKind;
  name: string;
  sourceRoot: string;
  legacyWrapped: boolean;
  activeTrackId: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkspaceArtifactPayload = WorkspaceArtifact;

export interface ArtifactTrack {
  id: string;
  artifactId: string;
  name: string;
  headRevisionId: string | null;
  legacyVariantId: string | null;
  createdAt: number;
}

export interface ArtifactRevision {
  id: string;
  workspaceId: string;
  artifactId: string;
  trackId: string;
  sequence: number;
  parentRevisionId: string | null;
  sourceCommitHash: string;
  sourceTreeHash: string;
  artifactRoot: string;
  kernelRevisionId: string;
  renderSpec: Record<string, unknown>;
  quality: Record<string, unknown>;
  contextPackHash: string | null;
  producedByRunId: string | null;
  legacyRunId: string | null;
  createdAt: number;
}

export interface WorkspaceRenderFrameSpec {
  id: string;
  name: string;
  width: number;
  height: number;
  initialState?: string;
  fixture?: Record<string, unknown>;
  background?: string;
}

export interface WorkspaceArtifactQualityProfile {
  requiredFrameIds: string[];
  blockingSeverities: WorkspaceQualityFinding["severity"][];
  requireRuntimeChecks: boolean;
  requireVisualReview: boolean;
}

export interface SharedDesignKernelRevision {
  id: string;
  workspaceId: string;
  sequence: number;
  parentRevisionId: string | null;
  tokens: Record<string, string | number>;
  typography: Record<string, unknown>;
  sharedAssetRevisionIds: string[];
  brief: string;
  terminology: Record<string, string>;
  exclusions: string[];
  responsiveFrames: WorkspaceRenderFrameSpec[];
  qualityProfile: WorkspaceArtifactQualityProfile;
  checksum: string;
  createdAt: number;
}

export interface KernelImpactArtifactRevision {
  artifactId: string;
  revisionId: string;
  pinnedKernelRevisionId: string;
}

export interface KernelImpactAnalysis {
  workspaceId: string;
  baseSnapshotId: string;
  fromKernelRevisionId: string;
  toKernelRevisionId: string;
  affectedArtifactRevisions: KernelImpactArtifactRevision[];
}

export type WorkspaceSnapshotProvenance =
  | { kind: "workspace-created" }
  | { kind: "graph-command"; commandIds: string[] }
  | { kind: "proposal-approval"; proposalId: string; proposalRevision: number; planId?: string }
  | { kind: "artifact-publication"; revisionId: string; runId?: string; planId?: string; taskId?: string }
  | { kind: "resource-publication"; resourceRevisionId: string; runId?: string; planId?: string; taskId?: string }
  | { kind: "kernel-publication"; kernelRevisionId: string; proposalId?: string; impact?: KernelImpactAnalysis }
  | { kind: "propagation"; proposalId: string; batchId: string }
  | { kind: "plan-checkpoint"; proposalId: string; planId: string; checkpointId: string }
  | { kind: "restore"; restoredSnapshotId?: string; restoredRevisionId?: string }
  | { kind: "legacy-migration"; migration: string };

export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  sequence: number;
  parentSnapshotId: string | null;
  graphRevision: number;
  kernelRevisionId: string;
  reason: string;
  provenance: WorkspaceSnapshotProvenance;
  createdByRunId: string | null;
  createdAt: number;
  graph: WorkspaceGraph;
  artifactTracks: Record<string, string>;
  artifactRevisions: Record<string, string | null>;
  resourceRevisions: Record<string, string>;
}

export interface WorkspaceViewport {
  x: number;
  y: number;
  zoom: number;
}

export type WorkspaceLayoutCommand =
  | { type: "add-group"; groupId: string; label: string; bounds: { x: number; y: number; width: number; height: number } }
  | { type: "rename-group"; groupId: string; label: string }
  | { type: "delete-group"; groupId: string; ungroupChildren: true }
  | { type: "set-parent"; objectId: string; parentGroupId: string | null }
  | { type: "move"; objectId: string; x: number; y: number }
  | { type: "resize-group"; groupId: string; width: number; height: number }
  | { type: "set-collapsed"; groupId: string; collapsed: boolean }
  | { type: "set-viewport"; viewport: WorkspaceViewport };

export interface WorkspaceLayoutPatch {
  layoutId?: string;
  graphRevision: number;
  commands: readonly WorkspaceLayoutCommand[];
}

export type WorkspaceLayoutObject =
  | { id: string; kind: "node"; x: number; y: number; parentGroupId: string | null }
  | {
      id: string;
      kind: "group";
      x: number;
      y: number;
      width: number;
      height: number;
      parentGroupId: string | null;
      label: string;
      collapsed: boolean;
    };

export interface WorkspaceLayout {
  workspaceId: string;
  layoutId: string;
  objects: WorkspaceLayoutObject[];
  viewport: WorkspaceViewport;
}

interface NewWorkspaceEdgeBase {
  id: string;
  workspaceId: string;
  sourceNodeId: string;
  targetNodeId: string;
  prototype?: never;
}

export type NewWorkspaceEdge =
  | (NewWorkspaceEdgeBase & { kind: "prototype" })
  | (NewWorkspaceEdgeBase & { kind: Exclude<WorkspaceEdgeKind, "prototype"> });

export type WorkspaceGraphCommand =
  | {
      id: string;
      type: "add-node";
      node:
        | { id: string; kind: WorkspaceArtifactKind; name: string; artifactId: string; createIdentity?: { initialTrackId: string } }
        | {
            id: string;
            kind: "resource";
            name: string;
            resourceId: string;
            createIdentity?: {
              resourceKind: "research" | "moodboard" | "sharingan-capture" | "file" | "asset" | "effect" | "external-reference";
              defaultPinPolicy: "follow-head" | "pin-current" | "manual";
            };
          };
    }
  | { id: string; type: "rename-node"; nodeId: string; name: string }
  | { id: string; type: "archive-node"; nodeId: string }
  | {
      id: string;
      type: "add-edge";
      edge: NewWorkspaceEdge;
    }
  | { id: string; type: "remove-edge"; edgeId: string }
  | { id: string; type: "bind-prototype"; edgeId: string; binding: WorkspacePrototypeBinding };

export interface GraphCommandRequest {
  baseGraphRevision: number;
  expectedSnapshotId: string;
  commands: readonly WorkspaceGraphCommand[];
}

export interface WorkspaceGraphMutationResult {
  graph: WorkspaceGraph;
  snapshot: WorkspaceSnapshot;
}

export interface ReadyProjectWorkspacePayload {
  status: "ready";
  workspace: ProjectWorkspace;
  graph: WorkspaceGraph;
  activeSnapshot: WorkspaceSnapshot;
  activeKernelRevision: SharedDesignKernelRevision;
  artifacts: WorkspaceArtifact[];
  tracks: ArtifactTrack[];
  revisions: ArtifactRevision[];
  snapshots: WorkspaceSnapshot[];
  layout: WorkspaceLayout;
}

export interface UnsupportedProjectWorkspacePayload {
  status: "unsupported";
  code: "workspace_requires_standard_project";
  projectId: string;
  projectMode: "prototype";
}

export type ProjectWorkspacePayload = ReadyProjectWorkspacePayload | UnsupportedProjectWorkspacePayload;

export type SetupPhase = "scaffolding" | "installing" | "ready" | "error";
export interface SetupStatus {
  phase: SetupPhase;
  error?: string;
  logs?: Array<{ at: number; level: "info" | "error"; message: string }>;
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

export interface MessageForkResult {
  conversationId: string;
  variantId: string;
  variants: Variant[];
  assetsRestored?: boolean;
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
  sharingan?: boolean;
  sourceUrl?: string;
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

export interface ResearchSourceItem {
  id?: string;
  kind?: string;
  title?: string;
  url?: string;
  takeaways?: string[];
  assets?: string[];
  /** Visual-track fields (dribbble/behance/etc.) — absent on product sources. */
  platform?: string;
  designer?: string;
  reached?: boolean;
  authority?: string;
}
/** The .research/ deliverables for the Research tab. `exists:false` → hide the tab. */
export interface ResearchDetail {
  exists: boolean;
  /** Full Research evidence/directions validation; partial artifacts may still exist when false. */
  complete?: boolean;
  issues?: Array<{ area: "product" | "visual" | "directions"; code: string; message: string; path?: string }>;
  report?: string;
  sources?: ResearchSourceItem[];
  directions?: Array<{ slug: string; title: string; markdown: string }>;
  assets?: string[];
  /** The candidate direction the user picked at the gate, if any. */
  chosenSlug?: string;
  /** The parallel visual-research track's deliverables, if the visual track ran. */
  visual?: {
    exists: boolean;
    report: string;
    sources: ResearchDetail["sources"];
    assets: string[];
    boardId?: string;
  };
}

export interface RunInput {
  projectId: string;
  brief: string;
  conversationId?: string;
  variantId?: string;
  maxRounds?: number;
  moodboardRefs?: Array<{ id: string; name?: string }>;
  effectRefs?: Array<{ id: string; name?: string }>;
  /** Per-run overrides (fall back to Settings). */
  agentCommand?: string;
  model?: string;
  /** Chosen design direction slug — skips the direction gate; the build uses this direction. */
  directionSlug?: string;
  /** Explicit Research opt-out: `false` skips the Research phase even when it's enabled in Settings (repair runs use this). */
  research?: boolean;
}

export interface PromptOptimizeInput {
  prompt: string;
  agentCommand?: string;
  model?: string;
  mode?: ProjectMode;
  skillId?: string;
  designSystemId?: string;
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
  apiKeyConfigured?: boolean;
  defaultDesignSystemId: string;
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
  visualQaEnabled: boolean;
  autoFixLiveRuntimeErrors: boolean;
  sharinganAffirmed: boolean;
  researchEnabled: boolean;
  researchAgentCommand: string;
  researchModel: string;
  visualQaAgentCommand: string;
  visualQaModel: string;
  autoImproveEnabled: boolean;
  autoImproveMaxRounds: number;
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

/** One step emitted while Sharingan captures a site (navigate, screenshot, login-required, etc.). */
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

/** Generic SSE consumer for JSON-shaped events that aren't a RunEvent (e.g. SharinganStep). */
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
  screenshotPath?: string;
  screenshotUrl?: string;
  reviewSummary?: string;
  reviewStatus?: "active" | "resolved";
  reviewRound?: number;
}

export interface RunFeedback {
  verdict: "up" | "down";
  gap?: string;
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
  feedback?: RunFeedback | null;
  createdAt: number;
  finishedAt: number | null;
}

export type VersionDiffLine = { t: "ctx" | "add" | "del"; text: string };
export interface VersionRestoreResult {
  ok: boolean;
  commitHash?: string;
  runId?: string;
  historyRecorded?: boolean;
  evidenceCopied?: boolean;
  assetsRestored?: boolean;
}
export interface PreviewLeaseInfo {
  leaseId: string;
  url: string;
  expiresAt: number;
}
export interface VersionPreview extends Partial<Pick<PreviewLeaseInfo, "leaseId" | "expiresAt">> {
  url: string;
  mode: ProjectMode;
}

export interface ApiClient {
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  generateProjectTitle(id: string, brief: string): Promise<Project>;
  getSetup(id: string): Promise<SetupStatus>;
  getDevServerUrl(id: string): Promise<{ url: string; leaseId?: string; expiresAt?: number }>;
  releaseDevServer(id: string): Promise<void>;
  renewPreviewLease(leaseId: string): Promise<PreviewLeaseInfo>;
  releasePreviewLease(leaseId: string): Promise<void>;
  captureProjectCover(id: string, options?: { release?: boolean }): Promise<{ captured: boolean; reason?: string }>;
  getProject(id: string): Promise<Project>;
  getWorkspace(projectId: string): Promise<ProjectWorkspacePayload>;
  applyWorkspaceGraphCommands(projectId: string, input: GraphCommandRequest): Promise<WorkspaceGraphMutationResult>;
  saveWorkspaceLayout(projectId: string, input: WorkspaceLayoutPatch): Promise<WorkspaceLayout>;
  getArtifact(projectId: string, artifactId: string): Promise<WorkspaceArtifactPayload>;
  listArtifactTracks(projectId: string, artifactId: string): Promise<ArtifactTrack[]>;
  listArtifactRevisions(projectId: string, artifactId: string): Promise<ArtifactRevision[]>;
  getArtifactRevision(projectId: string, artifactId: string, revisionId: string): Promise<ArtifactRevision>;
  listWorkspaceSnapshots(projectId: string): Promise<WorkspaceSnapshot[]>;
  getWorkspaceSnapshot(projectId: string, snapshotId: string): Promise<WorkspaceSnapshot>;
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
  /** Fork N variations from the current state so the same scoped edit can be generated N ways. */
  fanoutVariants(id: string, count: number): Promise<{ plan: { count: number }; created: string[]; variants: Variant[] }>;
  forkMessage(id: string, messageId: string, name?: string): Promise<MessageForkResult>;
  activateVariant(id: string, vid: string): Promise<Variant[]>;
  renameVariant(id: string, vid: string, name: string): Promise<Variant[]>;
  deleteVariant(id: string, vid: string): Promise<Variant[]>;
  listMessages(projectId: string, cid: string): Promise<Message[]>;
  listDesignSystems(): Promise<DesignSystemCard[]>;
  getDesignSystem(id: string): Promise<DesignSystemDetail>;
  importBrand(input: BrandImportInput): Promise<DesignSystemCard>;
  listEffects(options?: { query?: string }): Promise<EffectCard[]>;
  getEffect(id: string): Promise<EffectDetail>;
  createEffect(input: CreateEffectInput): Promise<EffectDetail>;
  updateEffect(id: string, patch: UpdateEffectInput): Promise<EffectDetail>;
  listSkills(): Promise<SkillCard[]>;
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
  listFiles(id: string): Promise<ProjectFile[]>;
  getFileText(id: string, path: string): Promise<string>;
  listRuns(id: string, options?: { all?: boolean }): Promise<RunSummary[]>;
  versionPreviewUrl(id: string, runId: string): string;
  getVersionPreview(id: string, runId: string): Promise<VersionPreview>;
  getVersionText(id: string, runId: string): Promise<string>;
  getVersionDiff(id: string, runId: string): Promise<VersionDiffLine[]>;
  restoreVersion(id: string, runId: string): Promise<VersionRestoreResult>;
  setVersionCover(id: string, runId: string): Promise<{ captured: boolean }>;
  uploadRef(id: string, name: string, contentBase64: string): Promise<{ name: string; path: string }>;
  /** Parse a Figma .fig file into an agent-ready design summary. */
  parseFig(file: Blob, name: string): Promise<{ name: string; summary: string }>;
  /** Explicitly consume the one-shot pending capture from the browser extension. */
  getCapture(): Promise<{ images: { name: string; base64: string }[]; note: string; source: string }>;
  previewUrl(id: string): string;
  /** URL serving an uploaded reference file (e.g. an image), given its `.refs/<name>` path. */
  refUrl(id: string, refPath: string): string;
  /** The project's research deliverables ({exists:false} when it hasn't been researched). */
  getResearch(id: string): Promise<ResearchDetail>;
  /** URL serving a collected research asset image, given its `assets/<name>` path. */
  researchAssetUrl(id: string, assetPath: string): string;
  /** URL serving a collected VISUAL research asset image, given its `assets/<name>` (or `visual/assets/<name>`) path. */
  researchVisualAssetUrl(id: string, assetPath: string): string;
  variantPreviewUrl(id: string, vid: string): string;
  exportUrl(id: string, scope?: "source" | "full"): string;
  importProject(file: Blob): Promise<Project>;
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
  streamRun(input: RunInput, signal?: AbortSignal): AsyncGenerator<RunEvent>;
  /** Reattach to an in-flight (or finished) run: replays its events, then streams live. */
  reattachRun(runId: string, signal?: AbortSignal, options?: { afterSeq?: number }): AsyncGenerator<RunEvent>;
  /** Explicitly stop a run (the composer "Stop"); works across pages. */
  cancelRun(runId: string): Promise<{ cancelled: boolean }>;
  setRunFeedback(runId: string, feedback: RunFeedback | null): Promise<{ run: RunSummary }>;
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
    yield* consumeSse(await f(baseUrl + "/api/runs", initWithDaemonToken({ ...jsonInit("POST", input), signal })));
  }

  async function* reattachRun(runId: string, signal?: AbortSignal, options: { afterSeq?: number } = {}): AsyncGenerator<RunEvent> {
    const after = typeof options.afterSeq === "number" && Number.isFinite(options.afterSeq) ? `?after=${encodeURIComponent(String(options.afterSeq))}` : "";
    yield* consumeSse(await f(`${baseUrl}/api/runs/${enc(runId)}/stream${after}`, initWithDaemonToken({ signal })));
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
    getSetup: (id) => json<SetupStatus>(`/api/projects/${enc(id)}/setup`),
    getDevServerUrl: (id) => json<{ url: string; leaseId?: string; expiresAt?: number }>(`/api/projects/${enc(id)}/devserver`),
    releaseDevServer: (id) => json<{ released: boolean }>(`/api/projects/${enc(id)}/devserver`, { method: "DELETE" }).then(() => {}),
    renewPreviewLease: (leaseId) => json<PreviewLeaseInfo>(`/api/preview-leases/${enc(leaseId)}`, { method: "PATCH" }),
    releasePreviewLease: (leaseId) => json<{ released: boolean }>(`/api/preview-leases/${enc(leaseId)}`, { method: "DELETE" }).then(() => {}),
    captureProjectCover: (id, options) =>
      json<{ captured: boolean; reason?: string }>(`/api/projects/${enc(id)}/cover/capture${options?.release ? "?release=1" : ""}`, { method: "POST" }),
    getProject: (id) => json<Project>(`/api/projects/${enc(id)}`),
    getWorkspace: (projectId) => json<ProjectWorkspacePayload>(`/api/projects/${enc(projectId)}/workspace`),
    applyWorkspaceGraphCommands: (projectId, input) =>
      json<WorkspaceGraphMutationResult>(`/api/projects/${enc(projectId)}/workspace/graph/commands`, jsonInit("POST", input)),
    saveWorkspaceLayout: (projectId, input) =>
      json<WorkspaceLayout>(`/api/projects/${enc(projectId)}/workspace/layout`, jsonInit("PUT", input)),
    getArtifact: (projectId, artifactId) =>
      json<WorkspaceArtifactPayload>(`/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}`),
    listArtifactTracks: (projectId, artifactId) =>
      json<ArtifactTrack[]>(`/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/tracks`),
    listArtifactRevisions: (projectId, artifactId) =>
      json<ArtifactRevision[]>(`/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/revisions`),
    getArtifactRevision: (projectId, artifactId, revisionId) =>
      json<ArtifactRevision>(`/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/revisions/${enc(revisionId)}`),
    listWorkspaceSnapshots: (projectId) =>
      json<WorkspaceSnapshot[]>(`/api/projects/${enc(projectId)}/workspace/snapshots`),
    getWorkspaceSnapshot: (projectId, snapshotId) =>
      json<WorkspaceSnapshot>(`/api/projects/${enc(projectId)}/workspace/snapshots/${enc(snapshotId)}`),
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
    fanoutVariants: (id, count) =>
      json<{ plan: { count: number }; created: string[]; variants: Variant[] }>(`/api/projects/${enc(id)}/variants/fanout`, jsonInit("POST", { count })),
    forkMessage: (id, messageId, name) =>
      json<MessageForkResult>(`/api/projects/${enc(id)}/messages/${enc(messageId)}/fork`, jsonInit("POST", { name })),
    activateVariant: (id, vid) => json<Variant[]>(`/api/projects/${enc(id)}/variants/${enc(vid)}/activate`, { method: "POST" }),
    renameVariant: (id, vid, name) => json<Variant[]>(`/api/projects/${enc(id)}/variants/${enc(vid)}`, jsonInit("PATCH", { name })),
    deleteVariant: (id, vid) => json<Variant[]>(`/api/projects/${enc(id)}/variants/${enc(vid)}`, { method: "DELETE" }),
    listMessages: (projectId, cid) =>
      json<Message[]>(`/api/projects/${enc(projectId)}/conversations/${enc(cid)}/messages`),
    listDesignSystems: () => json<DesignSystemCard[]>("/api/design-systems"),
    getDesignSystem: (id) => json<DesignSystemDetail>(`/api/design-systems/${enc(id)}`),
    importBrand: (input) => json<DesignSystemCard>("/api/design-systems/import", jsonInit("POST", input)),
    listEffects: (options) => json<EffectCard[]>(`/api/effects${options?.query?.trim() ? `?query=${enc(options.query.trim())}` : ""}`),
    getEffect: (id) => json<EffectDetail>(`/api/effects/${enc(id)}`),
    createEffect: (input) => json<EffectDetail>("/api/effects", jsonInit("POST", input)),
    updateEffect: (id, patch) => json<EffectDetail>(`/api/effects/${enc(id)}`, jsonInit("PATCH", patch)),
    listSkills: () => json<SkillCard[]>("/api/skills"),
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
    listFiles: (id) => json<ProjectFile[]>(`/api/projects/${enc(id)}/files`),
    listRuns: (id, options) => json<RunSummary[]>(`/api/projects/${enc(id)}/runs${options?.all ? "?all=1" : ""}`),
    versionPreviewUrl: (id, runId) => `${baseUrl}/api/projects/${enc(id)}/versions/${enc(runId)}`,
    getVersionPreview: (id, runId) => json<VersionPreview>(`/api/projects/${enc(id)}/versions/${enc(runId)}/preview-url`),
    getVersionText: async (id, runId) => {
      const url = `${baseUrl}/api/projects/${enc(id)}/versions/${enc(runId)}/source`;
      const init = initWithDaemonToken();
      const res = init ? await f(url, init) : await f(url);
      if (!res.ok) throw new ApiError(res.status, await safeText(res));
      return res.text();
    },
    getVersionDiff: (id, runId) => json<VersionDiffLine[]>(`/api/projects/${enc(id)}/versions/${enc(runId)}/diff`),
    restoreVersion: (id, runId) => json<VersionRestoreResult>(`/api/projects/${enc(id)}/versions/${enc(runId)}/restore`, { method: "POST" }),
    setVersionCover: (id, runId) => json<{ captured: boolean }>(`/api/projects/${enc(id)}/versions/${enc(runId)}/cover`, { method: "POST" }),
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
      const url = `${baseUrl}/projects/${enc(id)}/preview/${rel}`;
      const init = initWithDaemonToken();
      const res = init ? await f(url, init) : await f(url);
      if (!res.ok) throw new ApiError(res.status, await safeText(res));
      return res.text();
    },
    previewUrl: (id) => `${baseUrl}/projects/${enc(id)}/preview/`,
    refUrl: (id, refPath) => `${baseUrl}/api/projects/${enc(id)}/refs/${refPath.replace(/^\.refs\//, "").split("/").map(encodeURIComponent).join("/")}`,
    getResearch: (id) => json<ResearchDetail>(`/api/projects/${enc(id)}/research`),
    researchAssetUrl: (id, assetPath) => `${baseUrl}/api/projects/${enc(id)}/research/assets/${assetPath.replace(/^assets\//, "").split("/").map(encodeURIComponent).join("/")}`,
    researchVisualAssetUrl: (id, assetPath) => `${baseUrl}/api/projects/${enc(id)}/research/visual/assets/${assetPath.replace(/^(visual\/)?assets\//, "").split("/").map(encodeURIComponent).join("/")}`,
    variantPreviewUrl: (id, vid) => `${baseUrl}/api/projects/${enc(id)}/variants/${enc(vid)}/preview/`,
    exportUrl: (id, scope = "source") => `${baseUrl}/api/projects/${enc(id)}/export${scope === "full" ? "?scope=full" : ""}`,
    importProject: (file) =>
      json<Project>("/api/projects/import", {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: file,
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
    streamRun,
    reattachRun,
    cancelRun: (runId) => json<{ cancelled: boolean }>(`/api/runs/${enc(runId)}/cancel`, { method: "POST" }),
    setRunFeedback: (runId, feedback) => json<{ run: RunSummary }>(`/api/runs/${enc(runId)}/feedback`, jsonInit("POST", feedback ?? { clear: true })),
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
