import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  Store,
  type GenerationTaskPrototypeMarkerProof,
  type GenerationTaskAttemptClaim,
  type Resource,
  type ResourceRevision,
} from "../../../packages/core/src/index.ts";
import { BUNDLED_DESIGN_SYSTEMS, DesignRegistry } from "../../../packages/design/src/index.ts";
import { RuntimeSupervisor } from "../src/runtime-supervisor.ts";
import { beginArtifactCandidateTransaction } from "../src/orchestration/artifact-candidate-transaction.ts";
import type { ArtifactPreparedCandidate } from "../src/orchestration/generation-task-executor.ts";
import { persistGenerationTaskVisualEvidence } from "../src/orchestration/generation-task-visual-evidence.ts";
import {
  createProductionGenerationSystem,
  productionSharinganSourceAuthority,
  resolveProductionPrototypeMarkers,
  type ProductionPrototypeMarkerRuntimePort,
  withProductionPrototypeMarkerRuntimeSession,
} from "../src/orchestration/production-generation-system.ts";
import { createProductionResourceTaskExecutor } from "../src/orchestration/production-resource-task-adapter.ts";
import { sharinganFixturePng } from "./support/sharingan-capture-fixture.ts";
import { waitForDurableProgress } from "./support/wait-for-durable-progress.ts";

const DESKTOP_FRAME = { id: "desktop", name: "Desktop", width: 1_440, height: 900 } as const;
const PRODUCTION_GENERATION_IDLE_TIMEOUT_MS = 30_000;
const PRODUCTION_GENERATION_HARD_TIMEOUT_MS = 60_000;
const FROZEN_CODEBUDDY_AGENT = {
  providerId: "codebuddy",
  command: "codebuddy",
  model: "gpt-5.6-sol",
  executionAuthority: {
    kind: "generator" as const,
    baseUrl: "",
    organization: "",
    credentialProviderId: "codebuddy",
    credentialSource: "session",
    credentialRequired: false,
  },
} as const;
const FROZEN_CLAUDE_REVIEWER = {
  providerId: "claude",
  command: "claude",
  model: null,
  executionAuthority: {
    kind: "reviewer" as const,
    baseUrl: "",
    credentialSource: "session" as const,
    credentialRequired: false,
  },
} as const;

