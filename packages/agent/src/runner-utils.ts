import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpawnOutput } from "./claude-runner.ts";

export interface ArtifactSnapshot {
  exists: boolean;
  html: string | null;
}

export async function readArtifactSnapshot(projectDir: string, artifactPath: string): Promise<ArtifactSnapshot> {
  try {
    return { exists: true, html: await readFile(join(projectDir, artifactPath), "utf8") };
  } catch {
    return { exists: false, html: null };
  }
}

function tail(text: string | undefined, maxChars = 2000): string {
  return (text ?? "").trim().slice(-maxChars);
}

export function assertSuccessfulExit(label: string, output: SpawnOutput): void {
  if (output.exitCode === 0) return;
  const stderr = tail(output.stderr);
  throw new Error(`${label} exited with exit code ${output.exitCode}${stderr ? `: ${stderr}` : ""}`);
}

export async function readUpdatedArtifactHtml(projectDir: string, artifactPath: string, before: ArtifactSnapshot, label: string): Promise<string> {
  const after = await readArtifactSnapshot(projectDir, artifactPath);
  if (!after.exists || after.html === null) {
    throw new Error(`${label} artifact missing: ${artifactPath}`);
  }
  if (!after.html.trim()) {
    throw new Error(`${label} artifact empty: ${artifactPath}`);
  }
  if (before.exists && after.html === before.html) {
    throw new Error(`${label} artifact not updated: ${artifactPath}`);
  }
  return after.html;
}
