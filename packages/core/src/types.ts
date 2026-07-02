/**
 * Dezin domain types. The store persists only metadata; the actual design files
 * (HTML artifacts) live on disk under `<dataDir>/projects/<id>/`.
 */

export type MessageRole = "user" | "assistant" | "system";

export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * Build mode. "prototype" = a single self-contained index.html (fast). "standard"
 * = a real frontend project (Vite + React + GSAP) scaffolded from a template,
 * built the way production frontends are, previewed via a dev server.
 */
export type ProjectMode = "prototype" | "standard";

export interface Project {
  id: string;
  name: string;
  /** Active skill id (artifact shape), e.g. "frontend-design". */
  skillId: string | null;
  /** Active design-system id (brand visual language), e.g. "modern-minimal". */
  designSystemId: string | null;
  /** Build mode — prototype (single HTML) or standard (real project). */
  mode: ProjectMode;
  createdAt: number;
  updatedAt: number;
  /** When archived (soft-deleted); null when active. */
  archivedAt: number | null;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  /** Number of user turns (populated by listConversations). */
  turns?: number;
}

/** A design branch within a project — its own artifact + run history. */
export interface Variant {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  /** Whether this is the currently active branch (set by listVariants). */
  active?: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
}

export interface QualityFinding {
  severity: "P0" | "P1" | "P2";
  id: string;
  message: string;
  fix: string;
  snippet?: string;
}

export interface Run {
  id: string;
  projectId: string;
  conversationId: string;
  /** User message that triggered this run, when known. */
  userMessageId: string | null;
  /** Assistant message produced by this run, when known. */
  assistantMessageId: string | null;
  /** Design branch this run belongs to. */
  variantId: string | null;
  /** Git commit that represents this Standard-mode run's filesystem snapshot. */
  commitHash: string | null;
  status: RunStatus;
  /** Number of lint→repair rounds that ran for this generation. */
  repairRounds: number;
  /** Whether the final artifact passed the blocking lint gate. */
  lintPassed: boolean;
  /** 0-100 final quality score after static and visual checks (null until finished). */
  score: number | null;
  /** Final quality findings for this run. Empty means clean or no details persisted. */
  findings: QualityFinding[];
  createdAt: number;
  finishedAt: number | null;
}

export interface Artifact {
  id: string;
  projectId: string;
  /** Path relative to the project dir, e.g. "index.html". */
  path: string;
  lintPassed: boolean;
  createdAt: number;
}

export type MoodboardNodeType = "image" | "image-generator" | "note" | "section" | "video";

export interface Moodboard {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  coverAssetId: string | null;
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
}

export interface MoodboardMessage {
  id: string;
  boardId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
}

export interface CreateMoodboardInput {
  name: string;
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

export interface CreateProjectInput {
  name: string;
  skillId?: string | null;
  designSystemId?: string | null;
  mode?: ProjectMode;
}

/** Single-row app settings (BYOK provider config + defaults). Local-first. */
export interface Settings {
  /** The coding-agent CLI to drive, e.g. "claude". */
  agentCommand: string;
  /** Optional model override passed to the agent. */
  model: string;
  /** Optional API base URL (BYOK / proxy). */
  apiBaseUrl: string;
  /** Optional API key (BYOK). Stored locally; never leaves the machine. */
  apiKey: string;
  /** Redacted API responses set this when a local API key exists. Not persisted as a separate setting. */
  apiKeyConfigured?: boolean;
  /** Design system applied when a project pins none. */
  defaultDesignSystemId: string;
  /** Project-agnostic instructions injected into every generation. */
  customInstructions: string;
  /** Optional image-generation endpoint (OpenAI Images-compatible). BYOK. */
  imageApiBaseUrl: string;
  /** Optional image-generation API key. Stored locally; never leaves the machine. */
  imageApiKey: string;
  /** Redacted API responses set this when a local image API key exists. Not persisted as a separate setting. */
  imageApiKeyConfigured?: boolean;
  /** Optional image model, e.g. "gpt-image-1" / "dall-e-3". */
  imageModel: string;
  /** Optional video-generation endpoint. Reserved for Moodboard video generation. */
  videoApiBaseUrl: string;
  /** Optional video-generation API key. Stored locally; never leaves the machine. */
  videoApiKey: string;
  /** Redacted API responses set this when a local video API key exists. Not persisted as a separate setting. */
  videoApiKeyConfigured?: boolean;
  /** Optional video model, e.g. "sora". */
  videoModel: string;
  /** Selected AI provider in the model platform settings. */
  aiProviderId: string;
  /** Whether the selected AI provider is enabled for generation surfaces. */
  aiProviderEnabled: boolean;
  /** Newline-separated model ids for the selected provider. */
  aiProviderModels: string;
  /** Optional organization/project id for providers that support it. */
  aiProviderOrganization: string;
  /** Serialized per-provider endpoint/model metadata for the Providers settings panel. */
  aiProviderProfiles: string;
  /** When enabled, the selected Agent/model reviews a rendered screenshot after prototype runs. */
  visualQaEnabled: boolean;
}