function emptyGeneration() {
  return {
    kind: "workspace-generation" as const,
    resourceOperations: [],
    artifactPlans: [],
    dependencyPlans: [],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("Generation Plan did not settle before the deadline");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("prototype runtime scope releases its browser session and preview lease together on abort", async () => {
  const controller = new AbortController();
  let closeCount = 0;
  let releaseCount = 0;
  let openedWithSignal: AbortSignal | null = null;
  const operation = withProductionPrototypeMarkerRuntimeSession({
    lease: {
      url: "http://127.0.0.1:4173/exact-revision",
      async release() { releaseCount += 1; },
    },
    signal: controller.signal,
    async openSession(_url, options) {
      openedWithSignal = options.signal;
      return {
        async applyRenderFrame() {},
        async close() { closeCount += 1; },
        async probePrototypeMarker() {
          return { tagName: "button", role: null, action: "button", visible: true };
        },
        async setViewport() {},
        async settle() {},
      };
    },
    async run() {
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.signal.throwIfAborted();
      assert.fail("aborted prototype runtime scope continued");
    },
  });
  controller.abort(new Error("abort prototype runtime scope"));

  await assert.rejects(operation, /abort prototype runtime scope/i);
  assert.equal(openedWithSignal, controller.signal);
  assert.equal(closeCount, 1);
  assert.equal(releaseCount, 1);
});

test("prototype runtime scope releases an acquired preview lease when already aborted before session open", async () => {
  const controller = new AbortController();
  const abortFailure = new Error("abort after exact preview lease acquisition");
  controller.abort(abortFailure);
  let openCount = 0;
  let releaseCount = 0;

  await assert.rejects(
    withProductionPrototypeMarkerRuntimeSession({
      lease: {
        url: "http://127.0.0.1:4173/exact-revision",
        async release() { releaseCount += 1; },
      },
      signal: controller.signal,
      async openSession() {
        openCount += 1;
        assert.fail("already-aborted prototype runtime scope opened a browser session");
      },
      async run() {
        assert.fail("already-aborted prototype runtime scope ran a browser session");
      },
    }),
    (error: unknown) => error === abortFailure,
  );
  assert.equal(openCount, 0);
  assert.equal(releaseCount, 1);
});

test("prototype runtime scope preserves a pre-open abort before exact lease cleanup failure", async () => {
  const controller = new AbortController();
  const abortFailure = new Error("abort after exact preview lease acquisition");
  const releaseFailure = new Error("exact preview lease release failed");
  controller.abort(abortFailure);
  let openCount = 0;

  await assert.rejects(
    withProductionPrototypeMarkerRuntimeSession({
      lease: {
        url: "http://127.0.0.1:4173/exact-revision",
        async release() { throw releaseFailure; },
      },
      signal: controller.signal,
      async openSession() {
        openCount += 1;
        assert.fail("already-aborted prototype runtime scope opened a browser session");
      },
      async run() {
        assert.fail("already-aborted prototype runtime scope ran a browser session");
      },
    }),
    (error: unknown) => error instanceof AggregateError
      && error.cause === abortFailure
      && error.errors.length === 2
      && error.errors[0] === abortFailure
      && error.errors[1] === releaseFailure,
  );
  assert.equal(openCount, 0);
});

test("prototype runtime scope exposes every cleanup failure after a successful probe", async () => {
  const closeFailure = new Error("prototype browser close failed");
  const releaseFailure = new Error("prototype preview lease release failed");
  await assert.rejects(
    withProductionPrototypeMarkerRuntimeSession({
      lease: {
        url: "http://127.0.0.1:4173/exact-revision",
        async release() { throw releaseFailure; },
      },
      signal: new AbortController().signal,
      async openSession() {
        return {
          async applyRenderFrame() {},
          async close() { throw closeFailure; },
          async probePrototypeMarker() {
            return { tagName: "button", role: null, action: "button", visible: true };
          },
          async setViewport() {},
          async settle() {},
        };
      },
      async run() { return "proved"; },
    }),
    (error: unknown) => error instanceof AggregateError
      && error.errors.length === 2
      && error.errors[0] === closeFailure
      && error.errors[1] === releaseFailure,
  );
});

test("prototype runtime scope preserves the primary probe failure before cleanup failures", async () => {
  const primaryFailure = new Error("prototype probe failed");
  const closeFailure = new Error("prototype browser close failed");
  const releaseFailure = new Error("prototype preview lease release failed");
  await assert.rejects(
    withProductionPrototypeMarkerRuntimeSession({
      lease: {
        url: "http://127.0.0.1:4173/exact-revision",
        async release() { throw releaseFailure; },
      },
      signal: new AbortController().signal,
      async openSession() {
        return {
          async applyRenderFrame() {},
          async close() { throw closeFailure; },
          async probePrototypeMarker() {
            return { tagName: "button", role: null, action: "button", visible: true };
          },
          async setViewport() {},
          async settle() {},
        };
      },
      async run() { throw primaryFailure; },
    }),
    (error: unknown) => error instanceof AggregateError
      && error.cause === primaryFailure
      && error.errors.length === 3
      && error.errors[0] === primaryFailure
      && error.errors[1] === closeFailure
      && error.errors[2] === releaseFailure,
  );
});

function markerHash(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function fakePrototypeMarkerRuntimeFixture(options: {
  artifactCount: number;
  openDelayMs?: number;
  frameDelayMs?: number;
}) {
  const markers = Array.from({ length: options.artifactCount }, (_, index) => ({
    workspaceId: "workspace-prototype-capacity",
    artifactId: `source-artifact-${index}`,
    revisionId: `source-revision-${index}`,
    sourceMarkerId: `source-marker-${index}`,
    trigger: (index % 2 === 0 ? "click" : "submit") as "click" | "submit",
    receiptNonce: markerHash(`receipt-${index}`),
  }));
  const framesByRevision = new Map(markers.map((marker, index) => [
    marker.revisionId,
    Array.from({ length: 2 + (index % 3) }, (_, frameIndex) => ({
      id: `frame-${index}-${frameIndex}`,
      width: 390 + frameIndex,
      height: 844 + frameIndex,
    })),
  ]));
  const openedRevisionIds: string[] = [];
  const closedRevisionIds: string[] = [];
  const releasedRevisionIds: string[] = [];
  let activeSessions = 0;
  let maxActiveSessions = 0;

  const delay = async (delayMs: number, signal: AbortSignal): Promise<void> => {
    if (delayMs <= 0) {
      signal.throwIfAborted();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(finish, delayMs);
      function finish() {
        signal.removeEventListener("abort", abort);
        resolve();
      }
      function abort() {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      }
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  };

  const runtime: ProductionPrototypeMarkerRuntimePort = {
    async resolveSelection(input) {
      input.signal.throwIfAborted();
      return {
        protocol: "dezin.artifact-element-selection-manifest.v1",
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        artifactRevisionId: input.revisionId,
        assemblyHash: markerHash(`assembly:${input.revisionId}`),
        designNodeId: input.designNodeId,
        sourceArtifactId: input.artifactId,
        sourceArtifactRevisionId: input.revisionId,
        sourceCommitHash: markerHash(`commit:${input.revisionId}`),
        sourceTreeHash: markerHash(`tree:${input.revisionId}`),
        sourcePath: `src/${input.artifactId}.tsx`,
        selectionManifestHash: markerHash(`selection:${input.revisionId}:${input.designNodeId}`),
      };
    },
    async resolvePreview(input) {
      const marker = markers.find((candidate) => candidate.revisionId === input.revisionId);
      assert.ok(marker, `unknown fake preview revision ${input.revisionId}`);
      return {
        version: 1,
        targetKey: `artifact-revision:${input.projectId}:${marker.revisionId}`,
        requestedKind: "artifact-revision",
        projectId: input.projectId,
        workspaceId: marker.workspaceId,
        artifactId: marker.artifactId,
        artifactKind: "page",
        revisionId: marker.revisionId,
        trackId: `track-${marker.artifactId}`,
        snapshotId: null,
        sourceCommitHash: markerHash(`commit:${marker.revisionId}`),
        sourceTreeHash: markerHash(`tree:${marker.revisionId}`),
        dependencyLockHash: markerHash(`dependencies:${marker.revisionId}`),
        assemblyHash: markerHash(`assembly:${marker.revisionId}`),
        artifactRoot: `artifacts/${marker.artifactId}`,
        renderSpec: { entry: "src/main.tsx", frames: framesByRevision.get(marker.revisionId)! },
        variantKey: null,
        stateKey: null,
        runId: null,
      };
    },
    async acquireLease(input) {
      input.signal.throwIfAborted();
      const revisionId = input.resolved.revisionId;
      return {
        url: `http://127.0.0.1:4173/${revisionId}`,
        async release() {
          releasedRevisionIds.push(revisionId);
        },
      };
    },
    async openSession(url, openOptions) {
      const revisionId = new URL(url).pathname.slice(1);
      activeSessions += 1;
      maxActiveSessions = Math.max(maxActiveSessions, activeSessions);
      openedRevisionIds.push(revisionId);
      let closed = false;
      try {
        await delay(options.openDelayMs ?? 0, openOptions.signal);
      } catch (error) {
        activeSessions -= 1;
        throw error;
      }
      return {
        async applyRenderFrame(_url, _frame, signal) {
          signal.throwIfAborted();
        },
        async close() {
          assert.equal(closed, false, `fake runtime ${revisionId} closed twice`);
          closed = true;
          activeSessions -= 1;
          closedRevisionIds.push(revisionId);
        },
        async probePrototypeMarker(markerId, trigger, receiptNonce, signal) {
          signal.throwIfAborted();
          const marker = markers.find((candidate) => candidate.revisionId === revisionId)!;
          assert.equal(markerId, marker.sourceMarkerId);
          assert.equal(trigger, marker.trigger);
          assert.equal(receiptNonce, marker.receiptNonce);
          return { tagName: "button", role: null, action: "button", visible: true };
        },
        async setViewport(frame) {
          assert.ok(framesByRevision.get(revisionId)?.some((candidate) =>
            candidate.id === frame.label
            && candidate.width === frame.width
            && candidate.height === frame.height));
        },
        async settle() {
          await delay(options.frameDelayMs ?? 0, openOptions.signal);
        },
      };
    },
  };

  return {
    markers,
    runtime,
    state: {
      get activeSessions() { return activeSessions; },
      get maxActiveSessions() { return maxActiveSessions; },
      openedRevisionIds,
      closedRevisionIds,
      releasedRevisionIds,
    },
  };
}

async function resolvePrototypeMarkersWithFakeRuntime(input: {
  markers: ReturnType<typeof fakePrototypeMarkerRuntimeFixture>["markers"];
  signal: AbortSignal;
}, runtime: ProductionPrototypeMarkerRuntimePort): Promise<GenerationTaskPrototypeMarkerProof[]> {
  return resolveProductionPrototypeMarkers({
    store: {} as Store,
    dataDir: "/virtual/dezin-data",
    projectId: "project-prototype-capacity",
    markers: input.markers,
    signal: input.signal,
  }, runtime);
}

function firstFailurePrototypeMarkerRuntime(options: {
  primaryFailure: Error;
  primaryCleanupDelayMs?: number;
  primaryCleanupFailure?: Error;
  laterPeerFailure?: Error;
  peerCleanupFailure?: Error;
}) {
  const fixture = fakePrototypeMarkerRuntimeFixture({
    artifactCount: 6,
    frameDelayMs: 60_000,
  });
  const peerSignals = new Map<string, AbortSignal>();
  let primaryCleanupFinished = false;
  let peerAbortsBeforePrimaryCleanup = 0;
  const runtime: ProductionPrototypeMarkerRuntimePort = {
    ...fixture.runtime,
    async openSession(url, openOptions) {
      const session = await fixture.runtime.openSession(url, openOptions);
      const revisionId = new URL(url).pathname.slice(1);
      if (revisionId !== "source-revision-0") {
        peerSignals.set(revisionId, openOptions.signal);
        openOptions.signal.addEventListener("abort", () => {
          if (!primaryCleanupFinished) peerAbortsBeforePrimaryCleanup += 1;
        }, { once: true });
      }
      return {
        ...session,
        async close() {
          if (revisionId === "source-revision-0" && options.primaryCleanupDelayMs) {
            await new Promise<void>((resolve) => setTimeout(resolve, options.primaryCleanupDelayMs));
          }
          await session.close();
          if (revisionId === "source-revision-0") {
            primaryCleanupFinished = true;
            if (options.primaryCleanupFailure) throw options.primaryCleanupFailure;
          }
          if (revisionId === "source-revision-1" && options.peerCleanupFailure) {
            throw options.peerCleanupFailure;
          }
        },
        async settle() {
          if (revisionId === "source-revision-0") {
            await waitFor(() => peerSignals.size === 2);
            throw options.primaryFailure;
          }
          if (revisionId === "source-revision-1" && options.laterPeerFailure) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(finish, 20);
              function finish() {
                openOptions.signal.removeEventListener("abort", abort);
                resolve();
              }
              function abort() {
                clearTimeout(timer);
                openOptions.signal.removeEventListener("abort", abort);
                reject(openOptions.signal.reason);
              }
              openOptions.signal.addEventListener("abort", abort, { once: true });
              if (openOptions.signal.aborted) abort();
            });
            throw options.laterPeerFailure;
          }
          await session.settle();
        },
      };
    },
  };
  return {
    fixture,
    peerSignals,
    runtime,
    state: {
      get peerAbortsBeforePrimaryCleanup() { return peerAbortsBeforePrimaryCleanup; },
      get primaryCleanupFinished() { return primaryCleanupFinished; },
    },
  };
}

test("first prototype marker group failure aborts active peers, preserves the primary failure, and drains resources", async () => {
  const primaryFailure = new Error("first prototype marker runtime failed");
  const laterPeerFailure = new Error("later prototype peer runtime failed");
  const { fixture, peerSignals, runtime, state } = firstFailurePrototypeMarkerRuntime({
    primaryFailure,
    primaryCleanupDelayMs: 100,
    laterPeerFailure,
  });
  const external = new AbortController();
  const safetyFailure = new Error("prototype marker peer cancellation safety deadline exceeded");
  const safetyTimer = setTimeout(() => external.abort(safetyFailure), 2_000);

  try {
    await assert.rejects(
      resolvePrototypeMarkersWithFakeRuntime({
        markers: fixture.markers,
        signal: external.signal,
      }, runtime),
      (error: unknown) => error === primaryFailure,
    );
  } finally {
    clearTimeout(safetyTimer);
  }

  assert.equal(external.signal.aborted, false);
  assert.equal(fixture.state.openedRevisionIds.length, 3);
  assert.deepEqual(
    [...fixture.state.closedRevisionIds].sort(),
    [...fixture.state.openedRevisionIds].sort(),
  );
  assert.deepEqual(
    [...fixture.state.releasedRevisionIds].sort(),
    [...fixture.state.openedRevisionIds].sort(),
  );
  assert.equal(fixture.state.activeSessions, 0);
  assert.equal(state.primaryCleanupFinished, true);
  assert.equal(state.peerAbortsBeforePrimaryCleanup, 2);
  assert.equal(peerSignals.size, 2);
  for (const signal of peerSignals.values()) {
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, primaryFailure);
  }
});

