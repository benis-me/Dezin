import type { IncomingMessage, ServerResponse } from "node:http";
import type { Settings } from "../../../packages/core/src/index.ts";
import { readJsonBody, sendError, sendJson } from "./http-util.ts";
import type { AppDeps } from "./app.ts";

type ProviderModel = {
  id: string;
  name?: string;
};

type ConnectionResult = {
  modelsFound?: number;
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
  "azure-openai": "https://{resource}.openai.azure.com/openai/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://127.0.0.1:11434/v1",
  "vertex-ai": "https://aiplatform.googleapis.com/v1",
  fal: "https://fal.run",
  wavespeed: "https://api.wavespeed.ai/api/v3",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3",
};

const OPENAI_COMPATIBLE_PROVIDERS = new Set(["openai", "openrouter", "ollama", "openai-compatible", "volcengine"]);

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

function appendPath(baseUrl: string, path: string): string {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${path.replace(/^\/+/, "")}`;
  return url.toString();
}

function geminiModelsEndpoint(baseUrl: string, apiKey: string): string {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/openai$/, "");
  url.pathname = path.endsWith("/models") ? path : `${path}/models`;
  url.search = "";
  url.searchParams.set("key", apiKey);
  return url.toString();
}

function azureModelsEndpoint(baseUrl: string, settings: Settings): string {
  const url = new URL(modelsEndpoint(baseUrl));
  const apiVersion = settings.aiProviderOrganization.trim();
  if (apiVersion && !url.pathname.includes("/v1/")) url.searchParams.set("api-version", apiVersion);
  return url.toString();
}

function vertexModelsEndpoint(baseUrl: string, settings: Settings): string {
  const [project, location] = settings.aiProviderOrganization
    .split(/[:/]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!project || !location) throw new Error("Missing Vertex AI project/location. Use project-id:location.");
  return appendPath(
    baseUrl,
    `projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models`,
  );
}

function firstConfiguredModelId(settings: Settings, fallback: string): string {
  for (const line of settings.aiProviderModels.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { id?: unknown };
      if (typeof parsed.id === "string" && parsed.id.trim()) return parsed.id.trim();
    } catch {
      return trimmed;
    }
  }
  return fallback;
}

function encodedModelPath(modelId: string): string {
  return modelId
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function falProbeEndpoint(baseUrl: string, settings: Settings): string {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (url.hostname === "fal.run") url.hostname = "queue.fal.run";
  url.pathname = `/${encodedModelPath(firstConfiguredModelId(settings, "fal-ai/flux-pro"))}/requests/dezin-connection-test/status`;
  url.search = "";
  return url.toString();
}

function midjourneyProbeEndpoint(baseUrl: string): string {
  const url = new URL(appendPath(baseUrl, "/midjourney/v1/fetch"));
  url.searchParams.set("jobId", "dezin-connection-test");
  return url.toString();
}

function stringField(item: unknown, fields: string[]): string {
  if (typeof item !== "object" || item === null) return "";
  for (const field of fields) {
    const value = (item as Record<string, unknown>)[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeModelId(id: string): string {
  return id.trim().replace(/^models\//, "").replace(/^publishers\/[^/]+\/models\//, "");
}

function providerErrorDetail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const body = JSON.parse(trimmed) as { error?: unknown; message?: unknown; detail?: unknown };
    if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
    if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
    if (typeof body.detail === "string" && body.detail.trim()) return body.detail.trim();
  } catch {
    // Use the original provider text when it is not JSON.
  }
  return trimmed.slice(0, 240);
}

function parseModels(body: unknown): ProviderModel[] {
  const source = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? (body as { data: unknown[] }).data
      : Array.isArray((body as { models?: unknown })?.models)
        ? (body as { models: unknown[] }).models
        : Array.isArray((body as { publisherModels?: unknown })?.publisherModels)
          ? (body as { publisherModels: unknown[] }).publisherModels
          : [];
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const item of source) {
    const id = typeof item === "string" ? item : stringField(item, ["id", "model_id", "name"]);
    const trimmed = normalizeModelId(id);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const name = stringField(item, ["display_name", "displayName", "name"]);
    models.push(name && name !== trimmed ? { id: trimmed, name } : { id: trimmed });
  }
  return models;
}

async function fetchJsonModels(url: string, headers: Record<string, string>, providerId: string, fetchImpl: typeof fetch): Promise<ProviderModel[]> {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const message = providerErrorDetail(detail);
    throw new Error(`${providerLabel(providerId)} model list request failed (${res.status})${message ? `: ${message}` : ""}`);
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

  if (providerId === "azure-openai") {
    const { baseUrl, apiKey } = assertConnectionSettings(settings, providerId);
    return fetchJsonModels(azureModelsEndpoint(baseUrl, settings), { accept: "application/json", "api-key": apiKey }, providerId, fetchImpl);
  }

  if (providerId === "gemini") {
    const { baseUrl, apiKey } = assertConnectionSettings(settings, providerId);
    return fetchJsonModels(geminiModelsEndpoint(baseUrl, apiKey), { accept: "application/json" }, providerId, fetchImpl);
  }

  if (providerId === "vertex-ai") {
    const { baseUrl, apiKey } = assertConnectionSettings(settings, providerId);
    return fetchJsonModels(modelsEndpoint(vertexModelsEndpoint(baseUrl, settings)), { accept: "application/json", authorization: `Bearer ${apiKey}` }, providerId, fetchImpl);
  }

  if (providerId === "wavespeed") {
    const { baseUrl, apiKey } = assertConnectionSettings(settings, providerId);
    return fetchJsonModels(modelsEndpoint(baseUrl), { accept: "application/json", authorization: `Bearer ${apiKey}` }, providerId, fetchImpl);
  }

  if (!OPENAI_COMPATIBLE_PROVIDERS.has(providerId)) {
    throw new Error(`${providerLabel(providerId)} does not support live model discovery yet.`);
  }

  const { baseUrl, apiKey } = assertConnectionSettings(settings, providerId);

  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return fetchJsonModels(modelsEndpoint(baseUrl), headers, providerId, fetchImpl);
}

async function probeEndpoint(url: string, headers: Record<string, string>, providerId: string, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(url, { headers });
  if (res.status === 401 || res.status === 403) {
    const detail = await res.text().catch(() => "");
    const message = providerErrorDetail(detail);
    throw new Error(`${providerLabel(providerId)} rejected credentials (${res.status})${message ? `: ${message}` : ""}`);
  }
  if (res.status >= 500) {
    const detail = await res.text().catch(() => "");
    const message = providerErrorDetail(detail);
    throw new Error(`${providerLabel(providerId)} connection probe failed (${res.status})${message ? `: ${message}` : ""}`);
  }
}

async function testProviderConnection(settings: Settings, providerId: string, fetchImpl: typeof fetch): Promise<ConnectionResult> {
  if (providerId === "fal") {
    const { baseUrl, apiKey } = assertConnectionSettings(settings, providerId);
    await probeEndpoint(falProbeEndpoint(baseUrl, settings), { accept: "application/json", authorization: `Key ${apiKey}` }, providerId, fetchImpl);
    return {};
  }

  if (providerId === "midjourney-gateway") {
    const { baseUrl, apiKey } = assertConnectionSettings(settings, providerId);
    await probeEndpoint(midjourneyProbeEndpoint(baseUrl), { accept: "application/json", "tt-api-key": apiKey }, providerId, fetchImpl);
    return {};
  }

  const models = await fetchProviderModels(settings, providerId, fetchImpl);
  return { modelsFound: models.length };
}

export async function handleTestModelProvider(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const body = await readJsonBody(req);
  const settings = deps.store.getSettings();
  const providerId = selectedProviderId(body, settings);
  try {
    const result = await testProviderConnection(settings, providerId, deps.modelProviderFetch ?? fetch);
    sendJson(res, 200, {
      ok: true,
      message:
        result.modelsFound == null
          ? `Connected to ${providerLabel(providerId)}.`
          : `Connected to ${providerLabel(providerId)}. Found ${result.modelsFound} ${result.modelsFound === 1 ? "model" : "models"}.`,
    });
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : "model provider test failed");
  }
}

export async function handleListModelProviderModels(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const body = await readJsonBody(req);
  const settings = deps.store.getSettings();
  const providerId = selectedProviderId(body, settings);
  if (providerId === "azure-openai") {
    sendError(res, 502, "Azure OpenAI deployment names must be entered manually. Azure's data-plane model list returns a catalog, not your deployed model IDs.");
    return;
  }
  try {
    const models = await fetchProviderModels(settings, providerId, deps.modelProviderFetch ?? fetch);
    sendJson(res, 200, { models, source: "live" });
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : "model discovery failed");
  }
}
