import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceAgentPanel } from "./WorkspaceAgentPanel.tsx";

afterEach(cleanup);

test("Studio Agent restores project navigation, Agent selection, and Design System selection", async () => {
  const user = userEvent.setup();
  const onBackHome = vi.fn();
  const onAgentChange = vi.fn();
  const onModelChange = vi.fn();
  const onDesignSystemChange = vi.fn();

  render(
    <WorkspaceAgentPanel
      projectName="Atlas"
      onBackHome={onBackHome}
      draft=""
      onDraftChange={vi.fn()}
      contextLabel="2 artifacts"
      agents={[
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5"] },
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
      ]}
      agent="codex"
      model="gpt-5"
      onAgentChange={onAgentChange}
      onModelChange={onModelChange}
      onRescanAgents={vi.fn(async () => {})}
      designSystems={[
        { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
      ]}
      designSystemId="modern-minimal"
      onDesignSystemChange={onDesignSystemChange}
    />,
  );

  const back = screen.getByRole("button", { name: "Back to projects" });
  expect(back).toHaveTextContent("Atlas");
  await user.click(back);
  expect(onBackHome).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "Agent and model" }));
  await user.click(await screen.findByRole("button", { name: /Claude/ }));
  expect(onAgentChange).toHaveBeenCalledWith("claude");
  await user.keyboard("{Escape}");

  await user.click(screen.getByRole("button", { name: "Design system" }));
  await user.click(await screen.findByRole("button", { name: /No design system/ }));
  expect(onDesignSystemChange).toHaveBeenCalledWith("");
});

test("Studio Agent blocks submission when no safe generation Agent is available", async () => {
  const onSubmit = vi.fn();
  render(
    <WorkspaceAgentPanel
      draft="Build the complete workspace"
      onDraftChange={vi.fn()}
      contextLabel="Workspace"
      onSubmit={onSubmit}
      submissionBlockedReason="Claude is required for safe Design Workspace generation."
    />,
  );

  expect(screen.getByRole("button", { name: "Create proposal" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Claude is required for safe Design Workspace generation.",
  );
});