test("prototype marker sibling cleanup failure is aggregated after the preserved primary failure", async () => {
  const primaryFailure = new Error("first prototype marker runtime failed");
  const primaryCleanupFailure = new Error("failed prototype browser cleanup failed");
  const peerCleanupFailure = new Error("cancelled prototype peer browser cleanup failed");
  const { fixture, runtime } = firstFailurePrototypeMarkerRuntime({
    primaryFailure,
    primaryCleanupFailure,
    peerCleanupFailure,
  });
  const external = new AbortController();
  const safetyTimer = setTimeout(
    () => external.abort(new Error("prototype marker peer cleanup safety deadline exceeded")),
    2_000,
  );

  try {
    await assert.rejects(
      resolvePrototypeMarkersWithFakeRuntime({
        markers: fixture.markers,
        signal: external.signal,
      }, runtime),
      (error: unknown) => error instanceof AggregateError
        && error.cause === primaryFailure
        && error.errors.length === 3
        && error.errors[0] === primaryFailure
        && error.errors[1] === primaryCleanupFailure
        && error.errors[2] === peerCleanupFailure,
    );
  } finally {
    clearTimeout(safetyTimer);
  }

  assert.equal(external.signal.aborted, false);
  assert.deepEqual(
    [...fixture.state.closedRevisionIds].sort(),
    [...fixture.state.openedRevisionIds].sort(),
  );
  assert.deepEqual(
    [...fixture.state.releasedRevisionIds].sort(),
    [...fixture.state.openedRevisionIds].sort(),
  );
  assert.equal(fixture.state.activeSessions, 0);
});

test("external abort supersedes an earlier runtime failure while its cleanup is still draining", async () => {
  const primaryFailure = new Error("prototype runtime failed before external deadline");
  const externalFailure = new Error("external prototype validation deadline");
  const { fixture, peerSignals, runtime } = firstFailurePrototypeMarkerRuntime({
    primaryFailure,
    primaryCleanupDelayMs: 100,
  });
  const external = new AbortController();
  const operation = resolvePrototypeMarkersWithFakeRuntime({
    markers: fixture.markers,
    signal: external.signal,
  }, runtime);

  await waitFor(() => peerSignals.size === 2
    && [...peerSignals.values()].every((signal) => signal.aborted));
  external.abort(externalFailure);

  await assert.rejects(
    operation,
    (error: unknown) => error instanceof AggregateError
      && error.cause === externalFailure
      && error.errors.length === 2
      && error.errors[0] === externalFailure
      && error.errors[1] === primaryFailure,
  );
  assert.deepEqual(
    [...fixture.state.closedRevisionIds].sort(),
    [...fixture.state.openedRevisionIds].sort(),
  );
  assert.deepEqual(
    [...fixture.state.releasedRevisionIds].sort(),
    [...fixture.state.openedRevisionIds].sort(),
  );
  assert.equal(fixture.state.activeSessions, 0);
});

test("external abort remains the top-level primary when an unresponsive runtime later fails normally", async () => {
  const fixture = fakePrototypeMarkerRuntimeFixture({
    artifactCount: 3,
    frameDelayMs: 60_000,
  });
  const external = new AbortController();
  const externalFailure = new Error("external prototype validation deadline");
  const lateRuntimeFailure = new Error("unresponsive prototype runtime failed after external abort");
  const runtime: ProductionPrototypeMarkerRuntimePort = {
    ...fixture.runtime,
    async openSession(url, openOptions) {
      const session = await fixture.runtime.openSession(url, openOptions);
      const revisionId = new URL(url).pathname.slice(1);
      return {
        ...session,
        async settle() {
          if (revisionId === "source-revision-0") {
            await waitFor(() => fixture.state.activeSessions === 3);
            external.abort(externalFailure);
            await new Promise<void>((resolve) => setImmediate(resolve));
            throw lateRuntimeFailure;
          }
          await session.settle();
        },
      };
    },
  };

  await assert.rejects(
    resolvePrototypeMarkersWithFakeRuntime({
      markers: fixture.markers,
      signal: external.signal,
    }, runtime),
    (error: unknown) => error instanceof AggregateError
      && error.cause === externalFailure
      && error.errors.length === 2
      && error.errors[0] === externalFailure
      && error.errors[1] === lateRuntimeFailure,
  );

  assert.deepEqual(
    [...fixture.state.closedRevisionIds].sort(),
    [...fixture.state.openedRevisionIds].sort(),
  );
  assert.deepEqual(
    [...fixture.state.releasedRevisionIds].sort(),
    [...fixture.state.openedRevisionIds].sort(),
  );
  assert.equal(fixture.state.activeSessions, 0);
});

