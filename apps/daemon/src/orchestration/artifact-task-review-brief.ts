import type { ArtifactGenerationTaskPayloadV2 } from "../../../../packages/core/src/index.ts";

/**
 * Gives Artifact QA the exact leaf responsibility without turning the
 * Workspace proposal rationale into a requirement for every individual Page
 * or Component.
 */
export function artifactTaskReviewBrief(payload: ArtifactGenerationTaskPayloadV2): string {
  const target = payload.brief.targetInstructions;
  const kind = target.kind === "component" ? "component" : "page";
  const instructions = target.instructions?.trim();
  return [
    `Review only the assigned ${kind} Artifact "${target.name}".`,
    instructions
      ? `Artifact-specific requirements: ${instructions}`
      : `Artifact-specific responsibility: produce the requested ${kind} named "${target.name}".`,
    "Scope boundary: Do not require this Artifact to render sibling Pages, Components, or the full Workspace matrix. Cross-Artifact structure and completeness are evaluated by the Workspace Plan.",
    `Workspace proposal rationale (background context only): ${payload.brief.proposalRationale}`,
  ].join("\n");
}
