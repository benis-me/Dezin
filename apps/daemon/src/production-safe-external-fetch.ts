import { lookup as dnsLookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { LookupAddress } from "node:dns";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

import type {
  SafeBoundedExternalFetcher,
  SafeExternalFetchRequest,
} from "./resource-revision-source.ts";

const MAX_FETCH_BYTES = 8 * 1024 * 1024;
const MAX_FETCH_TIMEOUT_MS = 60_000;
const MAX_FETCH_REDIRECTS = 10;
const MAX_RESOLVED_ADDRESSES = 32;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_PARAMETER = /(?:^|[_-])(?:access[_-]?token|token|api[_-]?key|secret|signature|sig|auth|authorization|password|credential)(?:$|[_-])/i;

export interface ProductionResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface ProductionExternalFetchHop {
  readonly url: URL;
  readonly pinnedAddress: ProductionResolvedAddress;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

export interface ProductionExternalFetchHopResult {
  readonly status: number;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly location: string | null;
  readonly remoteAddress: string;
}

export interface ProductionSafeExternalFetchOptions {
  /** Test seam. Production uses the operating system resolver once per hop. */
  readonly resolveAddresses?: (hostname: string) => Promise<readonly ProductionResolvedAddress[]>;
  /** Test seam. Production performs a no-pool HTTP request with a pinned lookup result. */
  readonly requestHop?: (hop: ProductionExternalFetchHop) => Promise<ProductionExternalFetchHopResult>;
}

export class ProductionSafeExternalFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductionSafeExternalFetchError";
  }
}

function fail(message: string, cause?: unknown): never {
  throw new ProductionSafeExternalFetchError(message, cause === undefined ? undefined : { cause });
}

function validSignal(value: unknown): value is AbortSignal {
  return Boolean(value && typeof value === "object"
    && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function");
}

function validateRequest(request: SafeExternalFetchRequest): void {
  if (!request || typeof request !== "object"
    || typeof request.url !== "string" || request.url.length === 0 || request.url.length > 4_096
    || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > MAX_FETCH_BYTES
    || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1
    || request.timeoutMs > MAX_FETCH_TIMEOUT_MS
    || !Number.isSafeInteger(request.maxRedirects) || request.maxRedirects < 0
    || request.maxRedirects > MAX_FETCH_REDIRECTS
    || request.publicIpOnly !== true || request.pinResolvedAddress !== true
    || request.revalidateRedirects !== true || !validSignal(request.signal)) {
    fail("External fetch request violates the bounded production policy");
  }
}

function ipv4IsPublic(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4
    || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function canonicalIpv6(address: string): string | null {
  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

function ipv6IsPublic(address: string): boolean {
  const canonical = canonicalIpv6(address);
  if (!canonical) return false;
  const [firstText = "", secondText = ""] = canonical.split(":", 2);
  const first = Number.parseInt(firstText, 16);
  const second = Number.parseInt(secondText || "0", 16);
  // Only globally routable unicast is accepted. Known documentation,
  // transition, benchmarking, and special-purpose ranges fail closed.
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (second <= 0x001f || (second >= 0x0020 && second <= 0x002f)
    || second === 0x0db8)) return false;
  if (first === 0x2002) return false;
  if (first === 0x3fff && second < 0x1000) return false;
  return true;
}

function addressIsPublic(address: string, family: 4 | 6): boolean {
  const detected = isIP(address);
  return detected === family && (family === 4 ? ipv4IsPublic(address) : ipv6IsPublic(address));
}

function exactExternalUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    return fail("External fetch URL is invalid", error);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username.length > 0 || url.password.length > 0 || url.href !== value
    || url.href.length > 4_096 || url.hostname.length === 0 || url.hostname.length > 253
    || url.hostname.endsWith(".")) {
    fail("External fetch URL must be one canonical credential-free HTTP(S) URL");
  }
  const fragmentParameters = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  if ([...url.searchParams.keys(), ...fragmentParameters.keys()]
    .some((key) => CREDENTIAL_PARAMETER.test(key))) {
    fail("External fetch URL cannot contain credential-bearing parameters");
  }
  const hostname = url.hostname.toLowerCase();
  if (isIP(hostname) === 0) {
    if (!hostname.includes(".") || hostname === "localhost"
      || [".localhost", ".local", ".lan", ".home", ".internal", ".test", ".invalid", ".example"]
        .some((suffix) => hostname.endsWith(suffix))) {
      fail("External fetch hostname is not a public DNS name");
    }
  } else if (!addressIsPublic(hostname, isIP(hostname) as 4 | 6)) {
    fail("External fetch address is private or special-purpose");
  }
  return url;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("External fetch aborted", "AbortError");
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function resolveProductionAddresses(hostname: string): Promise<readonly ProductionResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry: LookupAddress) => {
    if (entry.family !== 4 && entry.family !== 6) fail("External fetch DNS address family is invalid");
    return { address: entry.address, family: entry.family };
  });
}

