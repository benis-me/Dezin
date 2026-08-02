/** Domains that still use the SQLite store. New Design projects are filesystem-owned. */

export type MessageRole = "user" | "assistant" | "system";

export type ExtensionScope = "capture:write" | "image:analyze";

export interface ExtensionCredential {
  id: string;
  extensionId: string;
  scopes: ExtensionScope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface ExtensionCredentialRecord extends ExtensionCredential {
  tokenHash: string;
}

/** Sharingan is the only Project identity retained in SQLite. */
export interface Project {
  id: string;
  name: string;
  mode: "standard";
  sharingan: true;
  sourceUrl: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface CreateProjectInput {
  name: string;
  mode?: "standard";
  sharingan: true;
  sourceUrl: string;
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

export interface MoodboardConversation {
  id: string;
  boardId: string;
  title: string;
  createdAt: number;
  turns?: number;
}

export interface MoodboardMessage {
  id: string;
  boardId: string;
  conversationId?: string;
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

export type EffectOrigin = "custom";
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

export interface Effect {
  id: string;
  name: string;
  origin: EffectOrigin;
  category: string;
  summary: string;
  parameters: EffectParamDefinition[];
  presets: EffectPreset[];
  code: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateEffectInput {
  name: string;
  category?: string;
  summary?: string;
  parameters?: EffectParamDefinition[];
  presets?: EffectPreset[];
  code?: string;
}

export type UpdateEffectInput = Partial<Omit<CreateEffectInput, "name"> & { name: string }>;

/** Single-row local app settings. */
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
