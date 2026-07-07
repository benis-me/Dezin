/** True when the string is a well-formed http(s) URL usable as a Sharingan clone source. */
export function isCloneUrl(value: string): boolean {
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}
