const ISOLATED_PREVIEW_SANDBOX = "allow-scripts allow-downloads";
const CROSS_ORIGIN_PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-downloads";

export function previewSandboxForSrc(src?: string | null, baseOrigin = globalThis.location?.origin ?? "http://localhost"): string {
  if (!src) return ISOLATED_PREVIEW_SANDBOX;
  try {
    const url = new URL(src, baseOrigin);
    if (url.origin !== baseOrigin) return CROSS_ORIGIN_PREVIEW_SANDBOX;
  } catch {
    // Treat malformed or relative-looking values as same-origin and keep them isolated.
  }
  return ISOLATED_PREVIEW_SANDBOX;
}

export function previewBridgeOriginForSrc(src?: string | null, baseOrigin = globalThis.location?.origin ?? "http://localhost"): string {
  if (!src) return "null";
  try {
    const url = new URL(src, baseOrigin);
    return url.origin === baseOrigin ? "null" : url.origin;
  } catch {
    return "null";
  }
}
