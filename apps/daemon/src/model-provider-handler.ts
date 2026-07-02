import type { IncomingMessage, ServerResponse } from "node:http";
import type { Settings } from "../../../packages/core/src/index.ts";
import { readJsonBody, sendError, sendJson } from "./http-util.ts";
import type { AppDeps } from "./app.ts";

type ProviderModel = {
  id: string;
  name?: string;
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  "azure-openai": "Azure OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  "openai-compatible": "OpenAI Compatible",
  "vertex-ai": "Vertex AI",
  fal: "Fal",
  wavespeed: "WaveSpeed",
  volcengine: "Volcengine Ark",
  "midjourney-gateway": "Midjourney Gateway",
  mock: "Mock",
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://127.0.0.1:11434/v1",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3",
};

const OPENAI_COMPATIBLE_PROVIDERS = new Set(["openai", "gemini", "openrouter", "ollama", "openai-compatible", "volcengine"]);

function providerLabel(providerId: string): string {
  return PROVIDER_LABELS[providerId] ?? providerId;
}

function selectedProviderId(body: unknown, settings: Settings): string {
  return typeof body === "object" && body !== null && typeof (body as { providerId?: unknown }).providerId === "string"
    ? (body as { providerId: string }).providerId
    : settings.aiProviderId;
}

function providerBaseUrl(settings: Settings, providerId: string): string {
  return (settings.imageApiBaseUrl || settings.apiBaseUrl || DEFAULT_BASE_URLS[providerId] || "").trim();
}

function providerApiKey(settings: Settings): string {
  return (settings.imageApiKey || settings.apiKey).trim();
}

function modelsEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/models") ? path : `${path}/models`;
  return url.toString();
}

function parseModels(body: unknown): ProviderModel[] {
  const source = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? (body as { data: unknown[] }).data
      : Array.isArray((body as { models?: unknown })?.models)
        ? (body as { models: unknown[] }).models
        : [];
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const item of source) {
    const id = typeof item === "string" ? item : typeof (item as { id?: unknown })?.id === "string" ? (item as { id: string }).id : "";
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const rawName =
      typeof (item as { name?: unknown })?.name === "string"
        ? (item as { name: string }).name
        : typeof (item as { display_name?: unknown })?.display_name === "string"
          ? (item as { display_name: string }).display_name
          : "";
    const name = rawName.trim();
    models.push(name && name !== trimmed ? { id: trimmed, name } : { id: trimmed });
  }
  return models;
}

async function fetchJsonModels(url: string, headers: Record<string, string>, providerId: string, fetchImpl: typeof fetch): Promise<ProviderModel[]> {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${providerLabel(providerId)} model list request failed (${res.status})${detail ? `: ${detail.slice(0, 240)}` : ""}`);
  }
  const models = parseModels(await res.json());
  if (models.length === 0) throw new Error(`${providerLabel(providerId)} returned no models.`);
  return models.slice(0, 200);
}

function assertConnectionSettings(settings: Settings, providerId: string): { baseUrl: string; apiKey: string } {
  const baseUrl = providerBaseUrl(settings, providerId);
  if (!baseUrl) throw new Error("Missing base URL.");
  const apiKey = providerApiKey(settings);
  if (!apiKey && providerId !== "ollama") throw new Error("Missing API key.");
  return { baseUrl, apiKey };
}

async function fetchProviderModels(settings: Settings, providerId: string, fetchImpl: typeof fetch): Promise<ProviderModel[]> {
  if (providerId === "mock") return [{ id: "mock-image", name: "Mock Image" }];

  if (providerId === "anthropic") {
    const { baseUrl, apiKey } = assertConnectionSettings(settings, providerId);
    return fetchJsonModels(
      modelsEndpoint(baseUrl),
      { accept: "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      providerId,
      fetchImpl,
    );
  }

  if (!OPENAI_COMPATIBLE_PROVIDERS.has(providerId)) {
    throw new Error(`${providerLabel(providerId)} does not support live model discovery yet.`);
  }

  const { baseUrl, apiKey } = assertConnectionSettings(settings, providerId);

  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return fetchJsonModels(modelsEndpoint(baseUrl), headers, providerId, fetchImpl);
}

export async function handleTestModelProvider(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const body = await readJsonBody(req);
  const settings = deps.store.getSettings();
  const providerId = selectedProviderId(body, settings);
  try {
    const models = await fetchProviderModels(settings, providerId, deps.modelProviderFetch ?? fetch);
    sendJson(res, 200, {
      ok: true,
      message: `Connected to ${providerLabel(providerId)}. Found ${models.length} ${models.length === 1 ? "model" : "models"}.`,
    });
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : "model provider test failed");
  }
}

export async function handleListModelProviderModels(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const body = await readJsonBody(req);
  const settings = deps.store.getSettings();
  const providerId = selectedProviderId(body, settings);
  try {
    const models = await fetchProviderModels(settings, providerId, deps.modelProviderFetch ?? fetch);
    sendJson(res, 200, { models, source: "live" });
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : "model discovery failed");
  }
}
