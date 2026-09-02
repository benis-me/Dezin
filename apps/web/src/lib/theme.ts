/**
 * Theme preference: an explicit light or dark choice, or "system" to follow the
 * OS. Dezin stays dark-first, so a user who never chose keeps the dark theme.
 */
export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "dezin.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "system" ? saved : "dark";
  } catch {
    return "dark";
  }
}

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY).matches
    : false;
}

export function resolveDark(preference: ThemePreference): boolean {
  return preference === "system" ? systemPrefersDark() : preference === "dark";
}

/** Apply the class the stylesheet keys off and remember the choice. */
export function applyThemePreference(preference: ThemePreference): boolean {
  const dark = resolveDark(preference);
  document.documentElement.classList.toggle("dark", dark);
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    /* ignore */
  }
  return dark;
}

/** Re-apply while following the OS; returns an unsubscribe function. */
export function watchSystemTheme(onChange: (dark: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(DARK_QUERY);
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
