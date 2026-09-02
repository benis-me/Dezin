import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { mkdir, open as openFile, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  SHARINGAN_BOOTSTRAP_STATE_PROTOCOL,
  WorkspacePointerConflictError,
  WorkspaceRevisionConflictError,
  normalizeSharinganBootstrapState,
  type SharinganBootstrapState,
  type Store,
} from "@dezin/core";
import { cloneAndFreeze } from "./canonical-json.ts";
import {
  decodeSharinganCaptureResourceBundle,
  encodeSharinganCaptureResourceBundle,
  validateSharinganCaptureResourceBundleSemantics,
  type SharinganCaptureBundleFileInput,
  type SharinganCaptureBundleScope,
  type SharinganCaptureBundleSourceIdentity,
  type SharinganCaptureBundleExporterIdentity,
} from "./sharingan-capture-resource-bundle.ts";
import {
  exportExactSharinganProjectCapture,
} from "./sharingan-exact-capture-export.ts";
import {
  ensureCaptured,
  capturedPageCount,
  type SharinganOpen,
} from "./sharingan-handler.ts";
import {
  readVerifiedExactResourceRevisionPayload,
} from "./sharingan-resource-revision-payload.ts";
import {
  writeSharinganResourceRevisionPayload,
} from "./sharingan-resource-revision-writer.ts";
import {
  beginResourceMaterializationPayloadIntent,
  completeResourceMaterializationPayloadIntent,
  rollbackResourceMaterializationPayloadIntent,
} from "./resource-materialization-intent.ts";

const MAX_CAPTURE_OUTPUT_BYTES = 48 * 1024 * 1024;
const STATE_DIRECTORY = "sharingan-bootstrap";
const STATE_TEMP_PREFIX = ".sharingan-bootstrap-";
const BOOTSTRAP_PROTOCOL = "dezin.sharingan-project-bootstrap.v1" as const;

export interface SharinganBootstrapCaptureRequest {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly sourceUrl: string;
  readonly scope: SharinganCaptureBundleScope;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
}

export interface SharinganBootstrapCaptureResult {
  readonly protocol: "dezin.sharingan-bootstrap-capture.v1";
  readonly exporter: SharinganCaptureBundleExporterIdentity;
  readonly source: SharinganCaptureBundleSourceIdentity;
  readonly files: readonly SharinganCaptureBundleFileInput[];
}

export interface SharinganBootstrapCapturePort {
  capture(request: SharinganBootstrapCaptureRequest): Promise<SharinganBootstrapCaptureResult>;
}

export interface SharinganBootstrapReady {
  readonly status: "ready";
  readonly projectId: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly readyGraphRevision: number;
  readonly readySnapshotId: string;
  readonly initialTurn: Readonly<{
    turnId: string;
    graphRevision: number;
    snapshotId: string;
  }> | null;
  readonly context: Readonly<{
    kind: "resource";
    id: string;
    resourceKind: "sharingan-capture";
    revisionId: string;
  }>;
}

export interface SharinganBootstrapPort {
  register(projectId: string, initialTurnId: string | null): Promise<SharinganBootstrapState>;
  ensure(projectId: string, signal: AbortSignal): Promise<SharinganBootstrapReady>;
  getState(projectId: string): Promise<SharinganBootstrapState | null>;
  /**
   * Close process-local admission and stop capture work while preserving
   * durable recovery state. Admission remains closed until `resume()` so a
   * Project deletion cannot race a replacement capture.
   */
  cancel(projectId: string): Promise<void>;
  /** Reopen admission when a deletion fails before its database commit. */
  resume(projectId: string): void;
  remove(projectId: string): Promise<void>;
}

export class SharinganBootstrapError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly state: SharinganBootstrapState | null;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      state?: SharinganBootstrapState | null;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "SharinganBootstrapError";
    this.code = code;
    this.retryable = options.retryable ?? true;
    this.state = options.state ?? null;
    if (options.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "The source page could not be captured.";
  return message.slice(0, 4_096);
}

function statePath(dataDir: string, projectId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(projectId)) {
    throw new SharinganBootstrapError(
      "SHARINGAN_BOOTSTRAP_PROJECT_INVALID",
      "Sharingan bootstrap Project identity is invalid",
      { retryable: false },
    );
  }
  return join(dataDir, STATE_DIRECTORY, `${projectId}.json`);
}

