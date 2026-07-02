import { execFileSync } from "node:child_process";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

type ProxyResolver = () => string;

const dispatcherCache = new Map<string, Dispatcher>();
const nativeFetch = globalThis.fetch;

function envValue(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] || env[key.toLowerCase()] || "").trim();
}

function normalizeProxyUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function readMacProxyConfig(): string {
  try {
    return execFileSync("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

export function providerProxyUrlFromScutil(output: string): string {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z]+(?:Enable|Proxy|Port))\s*:\s*(.+?)\s*$/);
    if (match) values.set(match[1]!, match[2]!);
  }
  for (const prefix of ["HTTPS", "HTTP"] as const) {
    if (values.get(`${prefix}Enable`) !== "1") continue;
    const host = values.get(`${prefix}Proxy`)?.trim();
    if (!host) continue;
    const port = values.get(`${prefix}Port`)?.trim();
    return `http://${hostForUrl(host)}${port ? `:${port}` : ""}`;
  }
  return "";
}

export function resolveProviderProxyUrl(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readProxyConfig = readMacProxyConfig,
): string {
  const explicit = envValue(env, "HTTPS_PROXY") || envValue(env, "ALL_PROXY") || envValue(env, "HTTP_PROXY");
  if (explicit) return normalizeProxyUrl(explicit);
  if (platform === "darwin") return normalizeProxyUrl(providerProxyUrlFromScutil(readProxyConfig()));
  return "";
}

function privateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" || input instanceof URL ? String(input) : input.url;
}

export function shouldBypassProviderProxy(input: Parameters<typeof fetch>[0]): boolean {
  try {
    const url = new URL(inputUrl(input));
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host.endsWith(".local") || privateIpv4(host);
  } catch {
    return false;
  }
}

function dispatcherForProxy(proxyUrl: string): Dispatcher {
  const cached = dispatcherCache.get(proxyUrl);
  if (cached) return cached;
  const dispatcher = new ProxyAgent(proxyUrl);
  dispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

export function createProviderFetch(baseFetch: typeof fetch = fetch, resolveProxy: ProxyResolver = () => resolveProviderProxyUrl()): typeof fetch {
  return (async (input, init) => {
    const proxyUrl = resolveProxy();
    if (!proxyUrl || shouldBypassProviderProxy(input)) return baseFetch(input, init);
    const nextInit = { ...(init ?? {}), dispatcher: dispatcherForProxy(proxyUrl) } as RequestInit & { dispatcher: Dispatcher };
    const proxiedFetch = baseFetch === nativeFetch ? (undiciFetch as unknown as typeof fetch) : baseFetch;
    return proxiedFetch(input, nextInit);
  }) as typeof fetch;
}