test("external abort remains primary when a pre-pool selector ignores it and later fails", async () => {
  const fixture = fakePrototypeMarkerRuntimeFixture({ artifactCount: 1 });
  const external = new AbortController();
  const externalFailure = new Error("external prototype selection deadline");
  const lateSelectorFailure = new Error("unresponsive prototype selector failed after external abort");
  const runtime: ProductionPrototypeMarkerRuntimePort = {
    ...fixture.runtime,
    async resolveSelection() {
      external.abort(externalFailure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      throw lateSelectorFailure;
    },
  };

  await assert.rejects(
    resolvePrototypeMarkersWithFakeRuntime({
      markers: fixture.markers,
      signal: external.signal,
    }, runtime),
    (error: unknown) => error instanceof AggregateError
      && error.cause === externalFailure
      && error.errors.length === 2
      && error.errors[0] === externalFailure
      && error.errors[1] === lateSelectorFailure,
  );
  assert.equal(fixture.state.openedRevisionIds.length, 0);
  assert.equal(fixture.state.closedRevisionIds.length, 0);
  assert.equal(fixture.state.releasedRevisionIds.length, 0);
  assert.equal(fixture.state.activeSessions, 0);
});

test("prototype marker resolver preserves one exact source Revision across its complete runtime scope", async () => {
  const fixture = fakePrototypeMarkerRuntimeFixture({ artifactCount: 1 });

  const proofs = await resolvePrototypeMarkersWithFakeRuntime({
    markers: fixture.markers,
    signal: new AbortController().signal,
  }, fixture.runtime);

  assert.equal(proofs.length, 1);
  assert.equal(proofs[0]?.sourceArtifactId, "source-artifact-0");
  assert.equal(proofs[0]?.sourceArtifactRevisionId, "source-revision-0");
  assert.equal(proofs[0]?.runtimeProof.artifactRevisionId, "source-revision-0");
  assert.equal(proofs[0]?.runtimeProof.designNodeId, "source-marker-0");
  assert.deepEqual(
    proofs[0]?.runtimeProof.frames.map((frame) => frame.frameId),
    ["frame-0-0", "frame-0-1"],
  );
  assert.deepEqual(fixture.state.openedRevisionIds, ["source-revision-0"]);
  assert.deepEqual(fixture.state.closedRevisionIds, ["source-revision-0"]);
  assert.deepEqual(fixture.state.releasedRevisionIds, ["source-revision-0"]);
  assert.equal(fixture.state.activeSessions, 0);
});

test("nine independent prototype source runtimes complete inside the frozen 180s total deadline", async () => {
  const frozenTaskDeadlineMs = 180_000;
  const sessionOpenDelayMs = 20_000;
  const perFrameDelayMs = 2_000;
  const timeScale = 500;
  const frameCounts = Array.from({ length: 9 }, (_, index) => 2 + (index % 3));
  const serializedRuntimeMs = frameCounts.reduce(
    (total, frameCount) => total + sessionOpenDelayMs + (frameCount * perFrameDelayMs),
    0,
  );
  assert.ok(
    serializedRuntimeMs > frozenTaskDeadlineMs,
    "the fake runtime must reproduce the serial 180s capacity defect",
  );
  const fixture = fakePrototypeMarkerRuntimeFixture({
    artifactCount: 9,
    openDelayMs: sessionOpenDelayMs / timeScale,
    frameDelayMs: perFrameDelayMs / timeScale,
  });
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("frozen prototype validation 180s total deadline exceeded")),
    frozenTaskDeadlineMs / timeScale,
  );

  let proofs: GenerationTaskPrototypeMarkerProof[];
  try {
    proofs = await resolvePrototypeMarkersWithFakeRuntime({
      markers: fixture.markers,
      signal: deadline.signal,
    }, fixture.runtime);
  } finally {
    clearTimeout(timer);
  }

  assert.equal(proofs.length, 9);
  for (const [index, proof] of proofs.entries()) {
    assert.equal(proof.sourceArtifactId, `source-artifact-${index}`);
    assert.equal(proof.sourceArtifactRevisionId, `source-revision-${index}`);
    assert.equal(proof.designNodeId, `source-marker-${index}`);
    assert.equal(proof.runtimeProof.artifactId, `source-artifact-${index}`);
    assert.equal(proof.runtimeProof.artifactRevisionId, `source-revision-${index}`);
    assert.equal(proof.runtimeProof.frames.length, frameCounts[index]);
    assert.ok(proof.runtimeProof.frames.every((frame) =>
      frame.frameId.startsWith(`frame-${index}-`)));
  }
  assert.equal(fixture.state.maxActiveSessions, 3);
  assert.equal(fixture.state.openedRevisionIds.length, 9);
  assert.equal(fixture.state.closedRevisionIds.length, 9);
  assert.equal(fixture.state.releasedRevisionIds.length, 9);
  assert.equal(fixture.state.activeSessions, 0);
});