async function readState(dataDir: string, projectId: string): Promise<SharinganBootstrapState | null> {
  const path = statePath(dataDir, projectId);
  if (!existsSync(path)) return null;
  try {
    return normalizeSharinganBootstrapState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new SharinganBootstrapError(
      "SHARINGAN_BOOTSTRAP_STATE_INVALID",
      "Sharingan bootstrap recovery state is invalid",
      { retryable: false, cause: error },
    );
  }
}

async function writeState(
  dataDir: string,
  unsafeState: SharinganBootstrapState,
): Promise<SharinganBootstrapState> {
  const state = normalizeSharinganBootstrapState(unsafeState);
  const path = statePath(dataDir, state.projectId);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `${STATE_TEMP_PREFIX}${randomUUID()}.json`);
  let handle: Awaited<ReturnType<typeof openFile>> | null = null;
  try {
    handle = await openFile(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    const directoryHandle = await openFile(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
  return state;
}

async function removeState(dataDir: string, projectId: string): Promise<void> {
  const path = statePath(dataDir, projectId);
  const directory = dirname(path);
  await rm(path, { force: true });
  if (!existsSync(directory)) return;
  const directoryHandle = await openFile(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function bootstrapScope(input: {
  projectId: string;
  workspaceId: string;
  resourceId: string;
  nodeId: string;
  sourceUrl: string;
}): SharinganCaptureBundleScope {
  const inputHash = sha256([
    BOOTSTRAP_PROTOCOL,
    input.projectId,
    input.workspaceId,
    input.resourceId,
    input.nodeId,
    input.sourceUrl,
  ].join("\0"));
  return Object.freeze({
    projectId: input.projectId,
    captureId: `sharingan-capture-${inputHash.slice(0, 32)}`,
    inputHash,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    nodeId: input.nodeId,
    title: "Source capture",
    resourceKind: "sharingan-capture",
  });
}

function exactCaptureResult(
  raw: SharinganBootstrapCaptureResult,
  request: SharinganBootstrapCaptureRequest,
): SharinganBootstrapCaptureResult {
  if (!raw || raw.protocol !== "dezin.sharingan-bootstrap-capture.v1"
    || raw.exporter?.id !== "dezin-sharingan-capture" || raw.exporter.version !== 1
    || raw.source?.requestedUrl !== request.sourceUrl
    || !Array.isArray(raw.files) || raw.files.length === 0) {
    throw new SharinganBootstrapError(
      "SHARINGAN_BOOTSTRAP_CAPTURE_INVALID",
      "Sharingan bootstrap capture substituted its exact source or exporter identity",
    );
  }
  return raw;
}

async function verifiedExistingRevision(input: {
  store: Store;
  dataDir: string;
  projectId: string;
  resourceId: string;
  revisionId: string;
  sourceUrl: string;
  signal: AbortSignal;
}): Promise<boolean> {
  const revision = input.store.workspace.getResourceRevisionForProject(
    input.projectId,
    input.resourceId,
    input.revisionId,
  );
  if (!revision || revision.provenance.kind !== "sharingan-project-bootstrap"
    || revision.provenance.protocol !== BOOTSTRAP_PROTOCOL
    || revision.provenance.projectId !== input.projectId
    || revision.provenance.sourceUrl !== input.sourceUrl) {
    return false;
  }
  const exact = await readVerifiedExactResourceRevisionPayload({
    store: input.store,
    dataDir: input.dataDir,
    projectId: input.projectId,
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    signal: input.signal,
  });
  if (exact.descriptor.resourceKind !== "sharingan-capture"
    || exact.descriptor.mimeType !== "application/json") {
    return false;
  }
  const decoded = decodeSharinganCaptureResourceBundle(exact.bytes);
  await validateSharinganCaptureResourceBundleSemantics({
    source: decoded.source,
    files: decoded.files,
    signal: input.signal,
  });
  return decoded.source.requestedUrl === input.sourceUrl
    && decoded.scope.workspaceId === exact.resource.workspaceId
    && decoded.scope.resourceId === input.resourceId;
}

function exactCapturePublicationAnchor(input: {
  store: Store;
  projectId: string;
  workspaceId: string;
  resourceId: string;
  revisionId: string;
}): { graphRevision: number; snapshotId: string } {
  const anchors = input.store.workspace.listSnapshots(input.projectId).filter((snapshot) => (
    snapshot.workspaceId === input.workspaceId
    && snapshot.provenance.kind === "resource-publication"
    && snapshot.provenance.resourceRevisionId === input.revisionId
    && snapshot.resourceRevisions[input.resourceId] === input.revisionId
  ));
  if (anchors.length !== 1) {
    throw new SharinganBootstrapError(
      "SHARINGAN_BOOTSTRAP_PUBLICATION_ANCHOR_INVALID",
      "Sharingan capture has no unique authoritative publication Snapshot",
      { retryable: false },
    );
  }
  return {
    graphRevision: anchors[0]!.graphRevision,
    snapshotId: anchors[0]!.id,
  };
}

function readyResult(input: {
  projectId: string;
  workspaceId: string;
  resourceId: string;
  revisionId: string;
  readyGraphRevision: number;
  readySnapshotId: string;
  initialTurnId: string | null;
  bootstrapBaseGraphRevision: number | null;
  bootstrapBaseSnapshotId: string | null;
}): SharinganBootstrapReady {
  return Object.freeze({
    status: "ready",
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    readyGraphRevision: input.readyGraphRevision,
    readySnapshotId: input.readySnapshotId,
    initialTurn: input.initialTurnId !== null
      && input.bootstrapBaseGraphRevision !== null
      && input.bootstrapBaseSnapshotId !== null
      ? Object.freeze({
          turnId: input.initialTurnId,
          graphRevision: input.bootstrapBaseGraphRevision,
          snapshotId: input.bootstrapBaseSnapshotId,
        })
      : null,
    context: Object.freeze({
      kind: "resource",
      id: input.resourceId,
      resourceKind: "sharingan-capture",
      revisionId: input.revisionId,
    }),
  });
}

export function createSharinganBootstrapService(options: {
  store: Store;
  dataDir: string;
  capture: SharinganBootstrapCapturePort;
  beforeCapture?: (projectId: string, signal: AbortSignal) => void | Promise<void>;
  /** Deterministic durability checkpoint used by crash/failure tests. */
  beforeStateWrite?: (state: SharinganBootstrapState) => void | Promise<void>;
  /** Daemon-lifetime owner signal. Individual HTTP callers never own capture. */
  operationSignal?: AbortSignal;
  now?: () => number;
}): SharinganBootstrapPort {
  const inFlight = new Map<string, {
    promise: Promise<SharinganBootstrapReady>;
    controller: AbortController;
  }>();
  const registrationFlights = new Map<string, Promise<SharinganBootstrapState>>();
  const blockedProjects = new Set<string>();
  const now = options.now ?? Date.now;
  const assertAdmitted = (projectId: string): void => {
    if (!blockedProjects.has(projectId)) return;
    throw new SharinganBootstrapError(
      "SHARINGAN_BOOTSTRAP_PROJECT_DELETING",
      "Sharingan bootstrap is unavailable while its Project is being removed",
      { retryable: false },
    );
  };
  const persistState = async (
    state: SharinganBootstrapState,
  ): Promise<SharinganBootstrapState> => {
    const normalized = normalizeSharinganBootstrapState(state);
    await options.beforeStateWrite?.(normalized);
    return writeState(options.dataDir, normalized);
  };

  const writeReadyHint = async (
    projectId: string,
    sourceUrl: string,
    previous: SharinganBootstrapState | null,
    result: SharinganBootstrapReady,
  ): Promise<void> => {
    // The immutable Resource row + active Snapshot are authoritative. The
    // fsynced JSON state is a recovery/UX hint, so a post-publication state
    // write failure must not misreport a committed capture as failed.
    await persistState({
      protocol: SHARINGAN_BOOTSTRAP_STATE_PROTOCOL,
      projectId,
      sourceUrl,
      initialTurnId: previous?.initialTurnId ?? null,
      bootstrapBaseGraphRevision: previous?.bootstrapBaseGraphRevision ?? null,
      bootstrapBaseSnapshotId: previous?.bootstrapBaseSnapshotId ?? null,
      status: "ready",
      attempt: previous?.attempt ?? 0,
      updatedAt: now(),
      resourceId: result.resourceId,
      revisionId: result.revisionId,
      readyGraphRevision: result.readyGraphRevision,
      readySnapshotId: result.readySnapshotId,
    }).catch(() => {});
  };

  const run = async (projectId: string, signal: AbortSignal): Promise<SharinganBootstrapReady> => {
    signal.throwIfAborted();
    const project = options.store.getProject(projectId);
    if (!project || project.mode !== "standard" || !project.sharingan
      || project.archivedAt !== null || typeof project.sourceUrl !== "string") {
      throw new SharinganBootstrapError(
        "SHARINGAN_BOOTSTRAP_PROJECT_INVALID",
        "Sharingan bootstrap requires one active Standard Sharingan Project",
        { retryable: false },
      );
    }
    let previous = await readState(options.dataDir, projectId);
    if (previous !== null && previous.sourceUrl !== project.sourceUrl) {
      throw new SharinganBootstrapError(
        "SHARINGAN_BOOTSTRAP_SOURCE_CHANGED",
        "Sharingan bootstrap source identity changed after registration",
        { retryable: false, state: previous },
      );
    }
    let attempt = (previous?.attempt ?? 0) + 1;
    let baseGraphRevision = previous?.bootstrapBaseGraphRevision ?? null;
    let baseSnapshotId = previous?.bootstrapBaseSnapshotId ?? null;
    const persistFailure = async (error: unknown): Promise<SharinganBootstrapState> => {
      const classified = error instanceof SharinganBootstrapError
        ? error
        : null;
      return persistState({
        protocol: SHARINGAN_BOOTSTRAP_STATE_PROTOCOL,
        projectId,
        sourceUrl: project.sourceUrl!,
        initialTurnId: previous?.initialTurnId ?? null,
        bootstrapBaseGraphRevision: baseGraphRevision,
        bootstrapBaseSnapshotId: baseSnapshotId,
        status: "failed",
        attempt,
        updatedAt: now(),
        error: {
          code: classified?.code ?? "SHARINGAN_BOOTSTRAP_CAPTURE_FAILED",
          message: boundedErrorMessage(error),
          retryable: classified?.retryable ?? true,
        },
      });
    };

    try {
      await options.beforeCapture?.(projectId, signal);
      signal.throwIfAborted();
      options.store.workspace.ensureSharinganWorkspaceFoundation(projectId);

      const activeCaptures = options.store.workspace.listResources(projectId)
        .filter((resource) => resource.kind === "sharingan-capture" && resource.archivedAt === null);
      if (activeCaptures.length > 1) {
        throw new SharinganBootstrapError(
          "SHARINGAN_BOOTSTRAP_RESOURCE_AMBIGUOUS",
          "Sharingan Project has more than one active capture Resource",
          { retryable: false },
        );
      }

      let resource = activeCaptures[0] ?? null;
      if (resource !== null && resource.headRevisionId !== null) {
        if (!await verifiedExistingRevision({
          store: options.store,
          dataDir: options.dataDir,
          projectId,
          resourceId: resource.id,
          revisionId: resource.headRevisionId,
          sourceUrl: project.sourceUrl,
          signal,
        })) {
          throw new SharinganBootstrapError(
            "SHARINGAN_BOOTSTRAP_REVISION_INVALID",
            "Sharingan bootstrap Resource Head is not the exact captured source",
            { retryable: false },
          );
        }
        const anchor = exactCapturePublicationAnchor({
          store: options.store,
          projectId,
          workspaceId: resource.workspaceId,
          resourceId: resource.id,
          revisionId: resource.headRevisionId,
        });
        if (previous?.status === "ready"
          && (previous.resourceId !== resource.id
            || previous.revisionId !== resource.headRevisionId
            || previous.readyGraphRevision !== anchor.graphRevision
            || previous.readySnapshotId !== anchor.snapshotId)) {
          throw new SharinganBootstrapError(
            "SHARINGAN_BOOTSTRAP_STATE_ANCHOR_INVALID",
            "Sharingan bootstrap ready state does not match its authoritative publication Snapshot",
            { retryable: false, state: previous },
          );
        }
        const result = readyResult({
          projectId,
          workspaceId: resource.workspaceId,
          resourceId: resource.id,
          revisionId: resource.headRevisionId,
          readyGraphRevision: anchor.graphRevision,
          readySnapshotId: anchor.snapshotId,
          initialTurnId: previous?.initialTurnId ?? null,
          bootstrapBaseGraphRevision: baseGraphRevision,
          bootstrapBaseSnapshotId: baseSnapshotId,
        });
        await writeReadyHint(projectId, project.sourceUrl, previous, result);
        return result;
      }

      if (resource !== null) {
        const candidates = options.store.workspace.listResourceRevisions(projectId, resource.id);
        const reusable: typeof candidates = [];
        for (const revision of candidates) {
          if (await verifiedExistingRevision({
            store: options.store,
            dataDir: options.dataDir,
            projectId,
            resourceId: resource.id,
            revisionId: revision.id,
            sourceUrl: project.sourceUrl,
            signal,
          })) reusable.push(revision);
        }
        if (reusable.length > 1) {
          throw new SharinganBootstrapError(
            "SHARINGAN_BOOTSTRAP_REVISION_AMBIGUOUS",
            "Sharingan bootstrap has more than one recoverable capture Revision",
            { retryable: false },
          );
        }
        if (reusable.length === 1) {
          const current = options.store.workspace.getWorkspace(projectId)!;
          options.store.workspace.publishResourceRevisionForProject(
            projectId,
            resource.id,
            reusable[0]!.id,
            {
              expectedHeadRevisionId: null,
              expectedSnapshotId: current.activeSnapshotId,
              reason: "Recover immutable Sharingan source capture",
            },
          );
          const anchor = exactCapturePublicationAnchor({
            store: options.store,
            projectId,
            workspaceId: resource.workspaceId,
            resourceId: resource.id,
            revisionId: reusable[0]!.id,
          });
          const result = readyResult({
            projectId,
            workspaceId: resource.workspaceId,
            resourceId: resource.id,
            revisionId: reusable[0]!.id,
            readyGraphRevision: anchor.graphRevision,
            readySnapshotId: anchor.snapshotId,
            initialTurnId: previous?.initialTurnId ?? null,
            bootstrapBaseGraphRevision: baseGraphRevision,
            bootstrapBaseSnapshotId: baseSnapshotId,
          });
          await writeReadyHint(projectId, project.sourceUrl, previous, result);
          return result;
        }
      }

      if (resource === null) {
        let created: ReturnType<Store["workspace"]["createResourceForProject"]> | null = null;
        for (let retry = 0; retry < 3 && created === null; retry += 1) {
          const current = options.store.workspace.getWorkspace(projectId)!;
          const graph = options.store.workspace.getGraph(projectId);
          baseGraphRevision = graph.revision;
          baseSnapshotId = current.activeSnapshotId;
          previous = await persistState({
            protocol: SHARINGAN_BOOTSTRAP_STATE_PROTOCOL,
            projectId,
            sourceUrl: project.sourceUrl,
            initialTurnId: previous?.initialTurnId ?? null,
            bootstrapBaseGraphRevision: baseGraphRevision,
            bootstrapBaseSnapshotId: baseSnapshotId,
            status: "capturing",
            attempt,
            updatedAt: now(),
          });
          try {
            created = options.store.workspace.createResourceForProject(projectId, {
              kind: "sharingan-capture",
              title: "Source capture",
              defaultPinPolicy: "pin-current",
              baseGraphRevision: graph.revision,
              expectedSnapshotId: current.activeSnapshotId,
            });
          } catch (error) {
            if (!(error instanceof WorkspaceRevisionConflictError)
              && !(error instanceof WorkspacePointerConflictError)) {
              throw error;
            }
            if (retry === 2) throw error;
          }
        }
        resource = created!.resource;
      } else {
        const current = options.store.workspace.getWorkspace(projectId)!;
        if (baseGraphRevision === null) baseGraphRevision = current.graphRevision;
        if (baseSnapshotId === null) baseSnapshotId = current.activeSnapshotId;
        previous = await persistState({
          protocol: SHARINGAN_BOOTSTRAP_STATE_PROTOCOL,
          projectId,
          sourceUrl: project.sourceUrl,
          initialTurnId: previous?.initialTurnId ?? null,
          bootstrapBaseGraphRevision: baseGraphRevision,
          bootstrapBaseSnapshotId: baseSnapshotId,
          status: "capturing",
          attempt,
          updatedAt: now(),
        });
      }
      const graph = options.store.workspace.getGraph(projectId);
      const node = graph.nodes.find((candidate) => (
        candidate.kind === "resource" && candidate.resourceId === resource!.id
      ));
      if (!node) {
        throw new SharinganBootstrapError(
          "SHARINGAN_BOOTSTRAP_RESOURCE_INVALID",
          "Sharingan bootstrap Resource node is unavailable",
          { retryable: false },
        );
      }

      const scope = bootstrapScope({
        projectId,
        workspaceId: resource.workspaceId,
        resourceId: resource.id,
        nodeId: node.id,
        sourceUrl: project.sourceUrl,
      });
      const captureRequest: SharinganBootstrapCaptureRequest = Object.freeze({
        projectId,
        workspaceId: resource.workspaceId,
        resourceId: resource.id,
        sourceUrl: project.sourceUrl,
        scope,
        maxOutputBytes: MAX_CAPTURE_OUTPUT_BYTES,
        signal,
      });
      const capture = exactCaptureResult(await options.capture.capture(captureRequest), captureRequest);
      await validateSharinganCaptureResourceBundleSemantics({
        source: capture.source,
        files: capture.files,
        signal,
      });
      const encoded = encodeSharinganCaptureResourceBundle({
        scope,
        source: capture.source,
        exporter: capture.exporter,
        files: capture.files,
        maxOutputBytes: MAX_CAPTURE_OUTPUT_BYTES,
      });
      const decoded = decodeSharinganCaptureResourceBundle(encoded.bytes);
      const semanticReceipt = await validateSharinganCaptureResourceBundleSemantics({
        source: decoded.source,
        files: decoded.files,
        signal,
      });
      const revisionId = randomUUID();
      const payloadIntent = beginResourceMaterializationPayloadIntent({
        dataDir: options.dataDir,
        projectId,
        workspaceId: resource.workspaceId,
        resourceId: resource.id,
        revisionId,
        idempotencyKey: null,
        createdAt: now(),
      });
      let snapshot: Awaited<ReturnType<typeof writeSharinganResourceRevisionPayload>> | null = null;
      try {
        snapshot = await writeSharinganResourceRevisionPayload({
          dataDir: options.dataDir,
          workspaceId: resource.workspaceId,
          resourceId: resource.id,
          revisionId,
          bytes: encoded.bytes,
          signal,
        });
        const revision = options.store.workspace.createResourceRevisionCandidateForProject(
          projectId,
          resource.id,
          {
            revisionId,
            parentRevisionId: null,
            manifestPath: snapshot.manifestPath,
            summary: `Sharingan Capture: ${project.sourceUrl} — ${decoded.files.length} exact files`,
            metadata: {
              format: encoded.bundle.protocol,
              version: 3,
              fileCount: decoded.files.length,
              sourceUrl: capture.source.finalUrl,
              mimeType: snapshot.mimeType,
              byteLength: snapshot.byteSize,
              payloadChecksum: snapshot.payloadChecksum,
              semanticReceipt,
            },
            checksum: snapshot.checksum,
            provenance: {
              kind: "sharingan-project-bootstrap",
              protocol: BOOTSTRAP_PROTOCOL,
              projectId,
              sourceUrl: project.sourceUrl,
              exporterId: capture.exporter.id,
              exporterVersion: capture.exporter.version,
              requestedUrl: capture.source.requestedUrl,
              finalUrl: capture.source.finalUrl,
              capturedAt: capture.source.capturedAt,
            },
          },
        );
        // Once the immutable row exists, startup recovery must retain the exact
        // payload. A crash before publication is recovered through the
        // unpublished-candidate path above.
        completeResourceMaterializationPayloadIntent(options.dataDir, payloadIntent);
        const current = options.store.workspace.getWorkspace(projectId)!;
        options.store.workspace.publishResourceRevisionForProject(
          projectId,
          resource.id,
          revision.id,
          {
            expectedHeadRevisionId: null,
            expectedSnapshotId: current.activeSnapshotId,
            reason: "Publish immutable Sharingan source capture",
          },
        );
      } catch (error) {
        const row = options.store.workspace.getResourceRevisionForProject(
          projectId,
          resource.id,
          revisionId,
        );
        if (row === null) {
          rollbackResourceMaterializationPayloadIntent(options.dataDir, payloadIntent);
        } else {
          completeResourceMaterializationPayloadIntent(options.dataDir, payloadIntent);
        }
        throw error;
      }
      const anchor = exactCapturePublicationAnchor({
        store: options.store,
        projectId,
        workspaceId: resource.workspaceId,
        resourceId: resource.id,
        revisionId,
      });
      const result = readyResult({
        projectId,
        workspaceId: resource.workspaceId,
        resourceId: resource.id,
        revisionId,
        readyGraphRevision: anchor.graphRevision,
        readySnapshotId: anchor.snapshotId,
        initialTurnId: previous?.initialTurnId ?? null,
        bootstrapBaseGraphRevision: baseGraphRevision,
        bootstrapBaseSnapshotId: baseSnapshotId,
      });
      await writeReadyHint(projectId, project.sourceUrl, {
        ...previous!,
        attempt,
      }, result);
      return result;
    } catch (error) {
      if (signal.aborted) {
        await persistState({
          protocol: SHARINGAN_BOOTSTRAP_STATE_PROTOCOL,
          projectId,
          sourceUrl: project.sourceUrl,
          initialTurnId: previous?.initialTurnId ?? null,
          bootstrapBaseGraphRevision: baseGraphRevision,
          bootstrapBaseSnapshotId: baseSnapshotId,
          status: "pending",
          attempt,
          updatedAt: now(),
        }).catch(() => {});
        throw signal.reason ?? error;
      }
      const state = await persistFailure(error);
      throw new SharinganBootstrapError(
        state.status === "failed" ? state.error.code : "SHARINGAN_BOOTSTRAP_CAPTURE_FAILED",
        state.status === "failed" ? state.error.message : boundedErrorMessage(error),
        {
          retryable: state.status === "failed" ? state.error.retryable : true,
          state,
          cause: error,
        },
      );
    }
  };

  const registerOnce = async (
    projectId: string,
    initialTurnId: string | null,
  ): Promise<SharinganBootstrapState> => {
    assertAdmitted(projectId);
    const project = options.store.getProject(projectId);
    if (!project || project.mode !== "standard" || !project.sharingan
      || typeof project.sourceUrl !== "string") {
      throw new SharinganBootstrapError(
        "SHARINGAN_BOOTSTRAP_PROJECT_INVALID",
        "Sharingan bootstrap registration requires one Standard Sharingan Project",
        { retryable: false },
      );
    }
    if (initialTurnId !== null
      && !/^turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(initialTurnId)) {
      throw new SharinganBootstrapError(
        "SHARINGAN_BOOTSTRAP_INITIAL_TURN_INVALID",
        "Sharingan bootstrap initial turn identity is invalid",
        { retryable: false },
      );
    }
    const existing = await readState(options.dataDir, projectId);
    assertAdmitted(projectId);
    if (existing !== null && (existing.sourceUrl !== project.sourceUrl
      || (existing.initialTurnId !== null && existing.initialTurnId !== initialTurnId))) {
      throw new SharinganBootstrapError(
        "SHARINGAN_BOOTSTRAP_REGISTRATION_CONFLICT",
        "Sharingan bootstrap registration conflicts with durable Project identity",
        { retryable: false, state: existing },
      );
    }
    if (existing !== null) {
      if (existing.initialTurnId === initialTurnId) return existing;
      return persistState({
        ...existing,
        initialTurnId,
        updatedAt: now(),
      });
    }
    return persistState({
      protocol: SHARINGAN_BOOTSTRAP_STATE_PROTOCOL,
      projectId,
      sourceUrl: project.sourceUrl,
      initialTurnId,
      bootstrapBaseGraphRevision: null,
      bootstrapBaseSnapshotId: null,
      status: "pending",
      attempt: 0,
      updatedAt: now(),
    });
  };

  return Object.freeze({
    async register(
      projectId: string,
      initialTurnId: string | null,
    ): Promise<SharinganBootstrapState> {
      assertAdmitted(projectId);
      const previous = registrationFlights.get(projectId);
      const runRegistration = previous === undefined
        ? Promise.resolve()
        : previous.then(() => undefined, () => undefined);
      let tracked!: Promise<SharinganBootstrapState>;
      tracked = runRegistration.then(() => registerOnce(projectId, initialTurnId)).finally(() => {
        if (registrationFlights.get(projectId) === tracked) {
          registrationFlights.delete(projectId);
        }
      });
      registrationFlights.set(projectId, tracked);
      return tracked;
    },
    ensure(projectId: string, signal: AbortSignal): Promise<SharinganBootstrapReady> {
      try {
        assertAdmitted(projectId);
      } catch (error) {
        return Promise.reject(error);
      }
      let operation = inFlight.get(projectId);
      if (!operation) {
        const controller = new AbortController();
        const operationSignal = options.operationSignal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, options.operationSignal]);
        const registration = registrationFlights.get(projectId);
        const promise = (registration === undefined
          ? run(projectId, operationSignal)
          : registration.then(() => run(projectId, operationSignal))).finally(() => {
          if (inFlight.get(projectId)?.promise === promise) inFlight.delete(projectId);
        });
        operation = { promise, controller };
        inFlight.set(projectId, operation);
      }
      if (signal.aborted) return Promise.reject(signal.reason);
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const onAbort = (): void => rejectAbort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      return Promise.race([operation.promise, aborted]).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    },
    getState(projectId: string): Promise<SharinganBootstrapState | null> {
      return readState(options.dataDir, projectId);
    },
    async cancel(projectId: string): Promise<void> {
      blockedProjects.add(projectId);
      const operation = inFlight.get(projectId);
      operation?.controller.abort(new Error("Sharingan Project was removed"));
      const registration = registrationFlights.get(projectId);
      await Promise.all([
        operation?.promise.catch(() => {}),
        registration?.then(() => undefined, () => undefined),
      ]);
    },
    resume(projectId: string): void {
      blockedProjects.delete(projectId);
    },
    async remove(projectId: string): Promise<void> {
      blockedProjects.add(projectId);
      const operation = inFlight.get(projectId);
      operation?.controller.abort(new Error("Sharingan Project was removed"));
      const registration = registrationFlights.get(projectId);
      await Promise.all([
        operation?.promise.catch(() => {}),
        registration?.then(() => undefined, () => undefined),
      ]);
      await removeState(options.dataDir, projectId);
    },
  });
}

export function createProductionSharinganBootstrapCapturePort(input: {
  store: Store;
  dataDir: string;
  sharinganOpen?: SharinganOpen;
}): SharinganBootstrapCapturePort {
  return Object.freeze({
    async capture(
      request: SharinganBootstrapCaptureRequest,
    ): Promise<SharinganBootstrapCaptureResult> {
      const phase = await ensureCaptured(request.projectId, input.dataDir, request.sourceUrl, {
        signal: request.signal,
        keepSessionForProbe: false,
        ...(input.sharinganOpen === undefined ? {} : { open: input.sharinganOpen }),
      });
      if ((phase !== "captured" && phase !== "probing")
        || capturedPageCount(request.projectId) < 1) {
        throw new SharinganBootstrapError(
          "SHARINGAN_BOOTSTRAP_CAPTURE_FAILED",
          phase === "login-required"
            ? "Sharingan source capture is waiting for login. Complete login and retry."
            : `Sharingan source capture did not complete (${phase}).`,
        );
      }
      const exact = await exportExactSharinganProjectCapture({
        store: input.store,
        dataDir: input.dataDir,
        projectId: request.projectId,
        workspaceId: request.workspaceId,
        resourceId: request.resourceId,
        scope: request.scope,
        maxOutputBytes: request.maxOutputBytes,
        signal: request.signal,
      });
      return cloneAndFreeze({
        protocol: "dezin.sharingan-bootstrap-capture.v1",
        ...exact,
      });
    },
  });
}
