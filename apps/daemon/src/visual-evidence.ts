import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PersistVisualEvidenceInput {
  dataDir: string;
  projectId: string;
  runId: string;
  round: number;
  sourcePath: string;
}

export interface VisualEvidence {
  path: string;
  url: string;
}

function safeSegment(value: string, fallback: string): string {
  const safe = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 160);
  return safe || fallback;
}

export async function persistVisualEvidence(input: PersistVisualEvidenceInput): Promise<VisualEvidence | undefined> {
  const bytes = await readFile(input.sourcePath).catch(() => null);
  if (!bytes?.length) return undefined;

  const projectId = safeSegment(input.projectId, "project");
  const runId = safeSegment(input.runId, "run");
  const round = Math.max(0, Math.trunc(input.round));
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const fileName = `round-${round}-${hash}.png`;
  // Evidence lives outside the generated project repository. Otherwise Standard mode would see
  // every screenshot as an untracked source edit and publication/restore clean-tree guards would
  // fail (or, worse, a Run commit could accidentally absorb QA artifacts).
  const dir = join(input.dataDir, "version-evidence", projectId, runId, "visual");
  const path = join(dir, fileName);
  await mkdir(dir, { recursive: true });
  await writeFile(path, bytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return {
    path,
    url: `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(fileName)}`,
  };
}
