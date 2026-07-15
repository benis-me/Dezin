import {
  ContextIntegrityError,
  type ResourceContextAdapter,
} from "../context-types.ts";
import { resolveSnapshot, snapshotBytes } from "./file.ts";

const MAX_EXTERNAL_REPRESENTATION_BYTES = 2 * 1024 * 1024;
const CREDENTIAL_PARAMETER = /(?:^|[_-])(?:access[_-]?token|token|api[_-]?key|secret|signature|sig|auth|authorization|password|credential)(?:$|[_-])/i;

function safeExternalUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ContextIntegrityError(`${label} is invalid`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username || url.password || value.length > 4_096 || url.href.length > 4_096) {
    throw new ContextIntegrityError(`${label} must be a credential-free HTTP(S) URL`);
  }
  const fragmentParameters = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  if ([...url.searchParams.keys(), ...fragmentParameters.keys()].some((key) => CREDENTIAL_PARAMETER.test(key))) {
    throw new ContextIntegrityError(`${label} cannot persist credential-bearing parameters`);
  }
  return url.href;
}

/**
 * This adapter deliberately has no network client. The route layer must pass an
 * already fetched, policy-checked, bounded representation; this prevents the
 * Context subsystem from becoming an SSRF-capable ambient fetch surface.
 */
export const externalReferenceAdapter: ResourceContextAdapter = {
  kind: "external-reference",
  async snapshot(input) {
    if (input.kind !== "external-reference" || input.source.type !== "bounded-external") {
      throw new ContextIntegrityError("External Reference adapter requires an injected bounded representation");
    }
    if (!(input.source.bytes instanceof Uint8Array)
      || input.source.bytes.byteLength > MAX_EXTERNAL_REPRESENTATION_BYTES) {
      throw new ContextIntegrityError("External Reference representation exceeds its byte limit");
    }
    if (!Number.isInteger(input.source.status) || input.source.status < 100 || input.source.status > 599) {
      throw new ContextIntegrityError("External Reference response status is invalid");
    }
    const sourceUrl = safeExternalUrl(input.source.url, "External Reference source URL");
    const finalUrl = safeExternalUrl(input.source.finalUrl, "External Reference final URL");
    return snapshotBytes(
      {
        ...input,
        provenance: {
          ...structuredClone(input.provenance),
          sourceUrl,
          finalUrl,
          status: input.source.status,
          fetchBoundary: "injected-bounded-representation",
        },
      },
      Buffer.from(input.source.bytes),
      input.source.mimeType,
    );
  },
  resolve(input) {
    return resolveSnapshot(input, "external-reference");
  },
};
