import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { RenderFrameSpec } from "../../../../packages/core/src/index.ts";

const PNG_SIGNATURE = "89504e470d0a1a0a";
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface GenerationTaskVisualEvidenceOwner {
  projectId: string;
  workspaceId: string;
  planId: string;
  taskId: string;
  attempt: number;
  candidateCommitHash: string;
  candidateTreeHash: string;
  contextPackId: string;
  contextPackHash: string;
}

export interface GenerationTaskVisualEvidenceFrame extends RenderFrameSpec {
  frameAttemptId: string;
}

export interface GenerationTaskVisualEvidenceDescriptor {
  protocol: "dezin.generation-task-visual-evidence.v1";
  owner: GenerationTaskVisualEvidenceOwner;
  frame: GenerationTaskVisualEvidenceFrame;
  round: number;
  mediaType: "image/png";
  sha256: string;
  byteLength: number;
  /** Relative, content-addressed storage locator. It is not an authorization-free URL. */
  storageKey: string;
}

export interface PersistGenerationTaskVisualEvidenceInput {
  dataDir: string;
  owner: GenerationTaskVisualEvidenceOwner;
  frame: GenerationTaskVisualEvidenceFrame;
  round: number;
  sourcePath: string;
}

export class GenerationTaskVisualEvidenceError extends Error {
  readonly failureClass = "storage" as const;

  constructor(message: string) {
    super(message);
    this.name = "GenerationTaskVisualEvidenceError";
  }
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !OWNER_ID.test(value) || value === "." || value === "..") {
    throw new GenerationTaskVisualEvidenceError(`${label} is invalid`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new GenerationTaskVisualEvidenceError(`${label} is invalid`);
  }
  return value;
}

function owner(value: GenerationTaskVisualEvidenceOwner): GenerationTaskVisualEvidenceOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(value.attempt) || value.attempt < 1
    || !OBJECT_ID.test(value.candidateCommitHash)
    || !OBJECT_ID.test(value.candidateTreeHash)
    || !SHA256.test(value.contextPackHash)
    || value.contextPackId !== `context-pack-${value.contextPackHash}`) {
    throw new GenerationTaskVisualEvidenceError("Generation Task evidence owner is invalid");
  }
  return {
    projectId: id(value.projectId, "Project id"),
    workspaceId: id(value.workspaceId, "Workspace id"),
    planId: id(value.planId, "Plan id"),
    taskId: id(value.taskId, "Task id"),
    attempt: value.attempt,
    candidateCommitHash: value.candidateCommitHash,
    candidateTreeHash: value.candidateTreeHash,
    contextPackId: value.contextPackId,
    contextPackHash: value.contextPackHash,
  };
}

function frame(value: GenerationTaskVisualEvidenceFrame): GenerationTaskVisualEvidenceFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(value.width) || value.width < 1 || value.width > 16_384
    || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 16_384) {
    throw new GenerationTaskVisualEvidenceError("Generation Task evidence Frame is invalid");
  }
  const normalized: GenerationTaskVisualEvidenceFrame = {
    id: id(value.id, "Frame id"),
    name: text(value.name, "Frame name"),
    width: value.width,
    height: value.height,
    frameAttemptId: id(value.frameAttemptId, "Frame Attempt id"),
  };
  if (value.initialState !== undefined) normalized.initialState = id(value.initialState, "Frame initial state");
  if (value.fixture !== undefined) normalized.fixture = structuredClone(value.fixture);
  if (value.background !== undefined) {
    if (typeof value.background !== "string" || value.background.length === 0 || value.background.length > 128) {
      throw new GenerationTaskVisualEvidenceError("Frame background is invalid");
    }
    normalized.background = value.background;
  }
  return normalized;
}

function sameOwner(left: GenerationTaskVisualEvidenceOwner, right: GenerationTaskVisualEvidenceOwner): boolean {
  return left.projectId === right.projectId
    && left.workspaceId === right.workspaceId
    && left.planId === right.planId
    && left.taskId === right.taskId
    && left.attempt === right.attempt
    && left.candidateCommitHash === right.candidateCommitHash
    && left.candidateTreeHash === right.candidateTreeHash
    && left.contextPackId === right.contextPackId
    && left.contextPackHash === right.contextPackHash;
}

