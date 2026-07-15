import {
  BlockedContextError,
  type ResourceContextAdapter,
  type ResourceKind,
} from "../context-types.ts";
import { assetResourceAdapter } from "./asset.ts";
import { effectResourceAdapter } from "./effect.ts";
import { externalReferenceAdapter } from "./external-reference.ts";
import { fileResourceAdapter } from "./file.ts";
import { moodboardResourceAdapter } from "./moodboard.ts";

const REGISTERABLE_RESOURCE_KINDS = new Set<ResourceContextAdapter["kind"]>([
  "moodboard",
  "effect",
  "file",
  "asset",
  "external-reference",
]);

export interface ResourceAdapterRegistry {
  readonly kinds: readonly ResourceContextAdapter["kind"][];
  get(kind: ResourceKind): ResourceContextAdapter | null;
  require(kind: ResourceKind): ResourceContextAdapter;
}

export function createResourceAdapterRegistry(
  adapters: readonly ResourceContextAdapter[],
): ResourceAdapterRegistry {
  const byKind = new Map<ResourceContextAdapter["kind"], ResourceContextAdapter>();
  for (const adapter of adapters) {
    if (!adapter || typeof adapter !== "object"
      || !REGISTERABLE_RESOURCE_KINDS.has(adapter.kind)
      || typeof adapter.snapshot !== "function" || typeof adapter.resolve !== "function") {
      throw new Error("Resource adapter is invalid or uses a deferred Resource kind");
    }
    if (byKind.has(adapter.kind)) throw new Error(`Duplicate Resource adapter for ${adapter.kind}`);
    byKind.set(adapter.kind, Object.freeze(adapter));
  }
  const kinds = Object.freeze([...byKind.keys()]);
  return Object.freeze({
    kinds,
    get(kind: ResourceKind) {
      return byKind.get(kind as ResourceContextAdapter["kind"]) ?? null;
    },
    require(kind: ResourceKind) {
      const adapter = byKind.get(kind as ResourceContextAdapter["kind"]);
      if (!adapter) {
        throw new BlockedContextError(
          [kind],
          `Context resolution blocked: unregistered Resource adapter for ${kind}`,
        );
      }
      return adapter;
    },
  });
}

export const baseResourceAdapterList = Object.freeze([
  moodboardResourceAdapter,
  effectResourceAdapter,
  fileResourceAdapter,
  assetResourceAdapter,
  externalReferenceAdapter,
] as const satisfies readonly ResourceContextAdapter[]);

export const resourceAdapters = createResourceAdapterRegistry(baseResourceAdapterList);

export {
  assetResourceAdapter,
  effectResourceAdapter,
  externalReferenceAdapter,
  fileResourceAdapter,
  moodboardResourceAdapter,
};
