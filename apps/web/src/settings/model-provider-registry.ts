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
  imageRuntime?: "openai-compatible" | "azure-openai" | "google" | "fal" | "vertex";
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
    protocol: "OpenAI API",
    baseUrl: "https://api.openai.com/v1",
    imageRuntime: "openai-compatible",
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
    baseUrl: "https://{resource}.openai.azure.com",
    imageRuntime: "azure-openai",
    keyPlaceholder: "Azure API key",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "Azure API key", required: true, secret: true },
      {
        key: "baseUrl",
        label: "Resource endpoint",
        placeholder: "https://{resource}.openai.azure.com",
        required: true,
        help: "Use the Azure resource endpoint from the Azure portal. Deployment names belong in Models below.",
      },
      {
        key: "organization",
        label: "API version",
        placeholder: "2025-04-01-preview",
        help: "Use 2025-04-01-preview for current image deployments unless your resource requires another version.",
      },
    ],
    modelHelp: "Enter Azure deployment names, not model catalog names.",
    models: [
      { id: "gpt-4o", name: "GPT-4o deployment", capabilities: ["Stream", "Tools", "Vision", "JSON"] },
      { id: "gpt-image-1", name: "GPT Image deployment", capabilities: ["Image"] },
      { id: "gpt-image-2", name: "GPT Image 2 deployment", capabilities: ["Image"] },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "Anthropic API",
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
    protocol: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    imageRuntime: "google",
    keyPlaceholder: "AIza...",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "AIza...", required: true, secret: true },
      { key: "baseUrl", label: "API URL", placeholder: "https://generativelanguage.googleapis.com/v1beta", required: true },
    ],
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", capabilities: ["Stream", "Tools", "Vision", "JSON", "Reasoning"] },
      { id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image", capabilities: ["Image", "Vision"] },
    ],
  },
  {
    id: "fal",
    name: "fal",
    protocol: "fal.ai",
    baseUrl: "https://fal.run",
    imageRuntime: "fal",
    docsUrl: "https://fal.ai/docs",
    keyPlaceholder: "fal_...",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "fal_...", required: true, secret: true },
      { key: "baseUrl", label: "Base URL", placeholder: "https://fal.run", required: true },
    ],
    modelHelp: "Enter fal model IDs such as fal-ai/flux/dev.",
    models: [
      { id: "fal-ai/flux/dev", name: "FLUX.1 Dev", capabilities: ["Image", "Vision"] },
      { id: "fal-ai/flux/schnell", name: "FLUX.1 Schnell", capabilities: ["Image"] },
      { id: "fal-ai/flux-pro/v1.1-ultra", name: "FLUX Pro 1.1 Ultra", capabilities: ["Image"] },
      { id: "fal-ai/imagen4/preview", name: "Imagen 4 Preview", capabilities: ["Image"] },
    ],
  },
  {
    id: "vertex",
    name: "Vertex AI",
    protocol: "Google Vertex AI",
    baseUrl: "",
    imageRuntime: "vertex",
    docsUrl: "https://cloud.google.com/vertex-ai/generative-ai/docs",
    keyPlaceholder: "Vertex Express API key",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "Vertex Express API key", required: true, secret: true },
      {
        key: "baseUrl",
        label: "Base URL",
        placeholder: "optional",
        help: "Leave empty for Vertex Express Mode. Advanced deployments may override the API endpoint.",
      },
    ],
    modelHelp: "Enter Vertex image model IDs. Express Mode uses the API key above.",
    models: [
      { id: "imagen-4.0-generate-001", name: "Imagen 4", capabilities: ["Image"] },
      { id: "imagen-4.0-fast-generate-001", name: "Imagen 4 Fast", capabilities: ["Image"] },
      { id: "imagen-4.0-ultra-generate-001", name: "Imagen 4 Ultra", capabilities: ["Image"] },
      { id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image", capabilities: ["Image", "Vision"] },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "OpenAI compatible",
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
    protocol: "Local OpenAI compatible",
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
    protocol: "OpenAI compatible",
    baseUrl: "",
    imageRuntime: "openai-compatible",
    keyPlaceholder: "API key",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "API key", secret: true },
      { key: "baseUrl", label: "Base URL", placeholder: "https://your-gateway.example/v1", required: true },
    ],
    models: [{ id: "model-id", capabilities: ["Stream", "Tools", "Vision", "JSON"] }],
  },
];
