import type { IncomingMessage } from "node:http";
import type { Settings } from "../../../packages/core/src/index.ts";
import { HttpError } from "./http-util.ts";
import { redactProviderProfiles } from "./provider-profile-config.ts";

export interface DaemonSecurityOptions {
  token?: string;
  disabled?: boolean;
  allowMissingToken?: boolean;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hostNameFromHostHeader(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end >= 0 ? trimmed.slice(1, end) : trimmed;
  }
  return trimmed.split(":")[0] ?? "";
}

function isLocalHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

export function isTrustedHost(host: string | string[] | undefined): boolean {
  const value = headerValue(host);
  if (!value) return true;
  return isLocalHostname(hostNameFromHostHeader(value));
}

export function isTrustedOrigin(origin: string | string[] | undefined): boolean {
  const value = headerValue(origin);
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

export function extractBearerToken(req: IncomingMessage): string | null {
  const explicit = headerValue(req.headers["x-dezin-daemon-token"]);
  if (explicit?.trim()) return explicit.trim();
  const authorization = headerValue(req.headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function requireDaemonRequest(req: IncomingMessage, options: DaemonSecurityOptions = {}): void {
  if (options.disabled) return;
  if (!isTrustedHost(req.headers.host)) throw new HttpError(403, "untrusted host");

  const token = options.token?.trim();
  const suppliedToken = extractBearerToken(req);
  if (token && suppliedToken !== token && !options.allowMissingToken) throw new HttpError(401, "daemon token required");

  if (!isTrustedOrigin(req.headers.origin) && (!token || suppliedToken !== token)) {
    throw new HttpError(403, "untrusted origin");
  }
}

export function assertSafeId(id: string, label = "id"): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..") || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new HttpError(400, `invalid ${label}`);
  }
  return id;
}

export function redactSettings(settings: Settings): Settings {
  return {
    ...settings,
    apiKeyConfigured: settings.apiKey.length > 0,
    apiKey: "",
    imageApiKeyConfigured: settings.imageApiKey.length > 0,
    imageApiKey: "",
    videoApiKeyConfigured: settings.videoApiKey.length > 0,
    videoApiKey: "",
    aiProviderProfiles: redactProviderProfiles(settings.aiProviderProfiles),
  };
}
