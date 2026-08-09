const PASSIVE_IMAGE_DATA_URL = /^data:image\/(?:avif|gif|jpeg|png|webp);/i;
const EXPLICIT_SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** Markdown is untrusted Agent/design content. Only passive inline/blob bytes and
 * app-local paths may load automatically; network URLs remain explicit links. */
export function localPassiveImageSource(src: string | undefined): string | null {
  const value = src?.trim();
  if (!value) return null;
  if (PASSIVE_IMAGE_DATA_URL.test(value) || value.startsWith("blob:")) return value;
  // Browsers normalize backslashes in HTTP URLs, so `/\\host` must not be
  // mistaken for an app-relative path. Scheme-relative URLs are remote too.
  if (value.includes("\\") || value.startsWith("//") || EXPLICIT_SCHEME.test(value)) return null;
  try {
    const base = new URL("https://dezin.local/");
    return new URL(value, base).origin === base.origin ? value : null;
  } catch {
    return null;
  }
}

/** Unsafe schemes never become clickable merely because they appeared in an
 * image position. HTTP(S) remains an explicit user-authorized navigation. */
export function explicitExternalImageHref(src: string | undefined): string | null {
  const value = src?.trim();
  if (!value || value.includes("\\") || value.startsWith("//")) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}
