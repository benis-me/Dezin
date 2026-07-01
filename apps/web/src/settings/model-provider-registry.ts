export type ModelCapability = "Stream" | "Tools" | "Vision" | "JSON" | "Reasoning" | "Image" | "Video" | "Local";

export interface ModelPreset {
  id: string;
  subtitle?: string;
  capabilities: ModelCapability[];
}

export interface ProviderPreset {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  docsUrl?: string;
  keyPlaceholder: string;
  models: ModelPreset[];
}

export const MODEL_PROVIDERS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    protocol: "OpenAI Responses",
    baseUrl: "https://api.openai.com/v1",
    docsUrl: "https://platform.openai.com/docs",
    keyPlaceholder: "sk-proj-...",
    models: [
      { id: "gpt-4o", capabilities: ["Stream", "Tools", "Vision", "JSON"] },
      { id: "gpt-5", capabilities: ["Stream", "Tools", "Vision", "JSON", "Reasoning"] },
      { id: "gpt-image-1", subtitle: "Image generation", capabilities: ["Image", "Vision"] },
      { id: "gpt-image-2", subtitle: "Image generation", capabilities: ["Image", "Vision"] },
    ],
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    protocol: "Azure OpenAI",
    baseUrl: "https://{resource}.openai.azure.com/openai",
    keyPlaceholder: "Azure API key",
    models: [
      { id: "gpt-4o", capabilities: ["Stream", "Tools", "Vision", "JSON"] },
      { id: "gpt-image-1", capabilities: ["Image"] },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "Anthropic Native",
    baseUrl: "https://api.anthropic.com/v1",
    keyPlaceholder: "sk-ant-...",
    models: [
      { id: "claude-sonnet-4-6", capabilities: ["Stream", "Tools", "Vision"] },
      { id: "claude-opus-4-8", capabilities: ["Stream", "Tools", "Vision", "Reasoning"] },
    ],
  },
  {
    id: "gemini",
    name: "Gemini",
    protocol: "Gemini / OpenAI",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyPlaceholder: "AIza...",
    models: [
      { id: "gemini-2.5-pro", capabilities: ["Stream", "Tools", "Vision", "JSON", "Reasoning"] },
      { id: "gemini-2.5-flash-image", capabilities: ["Image", "Vision"] },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "OpenAI Compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    keyPlaceholder: "sk-or-...",
    models: [
      { id: "openai/gpt-5", capabilities: ["Stream", "Tools", "Vision", "JSON"] },
      { id: "google/gemini-2.5-pro", capabilities: ["Stream", "Vision", "Reasoning"] },
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    protocol: "Local OpenAI Compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyPlaceholder: "optional",
    models: [
      { id: "llama3.1", capabilities: ["Stream", "Tools", "Local"] },
      { id: "llava", capabilities: ["Vision", "Local"] },
    ],
  },
  {
    id: "openai-compatible",
    name: "OpenAI Compatible",
    protocol: "OpenAI Compatible",
    baseUrl: "",
    keyPlaceholder: "API key",
    models: [{ id: "model-id", capabilities: ["Stream", "Tools", "Vision", "JSON"] }],
  },
  {
    id: "vertex-ai",
    name: "Vertex AI",
    protocol: "Vertex AI",
    baseUrl: "https://aiplatform.googleapis.com/v1",
    keyPlaceholder: "OAuth / access token",
    models: [
      { id: "gemini-2.5-pro", capabilities: ["Stream", "Vision", "Reasoning"] },
      { id: "imagen-4.0-generate", capabilities: ["Image"] },
    ],
  },
  {
    id: "fal",
    name: "Fal",
    protocol: "Fal",
    baseUrl: "https://fal.run",
    keyPlaceholder: "fal-...",
    models: [
      { id: "fal-ai/flux-pro", capabilities: ["Image"] },
      { id: "fal-ai/veo3", capabilities: ["Video"] },
    ],
  },
  {
    id: "wavespeed",
    name: "WaveSpeed",
    protocol: "WaveSpeed",
    baseUrl: "https://api.wavespeed.ai/api/v3",
    keyPlaceholder: "wavespeed key",
    models: [
      { id: "wavespeed-ai/flux-kontext-pro", capabilities: ["Image"] },
      { id: "wavespeed-ai/wan-2.1", capabilities: ["Video"] },
    ],
  },
  {
    id: "volcengine",
    name: "Volcengine Ark",
    protocol: "Volcengine Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyPlaceholder: "ARK API key",
    models: [{ id: "doubao-seedream-3-0-t2i", capabilities: ["Image"] }],
  },
  {
    id: "midjourney-gateway",
    name: "Midjourney Gateway",
    protocol: "Gateway",
    baseUrl: "",
    keyPlaceholder: "Gateway key",
    models: [{ id: "midjourney", capabilities: ["Image"] }],
  },
  {
    id: "mock",
    name: "Mock",
    protocol: "Mock (Offline)",
    baseUrl: "mock://local",
    keyPlaceholder: "not required",
    models: [{ id: "mock-image", capabilities: ["Image", "Local"] }],
  },
];
