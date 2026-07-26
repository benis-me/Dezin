import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactGenerationTaskPayloadV2 } from "../../../packages/core/src/index.ts";
import { artifactTaskReviewBrief } from "../src/orchestration/artifact-task-review-brief.ts";

test("Artifact review brief scopes workspace-wide rationale to the assigned Component", () => {
  const payload = {
    version: 2,
    artifactPlan: {
      operation: "create",
      nodeId: "node-schedule-row",
      artifactId: "artifact-schedule-row",
      kind: "component",
      name: "KITE Schedule Row",
      trackId: "track-main",
      baseRevisionId: null,
      dependsOnArtifactIds: [],
      capabilityIds: [],
      responsiveFrameIds: ["desktop", "mobile"],
      instructions: "Show time, venue, title, accessibility, and ticket status in dense desktop and stacked mobile states.",
    },
    dependencyPlans: [],
    responsiveFrames: [],
    brief: {
      proposalRationale: "The full workspace preserves a 3x4 matrix of twelve Pages across three directions.",
      assumptions: [],
      targetInstructions: {
        operation: "create",
        kind: "component",
        name: "KITE Schedule Row",
        instructions: "Show time, venue, title, accessibility, and ticket status in dense desktop and stacked mobile states.",
      },
    },
    capabilityDescriptors: [],
  } satisfies ArtifactGenerationTaskPayloadV2;

  const brief = artifactTaskReviewBrief(payload);

  assert.match(brief, /Review only the assigned component Artifact "KITE Schedule Row"/);
  assert.match(brief, /Show time, venue, title, accessibility/);
  assert.match(brief, /Do not require this Artifact to render sibling Pages, Components, or the full Workspace matrix/);
  assert.match(brief, /background context only/i);
  assert.match(brief, /3x4 matrix of twelve Pages/);
});
