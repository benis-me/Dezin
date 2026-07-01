export type ModelCapability = "Stream" | "Tools" | "Vision" | "JSON" | "Reasoning" | "Image" | "Video" | "Local";

export interface ModelPreset {
  id: string;
  name?: string;
  subtitle?: string;
  capabilities: ModelCapability[];
}

export type ProviderConfigFieldKey = "apiKey" | "baseUrl" | "organization";

export interface ProviderConfigField {
  key: ProviderConfigFieldKey;
  label: string;
  placeholder: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  docsUrl?: string;
  keyPlaceholder: string;
  fields: ProviderConfigField[];
  modelHelp?: string;
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
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "sk-proj-...", required: true, secret: true },
      { key: "baseUrl", label: "Base URL", placeholder: "https://api.openai.com/v1", required: true },
      { key: "organization", label: "Organization / Project", placeholder: "optional", help: "Optional OpenAI organization or project routing id." },
    ],
    models: [
      { id: "gpt-4o", name: "GPT-4o", capabilities: ["Stream", "Tools", "Vision", "JSON"] },
      { id: "gpt-5", name: "GPT-5", capabilities: ["Stream", "Tools", "Vision", "JSON", "Reasoning"] },
      { id: "gpt-image-1", name: "GPT Image 1", subtitle: "Image generation", capabilities: ["Image", "Vision"] },
      { id: "gpt-image-2", name: "GPT Image 2", subtitle: "Image generation", capabilities: ["Image", "Vision"] },
    ],
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    protocol: "Azure OpenAI",
    baseUrl: "https://{resource}.openai.azure.com/openai",
    keyPlaceholder: "Azure API key",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "Azure API key", required: true, secret: true },
      { key: "baseUrl", label: "Endpoint", placeholder: "https://{resource}.openai.azure.com/openai/v1/", required: true },
      { key: "organization", label: "API version", placeholder: "optional", help: "Use deployment names as model IDs." },
    ],
    modelHelp: "Use Azure deployment names as model IDs.",
    models: [
      { id: "gpt-4o", name: "GPT-4o deployment", capabilities: ["Stream", "Tools", "Vision", "JSON"] },
      { id: "gpt-image-1", name: "GPT Image deployment", capabilities: ["Image"] },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "Anthropic Native",
    baseUrl: "https://api.anthropic.com/v1",
    keyPlaceholder: "sk-ant-...",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "sk-ant-...", required: true, secret: true },
      { key: "baseUrl", label: "API Address", placeholder: "https://api.anthropic.com/v1", required: true },
    ],
    models: [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", capabilities: ["Stream", "Tools", "Vision"] },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", capabilities: ["Stream", "Tools", "Vision", "Reasoning"] },
    ],
  },
  {
    id: "gemini",
    name: "Gemini",
    protocol: "Gemini / OpenAI",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyPlaceholder: "AIza...",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "AIza...", required: true, secret: true },
      { key: "baseUrl", label: "OpenAI-compatible URL", placeholder: "https://generativelanguage.googleapis.com/v1beta/openai", required: true },
    ],
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", capabilities: ["Stream", "Tools", "Vision", "JSON", "Reasoning"] },
      { id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image", capabilities: ["Image", "Vision"] },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "OpenAI Compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    keyPlaceholder: "sk-or-...",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "sk-or-...", required: true, secret: true },
      { key: "baseUrl", label: "Base URL", placeholder: "https://openrouter.ai/api/v1", required: true },
      { key: "organization", label: "App attribution", placeholder: "optional", help: "Optional site/title metadata for OpenRouter app attribution." },
    ],
    models: [
      { id: "openai/gpt-5", name: "OpenAI GPT-5", capabilities: ["Stream", "Tools", "Vision", "JSON"] },
      { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", capabilities: ["Stream", "Vision", "Reasoning"] },
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    protocol: "Local OpenAI Compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyPlaceholder: "optional",
    fields: [
      { key: "baseUrl", label: "Local Base URL", placeholder: "http://127.0.0.1:11434/v1", required: true },
      { key: "apiKey", label: "API Key", placeholder: "optional", secret: true },
    ],
    models: [
      { id: "llama3.1", name: "Llama 3.1", capabilities: ["Stream", "Tools", "Local"] },
      { id: "llava", name: "LLaVA", capabilities: ["Vision", "Local"] },
    ],
  },
  {
    id: "openai-compatible",
    name: "OpenAI Compatible",
    protocol: "OpenAI Compatible",
    baseUrl: "",
    keyPlaceholder: "API key",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "API key", secret: true },
      { key: "baseUrl", label: "Base URL", placeholder: "https://your-gateway.example/v1", required: true },
    ],
    models: [{ id: "model-id", capabilities: ["Stream", "Tools", "Vision", "JSON"] }],
  },
  {
    id: "vertex-ai",
    name: "Vertex AI",
    protocol: "Vertex AI",
    baseUrl: "https://aiplatform.googleapis.com/v1",
    keyPlaceholder: "OAuth / access token",
    fields: [
      { key: "apiKey", label: "Access Token", placeholder: "OAuth bearer token", required: true, secret: true },
      { key: "baseUrl", label: "Service URL", placeholder: "https://aiplatform.googleapis.com/v1", required: true },
      { key: "organization", label: "Project / Location", placeholder: "project-id:us-central1", required: true },
    ],
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", capabilities: ["Stream", "Vision", "Reasoning"] },
      { id: "imagen-4.0-generate", name: "Imagen 4", capabilities: ["Image"] },
    ],
  },
  {
    id: "fal",
    name: "Fal",
    protocol: "Fal",
    baseUrl: "https://fal.run",
    keyPlaceholder: "fal-...",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "fal-...", required: true, secret: true },
      { key: "baseUrl", label: "Base URL", placeholder: "https://fal.run", required: true },
    ],
    models: [
      { id: "fal-ai/flux-pro", name: "FLUX Pro", capabilities: ["Image"] },
      { id: "fal-ai/veo3", name: "Veo 3", capabilities: ["Video"] },
    ],
  },
  {
    id: "wavespeed",
    name: "WaveSpeed",
    protocol: "WaveSpeed",
    baseUrl: "https://api.wavespeed.ai/api/v3",
    keyPlaceholder: "wavespeed key",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "WaveSpeed API key", required: true, secret: true },
      { key: "baseUrl", label: "Base URL", placeholder: "https://api.wavespeed.ai/api/v3", required: true },
    ],
    models: [
      { id: "wavespeed-ai/flux-kontext-pro", name: "FLUX Kontext Pro", capabilities: ["Image"] },
      { id: "wavespeed-ai/wan-2.1", name: "WAN 2.1", capabilities: ["Video"] },
    ],
  },
  {
    id: "volcengine",
    name: "Volcengine Ark",
    protocol: "Volcengine Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyPlaceholder: "ARK API key",
    fields: [
      { key: "apiKey", label: "ARK API Key", placeholder: "ARK API key", required: true, secret: true },
      { key: "baseUrl", label: "Base URL", placeholder: "https://ark.cn-beijing.volces.com/api/v3", required: true },
    ],
    models: [{ id: "doubao-seedream-3-0-t2i", name: "Seedream 3.0 T2I", capabilities: ["Image"] }],
  },
  {
    id: "midjourney-gateway",
    name: "Midjourney Gateway",
    protocol: "Gateway",
    baseUrl: "",
    keyPlaceholder: "Gateway key",
    fields: [
      { key: "apiKey", label: "Gateway Key", placeholder: "Gateway API key", required: true, secret: true },
      { key: "baseUrl", label: "Gateway URL", placeholder: "https://api.ttapi.io or your gateway", required: true },
    ],
    models: [{ id: "midjourney", name: "Midjourney", capabilities: ["Image"] }],
  },
  {
    id: "mock",
    name: "Mock",
    protocol: "Mock (Offline)",
    baseUrl: "mock://local",
    keyPlaceholder: "not required",
    fields: [{ key: "baseUrl", label: "Local endpoint", placeholder: "mock://local", required: true }],
    models: [{ id: "mock-image", name: "Mock Image", capabilities: ["Image", "Local"] }],
  },
];
