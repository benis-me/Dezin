import { types as nodeUtilTypes } from "node:util";

import type { ResourceKind } from "../../../../packages/core/src/index.ts";
import {
  WorkspaceStoreResourceTaskPayloadReferenceGuard,
  type ResourcePayloadCleanupStorePort,
} from "./resource-task-payload-recovery.ts";
import { OwnedResourceTaskPayloadStaging } from "./resource-task-payload-staging.ts";
import {
  ResourceTaskAdapterError,
  ResourceTaskExecutor,
  VersionedResourceGenerationAdapterRegistry,
  type ResourceGenerationAdapter,
} from "./resource-task-executor.ts";

const RESOURCE_KINDS = Object.freeze([
  "research",
  "moodboard",
  "sharingan-capture",
  "file",
  "asset",
  "effect",
  "external-reference",
] as const satisfies readonly ResourceKind[]);
const RESOURCE_KIND_SET = new Set<ResourceKind>(RESOURCE_KINDS);
const RESOURCE_OPTION_FIELDS = Object.freeze([
  "storageRoot",
  "store",
  "implementations",
  "now",
] as const);

export type ProductionResourceGenerationImplementation = ResourceGenerationAdapter["generate"];

export type ProductionResourceGenerationImplementations = Partial<Readonly<Record<
  ResourceKind,
  ProductionResourceGenerationImplementation
>>>;

export interface ProductionResourceTaskAdapterOptions {
  readonly storageRoot: string;
  readonly store: ResourcePayloadCleanupStorePort;
  readonly implementations: ProductionResourceGenerationImplementations;
  readonly now?: () => number;
}

function invalidRegistration(message: string, cause?: unknown): never {
  throw new ResourceTaskAdapterError(
    "RESOURCE_ADAPTER_REGISTRATION_INVALID",
    message,
    cause,
  );
}

function inspectImplementations(
  value: ProductionResourceGenerationImplementations,
): readonly ResourceGenerationAdapter[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalidRegistration("Production Resource generation implementations must be plain data");
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    return invalidRegistration("Production Resource generation implementations could not be inspected", error);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidRegistration("Production Resource generation implementations must be a plain object");
  }
  const adapters: ResourceGenerationAdapter[] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !RESOURCE_KIND_SET.has(key as ResourceKind)) {
      return invalidRegistration("Production Resource generation implementations contain an unsupported kind");
    }
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function") {
      return invalidRegistration(
        `Production Resource generation implementation for ${key} must be an enumerable data function`,
      );
    }
    const kind = key as ResourceKind;
    const implementation = descriptor.value as ProductionResourceGenerationImplementation;
    adapters.push(Object.freeze({
      identity: Object.freeze({
        id: `dezin.resource-adapter.${kind}`,
        version: 1,
        kind,
      }),
      generate(input) {
        return Reflect.apply(implementation, undefined, [input]);
      },
    } satisfies ResourceGenerationAdapter));
  }
  adapters.sort((left, right) => Buffer.compare(
    Buffer.from(left.identity.kind, "utf8"),
    Buffer.from(right.identity.kind, "utf8"),
  ));
  return Object.freeze(adapters);
}

function dataMethod<T extends (...args: never[]) => unknown>(
  value: unknown,
  key: string,
): T | null {
  if (!value || (typeof value !== "object" && typeof value !== "function")
    || nodeUtilTypes.isProxy(value)) return null;
  let cursor: object | null = value;
  try {
    while (cursor !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (descriptor !== undefined) {
        return "value" in descriptor && typeof descriptor.value === "function"
          ? descriptor.value.bind(value) as T
          : null;
      }
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch {
    return null;
  }
  return null;
}

function resourceOptions(value: unknown): Record<typeof RESOURCE_OPTION_FIELDS[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalidRegistration("Production Resource Task adapter options must be plain data");
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.some((key) => typeof key !== "string"
        || !RESOURCE_OPTION_FIELDS.includes(key as typeof RESOURCE_OPTION_FIELDS[number]))
      || !["storageRoot", "store", "implementations"].every((field) => keys.includes(field))) {
      return invalidRegistration("Production Resource Task adapter options contain invalid fields");
    }
    const result = { now: undefined } as Record<typeof RESOURCE_OPTION_FIELDS[number], unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key as string]!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
        return invalidRegistration("Production Resource Task adapter options must contain only data fields");
      }
      result[key as typeof RESOURCE_OPTION_FIELDS[number]] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof ResourceTaskAdapterError) throw error;
    return invalidRegistration("Production Resource Task adapter options could not be inspected", error);
  }
}

