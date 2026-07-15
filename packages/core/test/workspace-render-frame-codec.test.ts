import assert from "node:assert/strict";
import { test } from "node:test";
import type { RenderFrameSpec } from "../src/workspace-types.ts";
import {
  normalizeCreateKernelRevisionInput,
  normalizeCreateWorkspaceProposalInput,
  normalizeUpdateWorkspaceProposalInput,
} from "../src/workspace-codecs.ts";

function frame(overrides: Partial<RenderFrameSpec> = {}): RenderFrameSpec {
  return {
    id: "desktop",
    name: "Desktop",
    width: 1440,
    height: 900,
    ...overrides,
  };
}

function generation(responsiveFrame: RenderFrameSpec) {
  return {
    kind: "workspace-generation" as const,
    resourceOperations: [],
    artifactPlans: [],
    dependencyPlans: [],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [responsiveFrame],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function normalizeKernelFrame(responsiveFrame: RenderFrameSpec): unknown {
  return normalizeCreateKernelRevisionInput({
    workspaceId: "workspace-1",
    parentRevisionId: "kernel-1",
    tokens: {},
    typography: {},
    sharedAssetRevisionIds: [],
    brief: "A durable Kernel",
    terminology: {},
    exclusions: [],
    responsiveFrames: [responsiveFrame],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  });
}

function normalizeCreateProposalFrame(responsiveFrame: RenderFrameSpec): unknown {
  return normalizeCreateWorkspaceProposalInput({
    projectId: "project-1",
    kind: "workspace-generation",
    baseGraphRevision: 0,
    baseSnapshotId: "snapshot-1",
    layoutId: "default",
    baseLayoutChecksum: "layout-checksum-1",
    operations: [],
    layoutOperations: [],
    generation: generation(responsiveFrame),
    rationale: "Generate the workspace",
    assumptions: [],
  });
}

function normalizeUpdateProposalFrame(responsiveFrame: RenderFrameSpec): unknown {
  return normalizeUpdateWorkspaceProposalInput({
    expectedProposalRevision: 1,
    operations: [],
    layoutOperations: [],
    generation: generation(responsiveFrame),
    rationale: "Revise the workspace",
    assumptions: [],
  });
}

const FRAME_NORMALIZERS = [
  ["Kernel Revision", normalizeKernelFrame],
  ["create Proposal", normalizeCreateProposalFrame],
  ["update Proposal", normalizeUpdateProposalFrame],
] as const;

function assertRejectedByEveryPersistenceBoundary(
  responsiveFrame: RenderFrameSpec,
  expected: RegExp,
  caseLabel = "invalid frame",
): void {
  for (const [label, normalize] of FRAME_NORMALIZERS) {
    assert.throws(() => normalize(responsiveFrame), expected, `${caseLabel} via ${label}`);
  }
}

function nestedFixture(containerCount: number): Record<string, unknown> {
  let value: unknown = "leaf";
  for (let index = 0; index < containerCount; index += 1) value = { next: value };
  return value as Record<string, unknown>;
}

function objectWithKeys(count: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`key-${index}`, index]));
}

test("Kernel and Proposal persistence reject render-frame text the Viewer bridge cannot accept", () => {
  const cases: Array<[string, RenderFrameSpec]> = [
    ["frame id length", frame({ id: "i".repeat(257) })],
    ["frame id C0", frame({ id: "desktop\nwide" })],
    ["frame id leading C0", frame({ id: "\ndesktop" })],
    ["frame id DEL", frame({ id: "desktop\u007fwide" })],
    ["initial state length", frame({ initialState: "s".repeat(257) })],
    ["initial state control", frame({ initialState: "ready\u0000hidden" })],
    ["initial state trailing C0", frame({ initialState: "ready\n" })],
    ["background length", frame({ background: "b".repeat(4097) })],
    ["background control", frame({ background: "red\u001fblue" })],
    ["background leading C0", frame({ background: "\tred" })],
  ];

  for (const [label, responsiveFrame] of cases) {
    assertRejectedByEveryPersistenceBoundary(
      responsiveFrame,
      /responsive frame|bridge|control|length|characters/i,
      label,
    );
  }
});

