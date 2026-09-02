/**
 * One place for every date/time string in the UI. The interface is English, so
 * dates are too; without an explicit locale the browser would print "8月20日"
 * inside an English screen.
 */
const LOCALE = "en-US";

export function formatTime(value: number | Date): string {
  return new Date(value).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
}

export function formatShortDate(value: number | Date): string {
  return new Date(value).toLocaleDateString(LOCALE, { month: "short", day: "numeric" });
}

export function formatDate(value: number | Date): string {
  return new Date(value).toLocaleDateString(LOCALE);
}

export function formatDateTime(value: number | Date): string {
  return new Date(value).toLocaleString(LOCALE);
}

/** Time of day within the last 24 hours, otherwise a short date. */
export function formatRecent(value: number, now: number = Date.now()): string {
  return now - value < 24 * 60 * 60 * 1000 ? formatTime(value) : formatShortDate(value);
}
