import { execFile } from "node:child_process";
import { extname, posix } from "node:path";
import { TextDecoder } from "node:util";

import type { ArtifactRevisionRecord, Store } from "../../../../packages/core/src/index.ts";
import {
  ArtifactMutationValidationError,
  listStaticDesignNodeLocators,
} from "../artifact-mutation.ts";
import { checksumBytes, cloneAndFreeze, stableStringify } from "../context/context-types.ts";
import { projectDir } from "../serve-static.ts";
import { verifyArtifactCandidateObject } from "./artifact-candidate-transaction.ts";
import { buildRenderAssembly, RenderAssemblyError } from "../render-assembly.ts";

const MAX_TREE_LIST_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BLOB_BYTES = 4 * 1024 * 1024;
const MAX_SELECTION_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_SELECTION_SOURCE_FILES = 4_096;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SUPPORTED_SOURCE_EXTENSIONS = new Set([".html", ".htm", ".js", ".jsx", ".ts", ".tsx"]);
const DESIGN_MARKER = /data-(?:dezin-id|design-node-id|dezin-node-id)/i;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface GitTreeBlob {
  readonly objectId: string;
  readonly byteLength: number;
  readonly sourcePath: string;
}

interface LocatedDesignNode {
  readonly revision: ArtifactRevisionRecord;
  readonly sourcePath: string;
}

interface AssemblySelectionIndexBudget {
  sourceBytes: number;
  treeFiles: number;
}

export interface ArtifactElementSelectionManifestEntry {
  readonly protocol: "dezin.artifact-element-selection-manifest.v1";
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly artifactRevisionId: string;
  readonly assemblyHash: string;
  readonly designNodeId: string;
  readonly sourceArtifactId: string;
  readonly sourceArtifactRevisionId: string;
  readonly sourceCommitHash: string;
  readonly sourceTreeHash: string;
  readonly sourcePath: string;
  readonly selectionManifestHash: string;
}

export class ArtifactElementSelectionProvenanceError extends Error {
  readonly code: "unavailable" | "invalid-source" | "not-found" | "ambiguous";

