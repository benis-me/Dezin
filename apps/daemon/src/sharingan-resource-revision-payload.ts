import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  WorkspaceResourceNotFoundError,
  WorkspaceResourceOwnershipError,
  type Resource,
  type ResourceRevision,
  type Store,
} from "../../../packages/core/src/index.ts";
import {
  ResourceRevisionPayloadError,
  resolveResourceRevisionPayloadDescriptor,
  verifyResourceRevisionPayload,
  type ResourceRevisionPayloadDescriptor,
} from "./resource-revision-payload.ts";

export class VerifiedResourceRevisionPayloadError extends Error {
  readonly status: 404 | 422;

  constructor(status: 404 | 422, message: string) {
    super(message);
    this.name = "VerifiedResourceRevisionPayloadError";
    this.status = status;
  }
}

function fail(status: 404 | 422, message: string): never {
  throw new VerifiedResourceRevisionPayloadError(status, message);
}

export interface VerifiedExactResourceRevisionPayload {
  resource: Resource;
  revision: ResourceRevision;
  observed: { headRevisionId: string | null; snapshotId: string };
  descriptor: ResourceRevisionPayloadDescriptor;
  bytes: Buffer;
}

/**
 * Resolves one exact project-owned Resource Revision, copies it through the
 * immutable payload verifier, and returns only bytes from that private copy.
 * Sharingan recovery uses this instead of importing the retired Viewer stack.
 */
export async function readVerifiedExactResourceRevisionPayload(input: {
  store: Store;
  dataDir: string;
  projectId: string;
  resourceId: string;
  revisionId: string;
  signal?: AbortSignal;
}): Promise<VerifiedExactResourceRevisionPayload> {
  input.signal?.throwIfAborted();
  if (!input.store.getProject(input.projectId)
    || !input.store.workspace.getWorkspace(input.projectId)) {
    return fail(404, "Resource Revision was not found");
  }
  let facts: ReturnType<Store["workspace"]["getResourceRevisionViewFactsForProject"]>;
  try {
    facts = input.store.workspace.getResourceRevisionViewFactsForProject(
      input.projectId,
      input.resourceId,
      input.revisionId,
    );
  } catch (error) {
    if (error instanceof WorkspaceResourceNotFoundError
      || error instanceof WorkspaceResourceOwnershipError) {
      return fail(404, "Resource Revision was not found");
    }
    throw error;
  }
  if (facts === null) return fail(404, "Resource Revision was not found");
  const { resource, revision } = facts;
  if (revision.workspaceId !== resource.workspaceId || revision.resourceId !== resource.id) {
    return fail(404, "Resource Revision was not found");
  }

  let descriptor: ResourceRevisionPayloadDescriptor;
  try {
    descriptor = resolveResourceRevisionPayloadDescriptor({
      store: input.store,
      dataDir: input.dataDir,
      workspaceId: resource.workspaceId,
      resourceRevisionId: revision.id,
      expectedResourceId: resource.id,
    });
  } catch (error) {
    if (error instanceof ResourceRevisionPayloadError) {
      return fail(422, `Resource Revision payload is unavailable: ${error.message}`);
    }
    throw error;
  }
  if (descriptor.resourceKind !== resource.kind
    || descriptor.resourceRevisionId !== revision.id
    || descriptor.manifestPath !== revision.manifestPath
    || descriptor.manifestChecksum !== revision.checksum) {
    return fail(422, "Resource Revision payload identity is invalid");
  }

  const verificationRoot = await mkdtemp(join(input.dataDir, ".sharingan-resource-read-"));
  const destination = join(verificationRoot, "payload.bin");
  try {
    try {
      await verifyResourceRevisionPayload(input.dataDir, descriptor, {
        destination,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      if (error instanceof ResourceRevisionPayloadError) {
        return fail(
          422,
          `Resource Revision payload failed integrity verification: ${error.message}`,
        );
      }
      throw error;
    }
    input.signal?.throwIfAborted();
    const bytes = await readFile(destination);
    if (bytes.byteLength !== descriptor.byteLength) {
      return fail(422, "Resource Revision verified payload length changed");
    }
    return {
      resource,
      revision,
      observed: { headRevisionId: resource.headRevisionId, snapshotId: facts.snapshotId },
      descriptor,
      bytes,
    };
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }
}
