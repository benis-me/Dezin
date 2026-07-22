import {
  ContextIntegrityError,
  type ResourceContextAdapter,
} from "../context-types.ts";
import {
  readOwnedResourceBytes,
  resolveSnapshot,
  snapshotBytes,
} from "./file.ts";

/**
 * The Context representation is only a read-only description of the exact
 * Capture Revision. Artifact preparation separately materializes and fences the
 * same bytes inside the candidate worktree before Agent and QA access.
 */
export const sharinganCaptureResourceAdapter: ResourceContextAdapter = {
  kind: "sharingan-capture",
  async snapshot(input) {
    if (input.kind !== "sharingan-capture" || input.source.type !== "owned-file") {
      throw new ContextIntegrityError("Sharingan Capture adapter requires an owned-file source");
    }
    const bytes = await readOwnedResourceBytes(input.workspaceRoot, input.source.path);
    return snapshotBytes(input, bytes, input.source.mimeType);
  },
  resolve(input) {
    return resolveSnapshot(input, "sharingan-capture");
  },
};