test("Kernel and Proposal persistence enforce the Viewer bridge fixture clone budget", () => {
  const nodesOverBudget = {
    groups: Array.from({ length: 16 }, () => Array.from({ length: 256 }, () => 1)),
  };
  const fixtureWithLongKey = { ["k".repeat(257)]: true };
  const fixtureWithControlKey = { ["bad\nkey"]: true };
  const fixtureWithEmptyKey = { "": true };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["depth", nestedFixture(17)],
    ["node count", nodesOverBudget],
    ["object member count", objectWithKeys(257)],
    ["array member count", { values: Array.from({ length: 257 }, () => 1) }],
    ["string length", { value: "v".repeat(8193) }],
    ["object key length", fixtureWithLongKey],
    ["object key control", fixtureWithControlKey],
    ["empty object key", fixtureWithEmptyKey],
  ];

  for (const [label, fixture] of cases) {
    assertRejectedByEveryPersistenceBoundary(
      frame({ fixture }),
      /fixture|bridge|budget|depth|nodes|members|key|string/i,
      label,
    );
  }
});

test("Kernel and Proposal persistence reject a render frame over the bridge JSON envelope limit", () => {
  const fixture = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [`chunk-${index}`, "x".repeat(8192)]),
  );
  assertRejectedByEveryPersistenceBoundary(
    frame({ initialState: "ready", background: "white", fixture }),
    /frame|bridge|JSON|envelope|65536|size/i,
  );
});

test("Kernel and Proposal persistence require fixtures to be plain cloneable JSON objects", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const withUnsafeKey = JSON.parse('{"constructor":true}') as Record<string, unknown>;
  class FixtureClass {
    value = true;
  }
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["array root", []],
    ["class instance", new FixtureClass()],
    ["Date", new Date(0)],
    ["cycle", cyclic],
    ["unsafe key", withUnsafeKey],
    ["non-finite number", { value: Number.POSITIVE_INFINITY }],
    ["function", { value: () => true }],
  ];

  for (const [label, fixture] of cases) {
    assertRejectedByEveryPersistenceBoundary(
      frame({ fixture: fixture as Record<string, unknown> }),
      /fixture|plain|JSON|unsafe|finite|cycle|object/i,
      label,
    );
  }
});

function fixtureAtBridgeNodeLimit(): Record<string, unknown> {
  return {
    groups: [
      ...Array.from({ length: 15 }, () => Array.from({ length: 256 }, () => 1)),
      Array.from({ length: 238 }, () => 1),
    ],
  };
}

function fixtureAtBridgeEnvelopeLimit(frameId: string): Record<string, unknown> {
  const fixture = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`chunk-${index}`, ""]));
  const bridgeFrame = { protocol: "dezin-frame-v1", frameId, fixture };
  let remaining = 65_536 - JSON.stringify(bridgeFrame).length;
  for (const key of Object.keys(fixture)) {
    const size = Math.min(8_192, remaining);
    fixture[key] = "x".repeat(size);
    remaining -= size;
  }
  assert.equal(remaining, 0);
  assert.equal(JSON.stringify(bridgeFrame).length, 65_536);
  return fixture;
}

test("Kernel and Proposal persistence preserve legal bridge-boundary render frames", () => {
  const frameId = "i".repeat(256);
  const responsiveFrame = frame({
    id: frameId,
    initialState: "s".repeat(256),
    background: "b".repeat(4096),
    fixture: {
      nested: nestedFixture(15),
      values: Array.from({ length: 256 }, (_, index) => index),
      text: "v".repeat(8192),
      ["k".repeat(256)]: true,
    },
  });

  const legalFrames = [
    responsiveFrame,
    frame({ fixture: nestedFixture(16) }),
    frame({ fixture: fixtureAtBridgeNodeLimit() }),
    frame({ fixture: objectWithKeys(256) }),
    frame({ id: frameId, fixture: fixtureAtBridgeEnvelopeLimit(frameId) }),
    frame({ fixture: Object.assign(Object.create(null), { value: true }) as Record<string, unknown> }),
  ];
  for (const legalFrame of legalFrames) {
    for (const [, normalize] of FRAME_NORMALIZERS) assert.doesNotThrow(() => normalize(legalFrame));
  }
});
