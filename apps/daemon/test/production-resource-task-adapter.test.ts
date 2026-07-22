import assert from "node:assert/strict";
import test from "node:test";

import type { ResourceKind } from "../../../packages/core/src/index.ts";
import type { ResourcePayloadCleanupStorePort } from "../src/orchestration/resource-task-payload-recovery.ts";
import {
  ResourceTaskAdapterError,
  ResourceTaskExecutor,
  VersionedResourceGenerationAdapterRegistry,
  type ResourceGenerationAdapterInput,
  type ResourceGenerationAdapterOutput,
} from "../src/orchestration/resource-task-executor.ts";

type Generator = (input: ResourceGenerationAdapterInput) => Promise<ResourceGenerationAdapterOutput>;

interface ProductionResourceTaskAdapterModule {
  createProductionResourceGenerationAdapterRegistry(
    implementations: Partial<Record<ResourceKind, Generator>>,
  ): VersionedResourceGenerationAdapterRegistry;
  createProductionResourceTaskExecutor(options: {
    storageRoot: string;
    store: ResourcePayloadCleanupStorePort;
    implementations: Partial<Record<ResourceKind, Generator>>;
    now?: () => number;
  }): ResourceTaskExecutor;
}

async function productionModule(): Promise<Partial<ProductionResourceTaskAdapterModule>> {
  return import("../src/orchestration/production-resource-task-adapter.ts")
    .catch(() => ({})) as Promise<Partial<ProductionResourceTaskAdapterModule>>;
}

function output(kind: ResourceKind): ResourceGenerationAdapterOutput {
  return {
    bytes: new TextEncoder().encode(`${kind} payload`),
    mimeType: "application/json",
    summary: `${kind} result`,
    metadata: { kind },
    provenance: { adapter: kind },
    evidence: { generated: true },
  };
}

function storePort(): ResourcePayloadCleanupStorePort {
  return {
    tryClaimResourcePayloadCleanup() { return null; },
    completeResourcePayloadCleanup() { throw new Error("not used"); },
    beginResourcePayloadStaging() { throw new Error("not used"); },
    getResourcePayloadStaging() { return null; },
    classifyResourcePayloadStaging() { throw new Error("not used"); },
    completeResourcePayloadStaging() { throw new Error("not used"); },
    listResourcePayloadRecoveryEntries() {
      return { entries: [], nextCursor: null };
    },
  };
}

test("production Resource registry exposes exact frozen v1 adapters for Research, Moodboard, and Sharingan only when explicitly wired", async () => {
  const module = await productionModule();
  assert.equal(typeof module.createProductionResourceGenerationAdapterRegistry, "function");
  if (typeof module.createProductionResourceGenerationAdapterRegistry !== "function") return;
  const calls: ResourceKind[] = [];
  const generate = (kind: ResourceKind): Generator => async () => {
    calls.push(kind);
    return output(kind);
  };
  const registry = module.createProductionResourceGenerationAdapterRegistry({
    research: generate("research"),
    moodboard: generate("moodboard"),
    "sharingan-capture": generate("sharingan-capture"),
  });

  for (const kind of ["research", "moodboard", "sharingan-capture"] as const) {
    const adapter = registry.require({
      id: `dezin.resource-adapter.${kind}`,
      version: 1,
      kind,
    });
    assert.deepEqual(adapter.identity, {
      id: `dezin.resource-adapter.${kind}`,
      version: 1,
      kind,
    });
    await adapter.generate({ signal: new AbortController().signal } as ResourceGenerationAdapterInput);
  }
  assert.deepEqual(calls, ["research", "moodboard", "sharingan-capture"]);
  assert.throws(
    () => registry.require({
      id: "dezin.resource-adapter.research",
      version: 2,
      kind: "research",
    }),
    (error: unknown) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_VERSION_UNAVAILABLE",
  );
  assert.throws(
    () => registry.require({
      id: "dezin.resource-adapter.asset",
      version: 1,
      kind: "asset",
    }),
    (error: unknown) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_UNAVAILABLE",
  );
});

test("production Resource executor factory binds the explicit adapter registry to durable owned staging", async () => {
  const module = await productionModule();
  assert.equal(typeof module.createProductionResourceTaskExecutor, "function");
  if (typeof module.createProductionResourceTaskExecutor !== "function") return;
  const executor = module.createProductionResourceTaskExecutor({
    storageRoot: "/tmp/dezin-production-resource-staging",
    store: storePort(),
    implementations: {
      research: async () => output("research"),
    },
    now: () => 10,
  });

  assert.ok(executor instanceof ResourceTaskExecutor);
  assert.deepEqual(
    executor.options.adapters.require({
      id: "dezin.resource-adapter.research",
      version: 1,
      kind: "research",
    }).identity,
    { id: "dezin.resource-adapter.research", version: 1, kind: "research" },
  );
});

test("production Resource registry rejects unknown keys and accessor-backed implementations without invoking them", async () => {
  const module = await productionModule();
  assert.equal(typeof module.createProductionResourceGenerationAdapterRegistry, "function");
  const createRegistry = module.createProductionResourceGenerationAdapterRegistry;
  if (typeof createRegistry !== "function") return;
  let invoked = false;
  const implementations = Object.defineProperty({}, "research", {
    enumerable: true,
    get() {
      invoked = true;
      return async () => output("research");
    },
  });
  assert.throws(
    () => createRegistry(implementations),
    (error: unknown) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_REGISTRATION_INVALID",
  );
  assert.equal(invoked, false);
  assert.throws(
    () => createRegistry({
      unsupported: async () => output("research"),
    } as never),
    (error: unknown) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_REGISTRATION_INVALID",
  );
});

test("production Resource executor rejects accessor-backed durable Store ports without invoking them", async () => {
  const module = await productionModule();
  assert.equal(typeof module.createProductionResourceTaskExecutor, "function");
  const createExecutor = module.createProductionResourceTaskExecutor;
  if (typeof createExecutor !== "function") return;
  let invoked = false;
  const hostileStore = Object.defineProperty({}, "tryClaimResourcePayloadCleanup", {
    enumerable: true,
    get() {
      invoked = true;
      return () => null;
    },
  });

  assert.throws(
    () => createExecutor({
      storageRoot: "/tmp/dezin-production-resource-hostile-store",
      store: hostileStore as never,
      implementations: { research: async () => output("research") },
    }),
    (error: unknown) => error instanceof ResourceTaskAdapterError
      && error.code === "RESOURCE_ADAPTER_REGISTRATION_INVALID",
  );
  assert.equal(invoked, false);
});
