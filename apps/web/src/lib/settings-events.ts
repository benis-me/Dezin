import type { Settings } from "./api.ts";

export const SETTINGS_UPDATED_EVENT = "dezin:settings-updated";

export function publishSettingsUpdated(settings: Settings): void {
  queueMicrotask(() => {
    window.dispatchEvent(new CustomEvent<Settings>(SETTINGS_UPDATED_EVENT, { detail: settings }));
  });
}
