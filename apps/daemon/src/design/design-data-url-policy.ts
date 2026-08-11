const PASSIVE_IMAGE_MIME_TYPES = new Set([
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

const PASSIVE_FONT_MIME_TYPES = new Set([
  "application/font-sfnt",
  "application/font-woff",
  "application/vnd.ms-fontobject",
  "application/x-font-opentype",
  "application/x-font-truetype",
  "application/x-font-ttf",
  "application/x-font-woff",
  "application/x-font-woff2",
]);

function mimeEssence(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

/** Portable/data URL payloads must remain passive even if opened outside the
 * daemon's active-document CSP and attachment response headers. */
export function isPassiveDesignAssetMimeType(value: string): boolean {
  const mimeType = mimeEssence(value);
  return PASSIVE_IMAGE_MIME_TYPES.has(mimeType)
    || PASSIVE_FONT_MIME_TYPES.has(mimeType)
    || mimeType.startsWith("font/")
    || mimeType.startsWith("audio/")
    || mimeType.startsWith("video/");
}

export function isSafePassiveDesignDataUrl(value: string): boolean {
  const url = value.trim();
  if (!url.toLowerCase().startsWith("data:")) return false;
  const comma = url.indexOf(",", 5);
  if (comma === -1) return false;
  const metadata = url.slice(5, comma);
  const mimeType = metadata.split(";", 1)[0] ?? "";
  return mimeType.length > 0
    && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)
    && isPassiveDesignAssetMimeType(mimeType);
}