  constructor(code: ArtifactElementSelectionProvenanceError["code"], message: string, cause?: unknown) {
    super(message);
    this.name = "ArtifactElementSelectionProvenanceError";
    this.code = code;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Artifact element selection provenance aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function gitBytes(
  repositoryDir: string,
  args: readonly string[],
  signal: AbortSignal,
  maxBuffer: number,
): Promise<Buffer> {
  return new Promise((resolveBytes, reject) => {
    execFile(
      "git",
      [
        "-c", "core.fsmonitor=false",
        "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        ...args,
      ],
      {
        cwd: repositoryDir,
        encoding: "buffer",
        env: gitEnvironment(),
        maxBuffer,
        signal,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolveBytes(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function canonicalTreePath(value: string, artifactRoot: string): string {
  if (value.length === 0 || value.length > 4_096 || value.includes("\\")
    || value.startsWith("/") || value.includes("\0") || posix.normalize(value) !== value
    || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new ArtifactElementSelectionProvenanceError(
      "invalid-source",
      "Immutable Artifact source tree contains an unsafe path",
    );
  }
  const rootPrefix = artifactRoot === "." ? "" : `${artifactRoot}/`;
  if (rootPrefix.length > 0 && !value.startsWith(rootPrefix)) {
    throw new ArtifactElementSelectionProvenanceError(
      "invalid-source",
      "Immutable Artifact source tree escaped its owned source root",
    );
  }
  return value;
}

function parseTreeBlobs(
  bytes: Buffer,
  artifactRoot: string,
  excludedRoots: readonly string[],
  budget: AssemblySelectionIndexBudget,
): GitTreeBlob[] {
  let listing: string;
  try {
    listing = UTF8.decode(bytes);
  } catch (error) {
    throw new ArtifactElementSelectionProvenanceError(
      "invalid-source",
      "Immutable Artifact source tree has non-UTF-8 paths",
      error,
    );
  }
  const records = listing.split("\0");
  if (records.at(-1) === "") records.pop();
  return records.flatMap((record) => {
    const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40}(?:[0-9a-f]{24})?) +(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!match) {
      throw new ArtifactElementSelectionProvenanceError(
        "invalid-source",
        "Immutable Artifact source tree listing is malformed",
      );
    }
    const [, mode, type, objectId, sizeText, rawPath] = match;
    const sourcePath = canonicalTreePath(rawPath!, artifactRoot);
    if (excludedRoots.some((root) => sourcePath === root || sourcePath.startsWith(`${root}/`))) return [];
    budget.treeFiles += 1;
    if (!Number.isSafeInteger(budget.treeFiles) || budget.treeFiles > MAX_SELECTION_SOURCE_FILES) {
      throw new ArtifactElementSelectionProvenanceError(
        "invalid-source",
        "Immutable Artifact assembly exceeds the selection-index file budget",
      );
    }
    if (type !== "blob" || mode === "120000" || !SUPPORTED_SOURCE_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
      return [];
    }
    const byteLength = Number(sizeText);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_SOURCE_BLOB_BYTES) {
      throw new ArtifactElementSelectionProvenanceError(
        "invalid-source",
        `Immutable Artifact source ${sourcePath} exceeds the selection-index byte budget`,
      );
    }
    return [{ objectId: objectId!, byteLength, sourcePath }];
  });
}

async function revisionDesignNodeMatches(input: {
  repositoryDir: string;
  revision: ArtifactRevisionRecord;
  designNodeId: string;
  excludedRoots: readonly string[];
  budget: AssemblySelectionIndexBudget;
  signal: AbortSignal;
}): Promise<LocatedDesignNode[]> {
  checkAbort(input.signal);
  if (!OBJECT_ID.test(input.revision.sourceCommitHash) || !OBJECT_ID.test(input.revision.sourceTreeHash)) {
    throw new ArtifactElementSelectionProvenanceError(
      "unavailable",
      `Artifact Revision ${input.revision.id} has no verifiable immutable Git identity`,
    );
  }
  try {
    await verifyArtifactCandidateObject({
      repositoryDir: input.repositoryDir,
      commitHash: input.revision.sourceCommitHash,
      treeHash: input.revision.sourceTreeHash,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw abortReason(input.signal);
    throw new ArtifactElementSelectionProvenanceError(
      "unavailable",
      `Artifact Revision ${input.revision.id} immutable source object is unavailable`,
      error,
    );
  }
  let blobs: GitTreeBlob[];
  try {
    const listing = await gitBytes(
      input.repositoryDir,
      ["ls-tree", "-r", "-z", "--long", input.revision.sourceCommitHash, "--", input.revision.artifactRoot],
      input.signal,
      MAX_TREE_LIST_BYTES,
    );
    blobs = parseTreeBlobs(listing, input.revision.artifactRoot, input.excludedRoots, input.budget);
  } catch (error) {
    if (input.signal.aborted) throw abortReason(input.signal);
    if (error instanceof ArtifactElementSelectionProvenanceError) throw error;
    throw new ArtifactElementSelectionProvenanceError(
      "unavailable",
      `Artifact Revision ${input.revision.id} source index is unavailable`,
      error,
    );
  }
  const totalBytes = blobs.reduce((sum, blob) => sum + blob.byteLength, 0);
  input.budget.sourceBytes += totalBytes;
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(input.budget.sourceBytes)
    || input.budget.sourceBytes > MAX_SELECTION_SOURCE_BYTES) {
    throw new ArtifactElementSelectionProvenanceError(
      "invalid-source",
      "Immutable Artifact assembly exceeds the selection-index total byte budget",
    );
  }
  const matches: LocatedDesignNode[] = [];
  for (const blob of blobs) {
    checkAbort(input.signal);
    let bytes: Buffer;
    try {
      bytes = await gitBytes(
        input.repositoryDir,
        ["cat-file", "blob", blob.objectId],
        input.signal,
        MAX_SOURCE_BLOB_BYTES,
      );
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      throw new ArtifactElementSelectionProvenanceError(
        "unavailable",
        `Artifact Revision ${input.revision.id} source blob ${blob.sourcePath} is unavailable`,
        error,
      );
    }
    if (bytes.byteLength !== blob.byteLength) {
      throw new ArtifactElementSelectionProvenanceError(
        "invalid-source",
        `Artifact Revision ${input.revision.id} source blob ${blob.sourcePath} changed size`,
      );
    }
    let source: string;
    try {
      source = UTF8.decode(bytes);
    } catch (error) {
      throw new ArtifactElementSelectionProvenanceError(
        "invalid-source",
        `Artifact Revision ${input.revision.id} source blob ${blob.sourcePath} is not UTF-8`,
        error,
      );
    }
    if (!DESIGN_MARKER.test(source)) continue;
    let locators;
    try {
      locators = listStaticDesignNodeLocators(source, blob.sourcePath);
    } catch (error) {
      if (error instanceof ArtifactMutationValidationError) {
        throw new ArtifactElementSelectionProvenanceError(
          "invalid-source",
          `Artifact Revision ${input.revision.id} has an invalid static design-node index: ${error.message}`,
          error,
        );
      }
      throw error;
    }
    for (const locator of locators) {
      if (locator.designNodeId === input.designNodeId) {
        matches.push({ revision: input.revision, sourcePath: blob.sourcePath });
      }
    }
  }
  return matches;
}

/**
 * Proves an element against the exact immutable root Revision and its linked
 * Component Revision closure. The resulting manifest entry is deterministic,
 * server-owned, and safe to seal into a Context Pack.
 */
export async function resolveArtifactElementSelectionProvenance(input: {
  store: Store;
  dataDir: string;
  projectId: string;
  workspaceId: string;
  artifactId: string;
  revisionId: string;
  designNodeId: string;
  signal: AbortSignal;
}): Promise<ArtifactElementSelectionManifestEntry> {
  checkAbort(input.signal);
  let assembly;
  try {
    assembly = buildRenderAssembly(input.store, {
      projectId: input.projectId,
      revisionId: input.revisionId,
    }, { dataDir: input.dataDir });
  } catch (error) {
    if (error instanceof RenderAssemblyError) {
      throw new ArtifactElementSelectionProvenanceError(
        "unavailable",
        `Artifact Revision ${input.revisionId} immutable assembly is unavailable: ${error.message}`,
        error,
      );
    }
    throw error;
  }
  if (assembly.workspaceId !== input.workspaceId || assembly.artifactId !== input.artifactId
    || assembly.rootRevision.id !== input.revisionId) {
    throw new ArtifactElementSelectionProvenanceError(
      "unavailable",
      `Artifact Revision ${input.revisionId} does not own the requested Artifact assembly`,
    );
  }
  const repositoryDir = projectDir(input.dataDir, input.projectId);
  const matches: LocatedDesignNode[] = [];
  const budget: AssemblySelectionIndexBudget = { sourceBytes: 0, treeFiles: 0 };
  for (const revision of assembly.revisions) {
    const rootPrefix = revision.artifactRoot === "." ? "" : `${revision.artifactRoot}/`;
    const excludedRoots = assembly.revisions
      .filter((candidate) => candidate.id !== revision.id
        && (rootPrefix.length === 0 || candidate.artifactRoot.startsWith(rootPrefix)))
      .map((candidate) => candidate.artifactRoot);
    matches.push(...await revisionDesignNodeMatches({
      repositoryDir,
      revision,
      designNodeId: input.designNodeId,
      excludedRoots,
      budget,
      signal: input.signal,
    }));
  }
  checkAbort(input.signal);
  if (matches.length === 0) {
    throw new ArtifactElementSelectionProvenanceError(
      "not-found",
      `Selected design element ${input.designNodeId} cannot be proven in immutable Artifact Revision ${input.revisionId}`,
    );
  }
  if (matches.length !== 1) {
    throw new ArtifactElementSelectionProvenanceError(
      "ambiguous",
      `Selected design element ${input.designNodeId} is ambiguous in immutable Artifact Revision ${input.revisionId}`,
    );
  }
  const match = matches[0]!;
  const manifest = {
    protocol: "dezin.artifact-element-selection-manifest.v1" as const,
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    artifactRevisionId: input.revisionId,
    assemblyHash: assembly.assemblyHash,
    designNodeId: input.designNodeId,
    sourceArtifactId: match.revision.artifactId,
    sourceArtifactRevisionId: match.revision.id,
    sourceCommitHash: match.revision.sourceCommitHash,
    sourceTreeHash: match.revision.sourceTreeHash,
    sourcePath: match.sourcePath,
  };
  return cloneAndFreeze({
    ...manifest,
    selectionManifestHash: checksumBytes(stableStringify(manifest)),
  });
}
