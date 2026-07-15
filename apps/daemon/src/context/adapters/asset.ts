import {
  ContextIntegrityError,
  type ResourceContextAdapter,
} from "../context-types.ts";
import { readOwnedResourceBytes, resolveSnapshot, snapshotBytes } from "./file.ts";

export const assetResourceAdapter: ResourceContextAdapter = {
  kind: "asset",
  async snapshot(input) {
    if (input.kind !== "asset" || input.source.type !== "owned-file") {
      throw new ContextIntegrityError("Asset Resource adapter requires an owned-file source");
    }
    const bytes = await readOwnedResourceBytes(input.workspaceRoot, input.source.path);
    return snapshotBytes(input, bytes, input.source.mimeType);
  },
  resolve(input) {
    return resolveSnapshot(input, "asset");
  },
};
