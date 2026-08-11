import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpawnOutput } from "./claude-runner.ts";

export interface ArtifactSnapshot {
  exists: boolean;
  html: string | null;
}

export type AgentArtifactFailureReason = "missing" | "empty" | "unchanged";

/** A successful provider turn that did not leave the required artifact in a publishable state. */
export class AgentArtifactError extends Error {
  readonly code = "AGENT_ARTIFACT_INCOMPLETE";
  readonly reason: AgentArtifactFailureReason;
  readonly artifactPath: string;

  constructor(label: string, artifactPath: string, reason: AgentArtifactFailureReason) {
    super(`${label} artifact ${reason === "unchanged" ? "not updated" : reason}: ${artifactPath}`);
    this.name = "AgentArtifactError";
    this.reason = reason;
    this.artifactPath = artifactPath;
  }
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

export async function readUpdatedArtifactHtml(
  projectDir: string,
  artifactPath: string,
  before: ArtifactSnapshot,
  label: string,
  options: { enforceArtifactUpdate?: boolean } = {},
): Promise<string> {
  const after = await readArtifactSnapshot(projectDir, artifactPath);
  if (!after.exists || after.html === null) {
    throw new AgentArtifactError(label, artifactPath, "missing");
  }
  if (!after.html.trim()) {
    throw new AgentArtifactError(label, artifactPath, "empty");
  }
  if ((options.enforceArtifactUpdate ?? true) && before.exists && after.html === before.html) {
    throw new AgentArtifactError(label, artifactPath, "unchanged");
  }
  return after.html;
}