function exactResolvedAddress(value: unknown): ProductionResolvedAddress {
  if (!value || typeof value !== "object") fail("External fetch DNS result is invalid");
  const address = Reflect.get(value, "address");
  const family = Reflect.get(value, "family");
  if (typeof address !== "string" || (family !== 4 && family !== 6)
    || !addressIsPublic(address, family)) {
    fail("External fetch DNS result contains a private or special-purpose address");
  }
  return Object.freeze({ address, family });
}

async function pinAddress(
  url: URL,
  resolveAddresses: NonNullable<ProductionSafeExternalFetchOptions["resolveAddresses"]>,
  signal: AbortSignal,
): Promise<ProductionResolvedAddress> {
  const literalFamily = isIP(url.hostname);
  if (literalFamily !== 0) {
    return exactResolvedAddress({ address: url.hostname, family: literalFamily });
  }
  const resolved = await abortable(Promise.resolve().then(() => resolveAddresses(url.hostname)), signal);
  if (!Array.isArray(resolved) || resolved.length === 0 || resolved.length > MAX_RESOLVED_ADDRESSES) {
    fail("External fetch DNS result is empty or unbounded");
  }
  // Every answer must be public. This prevents a mixed-answer DNS response from
  // turning retry or address-family behavior into a private-network bypass.
  const exact = resolved.map(exactResolvedAddress);
  exact.sort((left, right) => left.family - right.family || left.address.localeCompare(right.address));
  return exact[0]!;
}

function sameAddress(left: string, right: ProductionResolvedAddress): boolean {
  if (right.family === 4) return left === right.address;
  return canonicalIpv6(left) === canonicalIpv6(right.address);
}

function responseHeader(value: string | string[] | undefined, label: string): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value) || value.length === 0 || value.length > 4_096
    || value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    fail(`External fetch ${label} header is invalid`);
  }
  return value;
}

function readBoundedResponse(
  response: IncomingMessage,
  request: ClientRequest,
  maxBytes: number,
): Promise<ProductionExternalFetchHopResult> {
  return new Promise((resolve, reject) => {
    const status = response.statusCode;
    const remoteAddress = response.socket.remoteAddress;
    const mimeType = responseHeader(response.headers["content-type"], "Content-Type")
      ?? "application/octet-stream";
    const location = responseHeader(response.headers.location, "Location");
    if (!Number.isSafeInteger(status) || status === undefined || status < 100 || status > 599
      || typeof remoteAddress !== "string" || remoteAddress.length === 0
      || mimeType.length > 255) {
      response.destroy();
      reject(new ProductionSafeExternalFetchError("External fetch response metadata is invalid"));
      return;
    }
    const declaredLength = responseHeader(response.headers["content-length"], "Content-Length");
    if (declaredLength !== null
      && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
      const error = new ProductionSafeExternalFetchError("External fetch response exceeds its byte budget");
      response.destroy(error);
      request.destroy(error);
      reject(error);
      return;
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    response.on("data", (chunk: Buffer | Uint8Array | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > maxBytes) {
        const error = new ProductionSafeExternalFetchError("External fetch response exceeds its byte budget");
        response.destroy(error);
        request.destroy(error);
        return;
      }
      chunks.push(bytes);
    });
    response.once("error", reject);
    response.once("end", () => {
      if (byteLength > maxBytes) return;
      resolve({
        status,
        mimeType,
        bytes: Buffer.concat(chunks, byteLength),
        location,
        remoteAddress,
      });
    });
  });
}

