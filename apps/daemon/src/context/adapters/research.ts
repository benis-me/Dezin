import {
  ContextIntegrityError,
  type ResourceContextAdapter,
} from "../context-types.ts";
import {
  readOwnedResourceBytes,
  resolveSnapshot,
  snapshotBytes,
} from "./file.ts";

/** Immutable Research bundles use the shared payload protocol and untrusted boundary. */
export const researchResourceAdapter: ResourceContextAdapter = {
  kind: "research",
  async snapshot(input) {
    if (input.kind !== "research" || input.source.type !== "owned-file") {
      throw new ContextIntegrityError("Research Resource adapter requires an owned-file source");
    }
    const bytes = await readOwnedResourceBytes(input.workspaceRoot, input.source.path);
    return snapshotBytes(input, bytes, input.source.mimeType);
  },
  resolve(input) {
    return resolveSnapshot(input, "research");
  },
};
