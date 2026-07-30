import type {
  Settings,
  WorkspaceGenerationAgentSelection,
} from "../../../../packages/core/src/index.ts";
import {
  freezeWorkspaceGeneratorAgentSelection,
  freezeWorkspaceReviewerAgentSelection,
} from "../../src/orchestration/generation-execution-authority.ts";

type UnfrozenAgentSelection = Omit<
  WorkspaceGenerationAgentSelection,
  "executionAuthority"
>;

/**
 * Test-only authority capture. Production-style integration fixtures should
 * freeze the same non-secret route that approval and Task hydration enforce.
 */
export function frozenGeneratorFixture(
  settings: Settings,
  selection: UnfrozenAgentSelection,
): WorkspaceGenerationAgentSelection {
  return freezeWorkspaceGeneratorAgentSelection(settings, selection);
}

export function frozenReviewerFixture(
  settings: Settings,
  selection: UnfrozenAgentSelection,
  generatingAgent: UnfrozenAgentSelection,
): WorkspaceGenerationAgentSelection {
  return freezeWorkspaceReviewerAgentSelection(
    settings,
    selection,
    generatingAgent,
  );
}