async function requestProductionHop(
  hop: ProductionExternalFetchHop,
): Promise<ProductionExternalFetchHopResult> {
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) {
      callback(null, [{
        address: hop.pinnedAddress.address,
        family: hop.pinnedAddress.family,
      }]);
      return;
    }
    callback(null, hop.pinnedAddress.address, hop.pinnedAddress.family);
  };
  const options: RequestOptions = {
    protocol: hop.url.protocol,
    hostname: hop.url.hostname,
    port: hop.url.port || undefined,
    path: `${hop.url.pathname}${hop.url.search}`,
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
      "user-agent": "Dezin-External-Evidence/1",
    },
    agent: false,
    lookup,
    signal: hop.signal,
  };
  return await new Promise<ProductionExternalFetchHopResult>((resolve, reject) => {
    const transport = hop.url.protocol === "https:" ? requestHttps : requestHttp;
    const request = transport(options, (response) => {
      void readBoundedResponse(response, request, hop.maxBytes).then(resolve, reject);
    });
    request.once("error", reject);
    request.end();
  });
}

function validateHopResult(
  value: ProductionExternalFetchHopResult,
  pinnedAddress: ProductionResolvedAddress,
  maxBytes: number,
): ProductionExternalFetchHopResult {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.status)
    || value.status < 100 || value.status > 599
    || typeof value.mimeType !== "string" || value.mimeType.length === 0 || value.mimeType.length > 255
    || value.mimeType !== value.mimeType.trim() || value.mimeType.includes("\0")
    || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength > maxBytes
    || (value.location !== null && (typeof value.location !== "string"
      || value.location.length === 0 || value.location.length > 4_096
      || value.location.includes("\0") || value.location.includes("\r") || value.location.includes("\n")))
    || typeof value.remoteAddress !== "string" || !sameAddress(value.remoteAddress, pinnedAddress)) {
    fail("External fetch transport returned an invalid or unpinned response");
  }
  return value;
}

/**
 * Builds the single daemon-owned external HTTP boundary used by Resource
 * imports and generated Research evidence. DNS is resolved once per hop, every
 * answer must be public, the selected address is pinned into the socket lookup,
 * and redirects repeat the complete validation before another request occurs.
 */
export function createProductionSafeBoundedExternalFetcher(
  options: ProductionSafeExternalFetchOptions = {},
): SafeBoundedExternalFetcher {
  if ((options.resolveAddresses !== undefined && typeof options.resolveAddresses !== "function")
    || (options.requestHop !== undefined && typeof options.requestHop !== "function")) {
    fail("Production external fetch dependencies are invalid");
  }
  const resolveAddresses = options.resolveAddresses ?? resolveProductionAddresses;
  const requestHop = options.requestHop ?? requestProductionHop;
  return async (request) => {
    validateRequest(request);
    if (request.signal.aborted) throw abortReason(request.signal);
    const timeoutSignal = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeoutSignal]);
    let current = exactExternalUrl(request.url);
    let redirects = 0;
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      const pinnedAddress = await pinAddress(current, resolveAddresses, signal);
      const hop = Object.freeze({
        url: new URL(current.href),
        pinnedAddress,
        maxBytes: request.maxBytes,
        signal,
      });
      const result = validateHopResult(
        await abortable(Promise.resolve().then(() => requestHop(hop)), signal),
        pinnedAddress,
        request.maxBytes,
      );
      if (!REDIRECT_STATUS.has(result.status)) {
        return Object.freeze({
          finalUrl: current.href,
          status: result.status,
          mimeType: result.mimeType,
          bytes: Buffer.from(result.bytes),
        });
      }
      if (result.location === null) fail("External fetch redirect is missing a Location header");
      if (redirects >= request.maxRedirects) fail("External fetch exceeded its redirect budget");
      let next: URL;
      try {
        next = new URL(result.location, current);
      } catch (error) {
        return fail("External fetch redirect URL is invalid", error);
      }
      current = exactExternalUrl(next.href);
      redirects += 1;
    }
  };
}

/** @internal Direct transport seam for streaming-response regression tests. */
export const productionSafeExternalFetchTestSeams = Object.freeze({
  requestHop: requestProductionHop,
});
