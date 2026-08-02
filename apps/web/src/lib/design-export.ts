import type { DezinNative } from "./native.ts";

const SAFE_EXPORT_ID = /^export-[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export type DesignExportRevealResult = "revealed" | "copied" | "unavailable";

/** Resolve only daemon-issued, single-segment Export identities beneath one Project root. */
export function designExportPath(projectPath: string | null | undefined, exportId: string): string | null {
  const root = projectPath?.trim().replace(/[\\/]+$/u, "") ?? "";
  if (!root || root.includes("\0") || !SAFE_EXPORT_ID.test(exportId)) return null;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return [root, "design", "exports", exportId].join(separator);
}

export async function revealDesignExport(input: {
  projectPath: string | null | undefined;
  exportId: string;
  openPath?: DezinNative["openPath"];
  writeClipboard?: (value: string) => Promise<void>;
}): Promise<DesignExportRevealResult> {
  const path = designExportPath(input.projectPath, input.exportId);
  if (path === null) return "unavailable";
  if (input.openPath) {
    try {
      if (await input.openPath(path)) return "revealed";
    } catch {
      // Fall through to the browser-safe copy affordance.
    }
  }
  if (input.writeClipboard) {
    try {
      await input.writeClipboard(path);
      return "copied";
    } catch {
      // The visible absolute path remains available for manual copying.
    }
  }
  return "unavailable";
}