function storageKey(
  exactOwner: GenerationTaskVisualEvidenceOwner,
  exactFrame: GenerationTaskVisualEvidenceFrame,
  round: number,
  sha256: string,
): string {
  return [
    "generation-task-evidence",
    exactOwner.projectId,
    exactOwner.workspaceId,
    exactOwner.planId,
    exactOwner.taskId,
    `attempt-${exactOwner.attempt}`,
    "visual",
    `round-${round}-${exactFrame.id}-${sha256}.png`,
  ].join("/");
}

function resolvedStoragePath(dataDir: string, key: string): string {
  const root = resolve(dataDir);
  const path = resolve(root, ...key.split("/"));
  if (path === root || !path.startsWith(`${root}${sep}`)) {
    throw new GenerationTaskVisualEvidenceError("Generation Task evidence storage key escapes its data directory");
  }
  return path;
}

export async function persistGenerationTaskVisualEvidence(
  input: PersistGenerationTaskVisualEvidenceInput,
): Promise<GenerationTaskVisualEvidenceDescriptor | undefined> {
  const exactOwner = owner(input.owner);
  const exactFrame = frame(input.frame);
  if (typeof input.dataDir !== "string" || input.dataDir.length === 0
    || !Number.isSafeInteger(input.round) || input.round < 0) {
    throw new GenerationTaskVisualEvidenceError("Generation Task evidence persistence input is invalid");
  }
  const bytes = await readFile(input.sourcePath).catch(() => null);
  if (!bytes?.length || bytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) return undefined;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = storageKey(exactOwner, exactFrame, input.round, sha256);
  const path = resolvedStoragePath(input.dataDir, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (createHash("sha256").update(existing).digest("hex") !== sha256) {
      throw new GenerationTaskVisualEvidenceError("Existing generation Task evidence failed content verification");
    }
  });
  return {
    protocol: "dezin.generation-task-visual-evidence.v1",
    owner: exactOwner,
    frame: exactFrame,
    round: input.round,
    mediaType: "image/png",
    sha256,
    byteLength: bytes.byteLength,
    storageKey: key,
  };
}

export async function resolveGenerationTaskVisualEvidencePath(input: {
  dataDir: string;
  descriptor: GenerationTaskVisualEvidenceDescriptor;
  expectedOwner: GenerationTaskVisualEvidenceOwner;
}): Promise<string> {
  const expectedOwner = owner(input.expectedOwner);
  const descriptorOwner = owner(input.descriptor?.owner);
  const descriptorFrame = frame(input.descriptor?.frame);
  if (input.descriptor?.protocol !== "dezin.generation-task-visual-evidence.v1"
    || input.descriptor.mediaType !== "image/png"
    || !Number.isSafeInteger(input.descriptor.round) || input.descriptor.round < 0
    || !SHA256.test(input.descriptor.sha256)
    || !Number.isSafeInteger(input.descriptor.byteLength) || input.descriptor.byteLength < 1
    || !sameOwner(descriptorOwner, expectedOwner)) {
    throw new GenerationTaskVisualEvidenceError("Generation Task evidence descriptor or owner is invalid");
  }
  const expectedKey = storageKey(
    descriptorOwner,
    descriptorFrame,
    input.descriptor.round,
    input.descriptor.sha256,
  );
  if (input.descriptor.storageKey !== expectedKey) {
    throw new GenerationTaskVisualEvidenceError("Generation Task evidence storage ownership is invalid");
  }
  const path = resolvedStoragePath(input.dataDir, expectedKey);
  const bytes = await readFile(path).catch(() => null);
  if (!bytes?.length
    || bytes.byteLength !== input.descriptor.byteLength
    || bytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE
    || createHash("sha256").update(bytes).digest("hex") !== input.descriptor.sha256) {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence is missing, empty, or content identity verification failed",
    );
  }
  return path;
}
