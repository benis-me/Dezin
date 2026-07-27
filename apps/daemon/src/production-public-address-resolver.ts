import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { createProviderFetch } from "./provider-fetch.ts";
import type { ProductionResolvedAddress } from "./production-safe-external-fetch.ts";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 4_000;
const DOH_MAX_BYTES = 64 * 1024;
const DOH_MAX_ANSWERS = 64;

type SystemAddressResolver = (
  hostname: string,
) => Promise<readonly ProductionResolvedAddress[]>;

export interface ProductionPublicAddressResolverOptions {
  readonly systemResolve?: SystemAddressResolver;
  /** Test seam. Production uses the proxy-aware provider fetch for one fixed DoH origin. */
  readonly fetchDoh?: typeof fetch;
}

export class ProductionPublicAddressResolverError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductionPublicAddressResolverError";
  }
}

function fail(message: string, cause?: unknown): never {
  throw new ProductionPublicAddressResolverError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isFakeIpv4(address: ProductionResolvedAddress): boolean {
  if (address.family !== 4) return false;
  const [a, b] = address.address.split(".").map(Number);
  return a === 198 && (b === 18 || b === 19);
}

async function resolveSystemAddresses(
  hostname: string,
): Promise<readonly ProductionResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry: LookupAddress) => {
    if (entry.family !== 4 && entry.family !== 6) {
      return fail("Production public DNS address family is invalid");
    }
    return { address: entry.address, family: entry.family };
  });
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > DOH_MAX_BYTES) {
      return fail("Production public DNS response exceeds its byte budget");
    }
  }
  if (response.body === null) return fail("Production public DNS response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const item = await reader.read();
      if (item.done) break;
      byteLength += item.value.byteLength;
      if (byteLength > DOH_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return fail("Production public DNS response exceeds its byte budget");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function canonicalDnsName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 254) {
    return fail("Production public DNS name is invalid");
  }
  return value.endsWith(".") ? value.slice(0, -1).toLowerCase() : value.toLowerCase();
}

function decodeDohResponse(
  value: unknown,
  hostname: string,
  expectedType: 1 | 28,
): ProductionResolvedAddress[] {
  const item = record(value, "Production public DNS response");
  if (item.Status !== 0 || !Array.isArray(item.Question) || item.Question.length !== 1) {
    return fail("Production public DNS response identity is invalid");
  }
  const question = record(item.Question[0], "Production public DNS question");
  if (canonicalDnsName(question.name) !== hostname.toLowerCase() || question.type !== expectedType) {
    return fail("Production public DNS question identity is invalid");
  }
  const rawAnswers = item.Answer === undefined ? [] : item.Answer;
  if (!Array.isArray(rawAnswers) || rawAnswers.length > DOH_MAX_ANSWERS) {
    return fail("Production public DNS answer set is invalid or unbounded");
  }
  const cnameByName = new Map<string, string>();
  for (const raw of rawAnswers) {
    const answer = record(raw, "Production public DNS answer");
    if (answer.type !== 5) continue;
    const name = canonicalDnsName(answer.name);
    const target = canonicalDnsName(answer.data);
    if (cnameByName.has(name)) {
      return fail("Production public DNS CNAME chain is ambiguous");
    }
    cnameByName.set(name, target);
  }
  const allowedNames = new Set<string>([hostname.toLowerCase()]);
  let current = hostname.toLowerCase();
  for (let depth = 0; depth < DOH_MAX_ANSWERS; depth += 1) {
    const next = cnameByName.get(current);
    if (next === undefined) break;
    if (allowedNames.has(next)) return fail("Production public DNS CNAME chain is cyclic");
    allowedNames.add(next);
    current = next;
  }
  const addresses: ProductionResolvedAddress[] = [];
  for (const raw of rawAnswers) {
    const answer = record(raw, "Production public DNS answer");
    if (answer.type !== 1 && answer.type !== 28) continue;
    if (!allowedNames.has(canonicalDnsName(answer.name))
      || typeof answer.data !== "string") {
      return fail("Production public DNS answer identity is invalid");
    }
    const family = isIP(answer.data);
    if ((answer.type === 1 && family !== 4) || (answer.type === 28 && family !== 6)) {
      return fail("Production public DNS answer address is invalid");
    }
    if (answer.type === expectedType) {
      addresses.push({ address: answer.data, family: family as 4 | 6 });
    }
  }
  return addresses;
}

async function resolveDohAddresses(
  hostname: string,
  fetchDoh: typeof fetch,
  signal: AbortSignal,
): Promise<readonly ProductionResolvedAddress[]> {
  const timeout = AbortSignal.timeout(DOH_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([signal, timeout]);
  const addresses: ProductionResolvedAddress[] = [];
  for (const [label, type] of [["A", 1], ["AAAA", 28]] as const) {
    const url = new URL(DOH_ENDPOINT);
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", label);
    let response: Response;
    try {
      response = await fetchDoh(url.href, {
        method: "GET",
        headers: { accept: "application/dns-json" },
        redirect: "error",
        signal: combinedSignal,
      });
    } catch (error) {
      if (combinedSignal.aborted) throw combinedSignal.reason;
      return fail("Production public DNS request failed", error);
    }
    if (response.status !== 200
      || !response.headers.get("content-type")?.toLowerCase().includes("application/dns-json")) {
      return fail("Production public DNS response status or media type is invalid");
    }
    const bytes = await readBoundedResponse(response, combinedSignal);
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      return fail("Production public DNS response is not valid UTF-8 JSON", error);
    }
    addresses.push(...decodeDohResponse(decoded, hostname, type));
  }
  if (addresses.length === 0) return fail("Production public DNS answer set is empty");
  return addresses;
}

/**
 * Uses the operating-system resolver normally. An all-198.18/15 response is
 * treated only as a Fake-IP signal and replaced through one fixed, bounded DoH
 * origin. Fake addresses are never returned as public or opened as sockets.
 */
export function createProductionPublicAddressResolver(
  options: ProductionPublicAddressResolverOptions = {},
): (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly ProductionResolvedAddress[]> {
  if ((options.systemResolve !== undefined && typeof options.systemResolve !== "function")
    || (options.fetchDoh !== undefined && typeof options.fetchDoh !== "function")) {
    fail("Production public DNS dependencies are invalid");
  }
  const systemResolve = options.systemResolve ?? resolveSystemAddresses;
  const fetchDoh = options.fetchDoh ?? createProviderFetch();
  return async (hostname, signal = new AbortController().signal) => {
    const systemAddresses = await systemResolve(hostname);
    if (!Array.isArray(systemAddresses) || systemAddresses.length === 0) {
      return fail("Production system DNS answer set is empty");
    }
    if (!systemAddresses.every(isFakeIpv4)) return systemAddresses;
    return await resolveDohAddresses(hostname, fetchDoh, signal);
  };
}
