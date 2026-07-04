/** Kebab-case a title into a filesystem- and id-safe slug. Pure. */
export function slugify(input: string, fallback = "item"): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/** Make a slug unique against a set of already-used slugs (appends -2, -3, …). */
export function uniqueSlug(input: string, used: Set<string>, fallback = "item"): string {
  const base = slugify(input, fallback);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
