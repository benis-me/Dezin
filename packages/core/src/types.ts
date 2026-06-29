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
  /** Design system applied when a project pins none. */
  defaultDesignSystemId: string;
  /** Project-agnostic instructions injected into every generation. */
  customInstructions: string;
  /** Optional image-generation endpoint (OpenAI Images-compatible). BYOK. */
  imageApiBaseUrl: string;
  /** Optional image-generation API key. Stored locally; never leaves the machine. */
  imageApiKey: string;
  /** Optional image model, e.g. "gpt-image-1" / "dall-e-3". */
  imageModel: string;
  /** When enabled, the selected Agent/model reviews a rendered screenshot after prototype runs. */
  visualQaEnabled: boolean;
}