function pinnedStore(value: unknown): ResourcePayloadCleanupStorePort {
  const tryClaimResourcePayloadCleanup = dataMethod<
    ResourcePayloadCleanupStorePort["tryClaimResourcePayloadCleanup"]
  >(value, "tryClaimResourcePayloadCleanup");
  const completeResourcePayloadCleanup = dataMethod<
    ResourcePayloadCleanupStorePort["completeResourcePayloadCleanup"]
  >(value, "completeResourcePayloadCleanup");
  const beginResourcePayloadStaging = dataMethod<
    ResourcePayloadCleanupStorePort["beginResourcePayloadStaging"]
  >(value, "beginResourcePayloadStaging");
  const getResourcePayloadStaging = dataMethod<
    ResourcePayloadCleanupStorePort["getResourcePayloadStaging"]
  >(value, "getResourcePayloadStaging");
  const classifyResourcePayloadStaging = dataMethod<
    ResourcePayloadCleanupStorePort["classifyResourcePayloadStaging"]
  >(value, "classifyResourcePayloadStaging");
  const completeResourcePayloadStaging = dataMethod<
    ResourcePayloadCleanupStorePort["completeResourcePayloadStaging"]
  >(value, "completeResourcePayloadStaging");
  const listResourcePayloadRecoveryEntries = dataMethod<
    ResourcePayloadCleanupStorePort["listResourcePayloadRecoveryEntries"]
  >(value, "listResourcePayloadRecoveryEntries");
  if (tryClaimResourcePayloadCleanup === null || completeResourcePayloadCleanup === null
    || beginResourcePayloadStaging === null || getResourcePayloadStaging === null
    || classifyResourcePayloadStaging === null || completeResourcePayloadStaging === null
    || listResourcePayloadRecoveryEntries === null) {
    return invalidRegistration("Production Resource durable Store port is invalid");
  }
  return Object.freeze({
    tryClaimResourcePayloadCleanup,
    completeResourcePayloadCleanup,
    beginResourcePayloadStaging,
    getResourcePayloadStaging,
    classifyResourcePayloadStaging,
    completeResourcePayloadStaging,
    listResourcePayloadRecoveryEntries,
  });
}

/**
 * Registers only explicitly supplied production implementations. There is no
 * generic or newest-version fallback: the frozen Task identity must match the
 * exact `dezin.resource-adapter.<kind>@1` registration.
 */
export function createProductionResourceGenerationAdapterRegistry(
  implementations: ProductionResourceGenerationImplementations,
): VersionedResourceGenerationAdapterRegistry {
  return new VersionedResourceGenerationAdapterRegistry(inspectImplementations(implementations));
}

/**
 * Binds Resource generation to daemon-owned payload storage. The staging
 * implementation commits the exact lease journal before its first filesystem
 * write and reconciles response loss through the same durable Store port.
 */
export function createProductionResourceTaskExecutor(
  options: ProductionResourceTaskAdapterOptions,
): ResourceTaskExecutor {
  const configuration = resourceOptions(options);
  if (typeof configuration.storageRoot !== "string" || configuration.storageRoot.length === 0
    || configuration.storageRoot.includes("\0")
    || (configuration.now !== undefined && typeof configuration.now !== "function")) {
    return invalidRegistration("Production Resource Task adapter configuration is invalid");
  }
  const store = pinnedStore(configuration.store);
  const references = new WorkspaceStoreResourceTaskPayloadReferenceGuard({
    store,
  });
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot: configuration.storageRoot,
    references,
    journal: references,
    now: configuration.now as (() => number) | undefined,
  });
  return new ResourceTaskExecutor({
    adapters: createProductionResourceGenerationAdapterRegistry(
      configuration.implementations as ProductionResourceGenerationImplementations,
    ),
    staging,
  });
}