test("prototype marker group concurrency drains every active session and lease on abort", async () => {
  const fixture = fakePrototypeMarkerRuntimeFixture({
    artifactCount: 9,
    frameDelayMs: 10_000,
  });
  const controller = new AbortController();
  const abortFailure = new Error("abort bounded prototype marker groups");
  const operation = resolvePrototypeMarkersWithFakeRuntime({
    markers: fixture.markers,
    signal: controller.signal,
  }, fixture.runtime);

  await waitFor(() => fixture.state.maxActiveSessions === 3);
  controller.abort(abortFailure);

  await assert.rejects(operation, (error: unknown) => error === abortFailure);
  assert.equal(fixture.state.openedRevisionIds.length, 3);
  assert.equal(fixture.state.closedRevisionIds.length, 3);
  assert.equal(fixture.state.releasedRevisionIds.length, 3);
  assert.deepEqual(
    [...fixture.state.closedRevisionIds].sort(),
    [...fixture.state.openedRevisionIds].sort(),
  );
  assert.deepEqual(
    [...fixture.state.releasedRevisionIds].sort(),
    [...fixture.state.openedRevisionIds].sort(),
  );
  assert.equal(fixture.state.activeSessions, 0);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function initializeRepository(repositoryDir: string): Promise<void> {
  await mkdir(repositoryDir, { recursive: true });
  git(repositoryDir, "init", "-q");
  git(repositoryDir, "config", "user.name", "Dezin acceptance");
  git(repositoryDir, "config", "user.email", "acceptance@dezin.local");
  await writeFile(join(repositoryDir, "README.md"), "# Production generation acceptance\n", "utf8");
  git(repositoryDir, "add", "README.md");
  git(repositoryDir, "commit", "-q", "-m", "base");
}

function nonEmptyGeneration() {
  return {
    kind: "workspace-generation" as const,
    agent: FROZEN_CODEBUDDY_AGENT,
    reviewerAgent: FROZEN_CLAUDE_REVIEWER,
    moodboardImageAuthority: {
      kind: "moodboard-image" as const,
      protocol: "dezin.workspace-moodboard-image-authority.v1" as const,
      providerId: "fal",
      baseUrl: "https://images.example.test/v1",
      model: "fal-ai/flux/dev",
      apiVersion: "",
      credentialSource: "global-image" as const,
      credentialRequired: true,
    },
    resourceOperations: [{
      operation: "create" as const,
      nodeId: "direction-board-node",
      resourceId: "direction-moodboard",
      kind: "moodboard" as const,
      title: "Product direction board",
      revisionPolicy: { kind: "generate" as const },
    }],
    artifactPlans: [
      {
        operation: "create" as const,
        nodeId: "card-node",
        artifactId: "card-component",
        kind: "component" as const,
        name: "Product card",
        trackId: "card-track",
        baseRevisionId: null,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
      },
      {
        operation: "create" as const,
        nodeId: "catalog-node",
        artifactId: "catalog-page",
        kind: "page" as const,
        name: "Catalog",
        trackId: "catalog-track",
        baseRevisionId: null,
        dependsOnArtifactIds: ["card-component"],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
      },
    ],
    dependencyPlans: [
      {
        kind: "resource" as const,
        ownerArtifactId: "card-component",
        resourceId: "direction-moodboard",
      },
      {
        kind: "component-instance" as const,
        ownerArtifactId: "catalog-page",
        instanceId: "catalog-card-instance",
        componentArtifactId: "card-component",
        componentRevisionId: null,
        sourceLocator: { designNodeId: "catalog-card-slot" },
        overrides: {},
        status: "linked" as const,
      },
    ],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [DESKTOP_FRAME],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function deterministicArtifactLeaf(input: {
  projectId: string;
  repositoryDir: string;
  dataDir: string;
  executions: string[];
}) {
  return {
    async execute(
      claim: GenerationTaskAttemptClaim,
      signal: AbortSignal,
    ): Promise<ArtifactPreparedCandidate> {
      assert.ok(claim.task.kind === "component" || claim.task.kind === "page");
      assert.equal(claim.task.target.type, "artifact");
      const contextPackId = claim.attempt.contextPackId;
      if (contextPackId === null) assert.fail("Artifact Attempt must freeze one Context Pack");
      assert.ok(contextPackId.startsWith("context-pack-"));
      assert.ok(claim.attempt.sourceCommitHash);
      assert.ok(claim.attempt.sourceTreeHash);
      const frames = structuredClone(claim.task.payload.responsiveFrames) as Array<{
        id: string;
        name: string;
        width: number;
        height: number;
      }>;
      assert.ok(Array.isArray(frames) && frames.length > 0);
      input.executions.push(claim.task.kind);
      const attempt = {
        workspaceId: claim.task.workspaceId,
        taskId: claim.task.id,
        attempt: claim.attempt.attempt,
        inputHash: claim.attempt.inputHash,
        createdAt: claim.attempt.createdAt,
        sourceCommitHash: claim.attempt.sourceCommitHash,
        sourceTreeHash: claim.attempt.sourceTreeHash,
      };
      const transaction = await beginArtifactCandidateTransaction({
        repositoryDir: input.repositoryDir,
        attempt,
      });
      try {
        await writeFile(
          join(transaction.dir, `${claim.task.target.id}.html`),
          `<main data-design-node-id="${claim.task.target.id}">${claim.task.target.id}</main>\n`,
          "utf8",
        );
        const candidate = await transaction.commit(`generate ${claim.task.target.id}`, signal);
        const contextPackHash = contextPackId.slice("context-pack-".length);
        const round = 0;
        const visualDescriptors = await Promise.all(frames.map(async (frame, index) => {
          const frameAttemptId = `quality-round-${round}-frame-${index}`;
          const bytes = sharinganFixturePng(frame.width, frame.height);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const sourcePath = join(transaction.dir, `.quality-${round}-${index}.png`);
          await writeFile(sourcePath, bytes);
          const descriptor = await persistGenerationTaskVisualEvidence({
            dataDir: input.dataDir,
            owner: {
              projectId: input.projectId,
              workspaceId: claim.task.workspaceId,
              planId: claim.task.planId,
              taskId: claim.task.id,
              attempt: claim.attempt.attempt,
              candidateCommitHash: candidate.commitHash,
              candidateTreeHash: candidate.treeHash,
              contextPackId,
              contextPackHash,
            },
            frame: { ...frame, frameAttemptId },
            round,
            sourcePath,
            expectedIdentity: {
              sha256,
              byteLength: bytes.byteLength,
              width: frame.width,
              height: frame.height,
            },
          });
          assert.ok(descriptor);
          const summary = {
            frameId: frame.id,
            frameAttemptId,
            sha256: descriptor.sha256,
            byteLength: descriptor.byteLength,
            storageKey: descriptor.storageKey,
          };
          return {
            summary,
            descriptor,
          };
        }));
        const frameResults = frames.map((frame, index) => ({
          frameId: frame.id,
          frameAttemptId: visualDescriptors[index]!.descriptor.frame.frameAttemptId,
          width: frame.width,
          height: frame.height,
          status: "passed" as const,
          reviewed: claim.task.qaProfile.requireVisualReview,
          captureIdentity: {
            sha256: visualDescriptors[index]!.summary.sha256,
            byteLength: visualDescriptors[index]!.summary.byteLength,
            width: frame.width,
            height: frame.height,
          },
        }));
        const reviewSummary = {
          status: "passed" as const,
          fidelity: 0.99,
          evidence: visualDescriptors.map((item) => item.summary),
        };
        const qualityEvidence = {
          protocol: "dezin.standard-artifact-quality.v1",
          candidate: { commitHash: candidate.commitHash, treeHash: candidate.treeHash },
          contextPack: { id: contextPackId, hash: contextPackHash },
          frames,
          frameResults,
          round,
          ...(claim.task.qaProfile.requireRuntimeChecks ? {
            runtimeChecks: frames.map((frame) => ({ id: `frame:${frame.id}`, status: "passed" })),
          } : {}),
          ...(claim.task.qaProfile.requireVisualReview ? {
            visualReview: reviewSummary,
            visualEvidence: visualDescriptors.map((item) => item.descriptor),
          } : {}),
        };
        const evaluationManifest = {
          protocol: "dezin.artifact-run-evaluation-manifest.v1",
          candidate: { commitHash: candidate.commitHash, treeHash: candidate.treeHash },
          round,
          passed: true,
          score: 100,
          qualityState: "passed",
          findingsDigest: createHash("sha256").update("[]").digest("hex"),
          frameResults,
          ...(claim.task.qaProfile.requireRuntimeChecks ? {
            runtimeChecks: qualityEvidence.runtimeChecks,
          } : {}),
          ...(claim.task.qaProfile.requireVisualReview ? {
            reviewSummary,
            visualEvidence: visualDescriptors.map((item) => item.descriptor),
          } : {}),
        };
        return {
          kind: "artifact-candidate",
          taskId: claim.task.id,
          workspaceId: claim.task.workspaceId,
          artifactId: claim.task.target.id,
          trackId: claim.task.target.trackId,
          sourceCommitHash: candidate.commitHash,
          sourceTreeHash: candidate.treeHash,
          renderSpec: { frames },
          quality: { state: "passed", score: 100, findings: [] },
          evidence: {
            protocol: "dezin.artifact-run.v1",
            projectId: input.projectId,
            taskId: claim.task.id,
            planId: claim.task.planId,
            workspaceId: claim.task.workspaceId,
            attempt: claim.attempt.attempt,
            attemptCreatedAt: claim.attempt.createdAt,
            inputHash: claim.attempt.inputHash,
            contextPackId,
            contextPackHash,
            sourceBase: {
              commitHash: claim.attempt.sourceCommitHash,
              treeHash: claim.attempt.sourceTreeHash,
            },
            candidateRetentionRef: transaction.attemptRef,
            selectedRound: 0,
            versions: [{
              round: 0,
              commitHash: candidate.commitHash,
              treeHash: candidate.treeHash,
              passed: true,
              score: 100,
              evaluationManifest,
            }],
            ...(claim.task.qaProfile.requireRuntimeChecks ? {
              runtimeChecks: qualityEvidence.runtimeChecks,
            } : {}),
            ...(claim.task.qaProfile.requireVisualReview ? {
              visualReview: qualityEvidence.visualReview,
            } : {}),
            qualityEvidence,
          },
        };
      } finally {
        await transaction.dispose();
      }
    },
  };
}

test("production source authority accepts only the owning Sharingan Resource Revision", () => {
  const resource: Resource = {
    id: "resource-sharingan-1",
    workspaceId: "workspace-1",
    kind: "sharingan-capture" as const,
    title: "Captured source",
    headRevisionId: "revision-sharingan-1",
    defaultPinPolicy: "pin-current" as const,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const revision: ResourceRevision = {
    id: "revision-sharingan-1",
    workspaceId: "workspace-1",
    resourceId: resource.id,
    sequence: 1,
    parentRevisionId: null,
    manifestPath: "resource-revisions/revision-sharingan-1/manifest.json",
    summary: "Captured source",
    metadata: {},
    checksum: "9".repeat(64),
    provenance: {},
    createdByRunId: null,
    createdAt: 1,
  };
  const resolve = (overrides: {
    resource?: Resource;
    revision?: ResourceRevision;
  } = {}) => {
    let resourceReads = 0;
    let revisionReads = 0;
    const authority = productionSharinganSourceAuthority({
      store: {
        getResourceForProject(projectId, resourceId) {
          resourceReads += 1;
          assert.equal(projectId, "project-1");
          assert.equal(resourceId, resource.id);
          return overrides.resource ?? resource;
        },
        getResourceRevisionForWorkspace(workspaceId, revisionId) {
          revisionReads += 1;
          assert.equal(workspaceId, "workspace-1");
          assert.equal(revisionId, revision.id);
          return overrides.revision ?? revision;
        },
      },
      projectId: "project-1",
      workspaceId: "workspace-1",
      resourceId: resource.id,
      revisionId: revision.id,
    });
    return { authority, resourceReads, revisionReads };
  };

  assert.deepEqual(resolve(), {
    authority: {
      resourceId: resource.id,
      revisionId: revision.id,
      revisionChecksum: revision.checksum,
    },
    resourceReads: 1,
    revisionReads: 1,
  });
  assert.deepEqual(resolve({
    resource: { ...resource, kind: "research" },
  }), { authority: null, resourceReads: 1, revisionReads: 0 });
  assert.deepEqual(resolve({
    revision: { ...revision, resourceId: "resource-sharingan-other" },
  }), { authority: null, resourceReads: 1, revisionReads: 1 });
});

test("production Generation system recovers an approved shell and runs validation through checkpoint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-generation-system-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Production Generation", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const repositoryDir = join(root, "projects", project.id);
  await mkdir(repositoryDir, { recursive: true });
  const layout = store.workspace.getLayout(project.id);
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [],
    layoutOperations: [],
    generation: emptyGeneration(),
    rationale: "Exercise the complete production scheduler",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);

  const runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
  const unexpectedLeaf = async (): Promise<never> => assert.fail("empty Plan must not invoke Agent leaves");
  const system = createProductionGenerationSystem({
    store,
    dataDir: root,
    designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
    runtimeSupervisor,
    daemonOwnerId: "daemon-production-system-test",
    repositoryDirForWorkspace: () => repositoryDir,
    artifacts: { execute: unexpectedLeaf },
    resources: {
      execute: unexpectedLeaf,
      cleanupIfUnreferenced: async () => false,
    },
    leaseMs: 2_000,
    heartbeatMs: 500,
    pollMs: 10,
  });
  t.after(async () => {
    await system.runtime.stop();
    await runtimeSupervisor.shutdown();
  });

  await system.runtime.start();
  await waitFor(() => (
    store.workspace.getGenerationPlanForProject(project.id, approved.plan!.id).status === "succeeded"
  ));

  const detail = store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan.id);
  assert.equal(detail.plan.constructionSealed, true);
  assert.equal(detail.plan.status, "succeeded");
  assert.deepEqual(detail.tasks.map((task) => task.kind), ["prototype-validation", "checkpoint"]);
  assert.ok(detail.tasks.every((task) => task.status === "succeeded"));
  assert.deepEqual(
    detail.tasks.map((task) => task.currentAttempt),
    [1, 1],
  );
  assert.ok(store.workspace.listGenerationPlanEventsForProject(project.id, approved.plan.id)
    .some((event) => event.type === "plan-succeeded"));
});

test("production rebase maintenance never decodes terminal Generation Plan history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-generation-active-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Active Plan scan", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const repositoryDir = join(root, "projects", project.id);
  await mkdir(repositoryDir, { recursive: true });
  let historicalReads = 0;
  Object.defineProperty(store.workspace, "listGenerationPlans", {
    configurable: true,
    value: () => {
      historicalReads += 1;
      return assert.fail("maintenance must query active Plan ids directly");
    },
  });
  const runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
  const unused = async (): Promise<never> => assert.fail("no Generation Task should execute");
  const system = createProductionGenerationSystem({
    store,
    dataDir: root,
    designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
    runtimeSupervisor,
    daemonOwnerId: "daemon-active-scan-test",
    repositoryDirForWorkspace: () => repositoryDir,
    artifacts: { execute: unused },
    resources: { execute: unused, cleanupIfUnreferenced: async () => false },
  });
  t.after(async () => {
    await system.runtime.stop();
    await runtimeSupervisor.shutdown();
  });

  assert.deepEqual(await system.planService.reconcileNeedsRebaseTasks(), { planIds: [] });
  assert.equal(historicalReads, 0);
});

test("production Generation system publishes one real Resource to Component to Page DAG exactly once across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-generation-dag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storePath = join(root, "store.db");
  const repositoryDir = join(root, "projects", "generation-dag");
  await initializeRepository(repositoryDir);
  const executions: string[] = [];
  const errors: unknown[] = [];
  let store: Store | null = new Store(storePath);
  let runtimeSupervisor: RuntimeSupervisor | null = null;
  let system: ReturnType<typeof createProductionGenerationSystem> | null = null;

  try {
    const project = store.createProject({ name: "Production Generation DAG", mode: "standard" });
    store.updateSettings({
      aiProviderId: "fal",
      aiProviderEnabled: true,
      aiProviderModels: "fal-ai/flux/dev",
      aiProviderProfiles: "",
      imageApiBaseUrl: "https://images.example.test/v1",
      imageApiKey: "generation-system-image-secret",
      imageModel: "fal-ai/flux/dev",
    });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const layout = store.workspace.getLayout(project.id);
    const proposal = store.workspace.createProposal({
      projectId: project.id,
      kind: "workspace-generation",
      baseGraphRevision: workspace.graphRevision,
      baseSnapshotId: workspace.activeSnapshotId,
      layoutId: layout.layoutId,
      baseLayoutChecksum: layout.checksum,
      operations: [
        {
          id: "add-direction-moodboard",
          type: "add-node",
          node: {
            id: "direction-board-node",
            kind: "resource",
            name: "Product direction board",
            resourceId: "direction-moodboard",
            createIdentity: { resourceKind: "moodboard", defaultPinPolicy: "pin-current" },
          },
        },
        {
          id: "add-card-component",
          type: "add-node",
          node: {
            id: "card-node",
            kind: "component",
            name: "Product card",
            artifactId: "card-component",
            createIdentity: { initialTrackId: "card-track" },
          },
        },
        {
          id: "add-catalog-page",
          type: "add-node",
          node: {
            id: "catalog-node",
            kind: "page",
            name: "Catalog",
            artifactId: "catalog-page",
            createIdentity: { initialTrackId: "catalog-track" },
          },
        },
      ],
      layoutOperations: [],
      generation: nonEmptyGeneration(),
      rationale: "Generate a moodboard-backed reusable card and its catalog Page",
      assumptions: [],
    });
    const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
    assert.ok(approved.plan);

    // A corrupt, unrelated sibling must not be decoded while validation reads
    // the exact Resource Revision pinned by the generated DAG.
    store.db.prepare(
      `INSERT INTO resources (
         id, workspace_id, kind, title, head_revision_id, default_pin_policy,
         archived_at, created_at, updated_at
       ) VALUES ('unrelated-corrupt-resource', ?, 'research', 'Unrelated', NULL,
                 'manual', NULL, 1, 1)`,
    ).run(workspace.id);
    store.db.prepare(
      `INSERT INTO resource_revisions (
         id, workspace_id, resource_id, sequence, parent_revision_id,
         manifest_path, summary, metadata_json, checksum, provenance_json,
         created_by_run_id, created_at
       ) VALUES ('unrelated-corrupt-revision', ?, 'unrelated-corrupt-resource', 1, NULL,
                 'resources/unrelated-corrupt.json', 'Unrelated', '{', ?, '{}', NULL, 1)`,
    ).run(workspace.id, "f".repeat(64));

    const resources = createProductionResourceTaskExecutor({
      storageRoot: root,
      store: store.workspace,
      moodboardV2LineagePolicy: "allow-legacy-v2",
      contextPacks: { get: () => null },
      attemptContextAuthority: { resolveMoodboardAttemptContext: () => null },
      implementations: {
        async moodboard(input) {
          assert.equal(input.resourceId, "direction-moodboard");
          assert.ok(input.contextPackId.startsWith("context-pack-"));
          assert.equal(input.signal.aborted, false);
          executions.push("resource");
          const bundle = {
            format: "dezin-moodboard-resource-bundle",
            version: 2,
            board: {
              id: input.resourceId,
              name: "Product direction board",
              concept: "Editorial commerce",
              designThesis: "Use a restrained editorial system to make product comparison calm and legible.",
              contextPackId: input.contextPackId,
              createdAt: 0,
              updatedAt: 0,
            },
            nodes: [{
              id: "direction-thesis",
              boardId: input.resourceId,
              type: "note",
              x: 48,
              y: 48,
              width: 520,
              height: 240,
              rotation: 0,
              zIndex: 0,
              data: { title: "Editorial commerce", text: "Quiet hierarchy, precise product proof, decisive action." },
              createdAt: 0,
              updatedAt: 0,
            }],
            messages: [],
            assets: [],
          };
          return {
            bytes: new TextEncoder().encode(JSON.stringify(bundle)),
            mimeType: "application/json",
            summary: "Editorial commerce direction moodboard",
            metadata: { format: bundle.format, version: bundle.version, mimeType: "application/json" },
            provenance: { generator: "deterministic-moodboard-acceptance-adapter" },
            evidence: { protocol: "dezin.deterministic-resource-acceptance.v1", contextPackId: input.contextPackId },
          };
        },
      },
    });
    runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
    system = createProductionGenerationSystem({
      store,
      dataDir: root,
      designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
      runtimeSupervisor,
      daemonOwnerId: "daemon-production-dag-first",
      repositoryDirForWorkspace: () => repositoryDir,
      artifacts: deterministicArtifactLeaf({
        projectId: project.id,
        repositoryDir,
        dataDir: root,
        executions,
      }),
      resources,
      leaseMs: 5_000,
      heartbeatMs: 500,
      pollMs: 10,
      onError: (error) => errors.push(error),
    });

    const originalListSnapshots = store.workspace.listSnapshots.bind(store.workspace);
    const originalListResources = store.workspace.listResources.bind(store.workspace);
    const originalListResourceRevisions = store.workspace.listResourceRevisions.bind(store.workspace);
    store.workspace.listSnapshots = (() => assert.fail(
      "production generation must read exact Snapshots",
    )) as typeof store.workspace.listSnapshots;
    store.workspace.listResources = (() => assert.fail(
      "production generation must not scan Resources to find one Revision",
    )) as typeof store.workspace.listResources;
    store.workspace.listResourceRevisions = (() => assert.fail(
      "production generation must not scan Resource Revision history",
    )) as typeof store.workspace.listResourceRevisions;
    try {
      await system.runtime.start();
      await waitForDurableProgress({
        description: "production Generation DAG",
        read: () => store!.workspace.getGenerationPlanDetailForProject(project.id, approved.plan!.id),
        isSettled: ({ plan, tasks }) => (
          plan.status === "succeeded" || plan.status === "failed" || plan.status === "cancelled"
          || plan.status === "compile-failed"
          || tasks.some((task) => task.status === "failed" || task.status === "blocked-context")
        ),
        fingerprint: ({ plan, tasks }) => JSON.stringify({
          plan: [plan.status, plan.executionEpoch],
          tasks: tasks.map((task) => [
            task.kind,
            task.status,
            task.currentAttempt,
            task.materializationFailures,
            task.rebaseCount,
          ]),
        }),
        idleTimeoutMs: PRODUCTION_GENERATION_IDLE_TIMEOUT_MS,
        hardTimeoutMs: PRODUCTION_GENERATION_HARD_TIMEOUT_MS,
      });
    } catch (error) {
      const stalled = store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan.id);
      assert.fail(JSON.stringify({
        cause: error instanceof Error ? error.message : String(error),
        plan: stalled.plan,
        tasks: stalled.tasks.map((task) => ({
          kind: task.kind,
          status: task.status,
          failureClass: task.failureClass,
          error: task.error,
          materializationFailures: task.materializationFailures,
        })),
        executions,
        errors: errors.map((error) => error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error),
      }, null, 2));
    } finally {
      store.workspace.listSnapshots = originalListSnapshots;
      store.workspace.listResources = originalListResources;
      store.workspace.listResourceRevisions = originalListResourceRevisions;
    }

    const detail = store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan.id);
    assert.equal(detail.plan.constructionSealed, true, JSON.stringify({
      status: detail.plan.status,
      compileError: detail.plan.compileError,
      tasks: detail.tasks,
    }, null, 2));
    assert.equal(detail.plan.status, "succeeded", JSON.stringify({
      tasks: detail.tasks.map((task) => ({
        kind: task.kind,
        status: task.status,
        failureClass: task.failureClass,
        error: task.error,
        currentAttempt: task.currentAttempt,
      })),
      executions,
      errors: errors.map((error) => error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error),
    }, null, 2));
    assert.deepEqual(
      detail.tasks.map((task) => task.kind),
      ["resource", "component", "page", "prototype-validation", "checkpoint"],
    );
    assert.ok(detail.tasks.every((task) => task.status === "succeeded"));
    assert.deepEqual(detail.tasks.map((task) => task.currentAttempt), [1, 1, 1, 1, 1]);
    assert.deepEqual(executions, ["resource", "component", "page"]);
    assert.equal(errors.length, 0);

    const resourceTask = detail.tasks.find((task) => task.kind === "resource")!;
    const componentTask = detail.tasks.find((task) => task.kind === "component")!;
    const pageTask = detail.tasks.find((task) => task.kind === "page")!;
    const validationTask = detail.tasks.find((task) => task.kind === "prototype-validation")!;
    const checkpointTask = detail.tasks.find((task) => task.kind === "checkpoint")!;
    assert.ok(resourceTask.resultResourceRevisionId);
    assert.ok(componentTask.resultRevisionId);
    assert.ok(pageTask.resultRevisionId);
    assert.ok(validationTask.resultSnapshotId);
    assert.ok(checkpointTask.resultSnapshotId);

    const activeWorkspace = store.workspace.getWorkspace(project.id)!;
    const activeSnapshot = store.workspace.listSnapshots(project.id)
      .find((snapshot) => snapshot.id === activeWorkspace.activeSnapshotId)!;
    assert.equal(activeSnapshot.resourceRevisions["direction-moodboard"], resourceTask.resultResourceRevisionId);
    assert.equal(activeSnapshot.artifactRevisions["card-component"], componentTask.resultRevisionId);
    assert.equal(activeSnapshot.artifactRevisions["catalog-page"], pageTask.resultRevisionId);
    assert.equal(checkpointTask.resultSnapshotId, activeSnapshot.id);
    assert.equal(store.workspace.getTrack("card-track")?.headRevisionId, componentTask.resultRevisionId);
    assert.equal(store.workspace.getTrack("catalog-track")?.headRevisionId, pageTask.resultRevisionId);
    assert.deepEqual(
      store.workspace.listArtifactRevisionResourcePins(componentTask.resultRevisionId!)
        .map((pin) => ({
          revisionId: pin.revisionId,
          resourceId: pin.resourceId,
          resourceRevisionId: pin.resourceRevisionId,
        })),
      [{
        revisionId: componentTask.resultRevisionId,
        resourceId: "direction-moodboard",
        resourceRevisionId: resourceTask.resultResourceRevisionId,
      }],
    );
    assert.deepEqual(
      store.workspace.listArtifactRevisionDependencies(pageTask.resultRevisionId!)
        .map((dependency) => ({
          instanceId: dependency.instanceId,
          componentArtifactId: dependency.componentArtifactId,
          componentRevisionId: dependency.componentRevisionId,
          status: dependency.status,
        })),
      [{
        instanceId: "catalog-card-instance",
        componentArtifactId: "card-component",
        componentRevisionId: componentTask.resultRevisionId,
        status: "linked",
      }],
    );
    const events = store.workspace.listGenerationPlanEventsForProject(project.id, approved.plan.id);
    assert.equal(events.at(-1)?.type, "plan-succeeded");
    assert.equal(events.filter((event) => event.type === "task-succeeded").length, 5);

    const durableBeforeRestart = {
      snapshotIds: store.workspace.listSnapshots(project.id).map((snapshot) => snapshot.id),
      eventSequences: events.map((event) => event.sequence),
      componentRevisionIds: store.workspace.listRevisions(project.id, "card-component")
        .map((revision) => revision.id),
      pageRevisionIds: store.workspace.listRevisions(project.id, "catalog-page")
        .map((revision) => revision.id),
      resourceRevisionIds: store.workspace.listResourceRevisions(project.id, "direction-moodboard")
        .map((revision) => revision.id),
      revisionRefNames: git(repositoryDir, "for-each-ref", "--format=%(refname)", "refs/dezin/revisions")
        .split("\n").filter(Boolean),
    };

    await system.runtime.stop();
    await runtimeSupervisor.shutdown();
    system = null;
    runtimeSupervisor = null;
    store.close();
    store = new Store(storePath);

    const restartResources = createProductionResourceTaskExecutor({
      storageRoot: root,
      store: store.workspace,
      moodboardV2LineagePolicy: "allow-legacy-v2",
      contextPacks: { get: () => null },
      attemptContextAuthority: { resolveMoodboardAttemptContext: () => null },
      implementations: {
        async moodboard() {
          executions.push("resource-after-restart");
          throw new Error("terminal Plan must not execute a Resource again");
        },
      },
    });
    runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
    system = createProductionGenerationSystem({
      store,
      dataDir: root,
      designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
      runtimeSupervisor,
      daemonOwnerId: "daemon-production-dag-restart",
      repositoryDirForWorkspace: () => repositoryDir,
      artifacts: {
        async execute() {
          executions.push("artifact-after-restart");
          throw new Error("terminal Plan must not execute an Artifact again");
        },
      },
      resources: restartResources,
      leaseMs: 5_000,
      heartbeatMs: 500,
      pollMs: 10,
      onError: (error) => errors.push(error),
    });
    await system.runtime.start();
    await system.scheduler.tick();

    const restartedDetail = store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan.id);
    assert.equal(restartedDetail.plan.status, "succeeded");
    assert.deepEqual(restartedDetail.tasks.map((task) => task.currentAttempt), [1, 1, 1, 1, 1]);
    assert.deepEqual(executions, ["resource", "component", "page"]);
    assert.equal(errors.length, 0);
    assert.deepEqual(
      {
        snapshotIds: store.workspace.listSnapshots(project.id).map((snapshot) => snapshot.id),
        eventSequences: store.workspace.listGenerationPlanEventsForProject(project.id, approved.plan.id)
          .map((event) => event.sequence),
        componentRevisionIds: store.workspace.listRevisions(project.id, "card-component")
          .map((revision) => revision.id),
        pageRevisionIds: store.workspace.listRevisions(project.id, "catalog-page")
          .map((revision) => revision.id),
        resourceRevisionIds: store.workspace.listResourceRevisions(project.id, "direction-moodboard")
          .map((revision) => revision.id),
        revisionRefNames: git(repositoryDir, "for-each-ref", "--format=%(refname)", "refs/dezin/revisions")
          .split("\n").filter(Boolean),
      },
      durableBeforeRestart,
    );
  } finally {
    await system?.runtime.stop().catch(() => undefined);
    await runtimeSupervisor?.shutdown().catch(() => undefined);
    store?.close();
  }
});
