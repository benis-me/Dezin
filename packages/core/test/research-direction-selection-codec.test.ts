import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWorkspaceProposalGeneration } from "../src/workspace-codecs.ts";

function generation(selection: Record<string, unknown>) {
  return {
    kind: "workspace-generation",
    agent: {
      providerId: "codebuddy",
      command: "codebuddy",
      model: "gpt-5.6-sol",
    },
    resourceOperations: [{
      operation: "reuse",
      nodeId: "research-node",
      resourceId: "research-resource",
      kind: "research",
      title: "Immutable directions",
      revisionPolicy: {
        kind: "exact",
        resourceRevisionId: "research-revision",
      },
    }],
    artifactPlans: [{
      operation: "create",
      nodeId: "component-node",
      artifactId: "component-shared",
      kind: "component",
      name: "Shared component",
      trackId: "component-track",
      baseRevisionId: null,
      dependsOnArtifactIds: [],
      capabilityIds: [],
      responsiveFrameIds: ["desktop"],
      researchDirectionSelection: selection,
    }],
    dependencyPlans: [{
      kind: "resource",
      ownerArtifactId: "component-shared",
      resourceId: "research-resource",
    }],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [{
      id: "desktop",
      name: "Desktop",
      width: 1_440,
      height: 900,
    }],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function selection(directionIds?: unknown) {
  return {
    protocol: "dezin.research-direction-selection.v1",
    version: 1,
    resourceId: "research-resource",
    revisionId: "research-revision",
    directionId: "warm-paper",
    ...(directionIds === undefined ? {} : { directionIds }),
  };
}

test("Research direction selection codec preserves an exact ordered immutable direction set", () => {
  const normalized = normalizeWorkspaceProposalGeneration(
    generation(selection(["warm-paper", "ink-film"])),
  );
  if (normalized.kind !== "workspace-generation") assert.fail("expected Workspace generation");

  assert.deepEqual(normalized.artifactPlans[0]?.researchDirectionSelection, {
    protocol: "dezin.research-direction-selection.v1",
    version: 1,
    resourceId: "research-resource",
    revisionId: "research-revision",
    directionId: "warm-paper",
    directionIds: ["warm-paper", "ink-film"],
  });
});

test("Research direction selection codec rejects duplicate, mismatched-first, and out-of-range sets", () => {
  for (const [directionIds, pattern] of [
    [["warm-paper", "warm-paper"], /unique/i],
    [["ink-film", "warm-paper"], /first.*directionId/i],
    [["warm-paper"], /between 2 and 16/i],
    [
      Array.from({ length: 17 }, (_, index) => index === 0 ? "warm-paper" : `direction-${index}`),
      /between 2 and 16/i,
    ],
  ] as const) {
    assert.throws(
      () => normalizeWorkspaceProposalGeneration(generation(selection(directionIds))),
      pattern,
    );
  }
});
