import type { IncomingMessage } from "node:http";
import type { Settings } from "@dezin/core";
import { HttpError } from "./http-util.ts";
import { redactProviderProfiles } from "./provider-profile-config.ts";
import type { ExtensionScope } from "@dezin/core";
import type { ExtensionPairingService, RequestPrincipal } from "./extension-auth.ts";

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
  // HTTP/1.1 requires Host; a request without one is not a browser on this machine.
  if (!value) return false;
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

export function extensionIdFromOrigin(origin: string | string[] | undefined): string | null {
  const value = headerValue(origin);
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "chrome-extension:" && url.hostname ? url.hostname : null;
  } catch {
    return null;
  }
}

export const DAEMON_TOKEN_COOKIE = "dezin_daemon_token";

export function extractBearerToken(req: IncomingMessage): string | null {
  const explicit = headerValue(req.headers["x-dezin-daemon-token"]);
  if (explicit?.trim()) return explicit.trim();
  const authorization = headerValue(req.headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]?.trim()) return match[1].trim();
  return cookieToken(req);
}

/**
 * The HttpOnly session cookie set when the daemon serves the Web app. Cookies
 * are ambient credentials, so the cookie counts only for requests the browser
 * marks as same-origin (or a top-level navigation). `localhost:5173` and
 * `localhost:7457` are the same *site*, so SameSite alone is not enough.
 */
function cookieToken(req: IncomingMessage): string | null {
  const cookie = headerValue(req.headers.cookie);
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${DAEMON_TOKEN_COOKIE}=([^;]+)`));
  if (!match?.[1]) return null;
  const site = headerValue(req.headers["sec-fetch-site"]);
  if (site !== undefined) {
    if (site !== "same-origin" && site !== "none") return null;
  } else if (!originMatchesHost(req)) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return null;
  }
}

function originMatchesHost(req: IncomingMessage): boolean {
  const origin = headerValue(req.headers.origin);
  const host = headerValue(req.headers.host);
  if (!host) return false;
  if (!origin) return true; // a navigation or an old client without Origin
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

export function requireExtensionPairingRequest(req: IncomingMessage): string {
  if (!isTrustedHost(req.headers.host)) throw new HttpError(403, "untrusted host");
  const extensionId = extensionIdFromOrigin(req.headers.origin);
  if (!extensionId) throw new HttpError(403, "chrome extension origin required");
  return extensionId;
}

export function requireDaemonRequest(
  req: IncomingMessage,
  options: DaemonSecurityOptions = {},
  extensionPairing?: ExtensionPairingService,
  extensionScope?: ExtensionScope,
): RequestPrincipal {
  if (options.disabled) return { kind: "daemon" };
  if (!isTrustedHost(req.headers.host)) throw new HttpError(403, "untrusted host");

  const token = options.token?.trim();
  const suppliedToken = extractBearerToken(req);
  if (token && suppliedToken === token) return { kind: "daemon" };

  const extensionId = extensionIdFromOrigin(req.headers.origin);
  if (extensionScope && extensionPairing && suppliedToken) {
    if (!extensionId) throw new HttpError(403, "chrome extension origin required");
    return extensionPairing.authorize(suppliedToken, extensionScope, extensionId);
  }
  if (extensionId && suppliedToken && token && suppliedToken !== token) {
    throw new HttpError(403, "extension credential is not allowed for this route");
  }
  if (token && suppliedToken !== token && !options.allowMissingToken) throw new HttpError(401, "daemon token required");

  if (!isTrustedOrigin(req.headers.origin) && (!token || suppliedToken !== token)) {
    throw new HttpError(403, "untrusted origin");
  }
  return { kind: "daemon" };
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
