import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

test("Studio Agent blocks submission when no safe generation Agent is available", () => {
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

test("keeps pending Agent discovery inside the fixed submit control", () => {
  const onSubmit = vi.fn();
  const { rerender } = render(
    <WorkspaceAgentPanel
      draft="Create a calm editorial workspace"
      onDraftChange={() => {}}
      contextLabel="0 artifacts"
      onSubmit={onSubmit}
      submissionBlockedPending
      submissionBlockedReason={null}
    />,
  );

  const draft = screen.getByRole("textbox", { name: "Workspace Agent draft" });
  const submit = screen.getByRole("button", { name: "Create proposal" });
  const pendingStatus = screen.getByRole("status", { name: "Checking Agent availability…" });

  expect(pendingStatus).toHaveClass("sr-only");
  expect(submit).toBeDisabled();
  expect(submit).toHaveAttribute("aria-busy", "true");
  expect(submit).toHaveAttribute("aria-describedby", pendingStatus.id);
  expect(submit.querySelector(".animate-spin")).not.toBeNull();
  expect(submit.parentElement).toHaveAttribute("tabindex", "0");
  expect(submit.parentElement).toHaveAttribute("aria-label", "Checking Agent availability…");
  expect(screen.queryByText("Checking Agent availability…", { selector: "p" })).not.toBeInTheDocument();

  fireEvent.keyDown(draft, { key: "Enter", metaKey: true });
  expect(onSubmit).not.toHaveBeenCalled();

  draft.focus();
  rerender(
    <WorkspaceAgentPanel
      draft="Create a calm editorial workspace"
      onDraftChange={() => {}}
      contextLabel="0 artifacts"
      onSubmit={onSubmit}
      submissionBlockedPending={false}
      submissionBlockedReason={null}
    />,
  );

  expect(draft).toHaveFocus();
  expect(submit).toBeEnabled();
  expect(submit).not.toHaveAttribute("aria-busy");
  expect(screen.queryByRole("status", { name: "Checking Agent availability…" })).not.toBeInTheDocument();
  fireEvent.click(submit);
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test("keeps transient submit and attachment activity out of the footer layout", () => {
  const baseProps = {
    draft: "Refine the selected page",
    onDraftChange: () => {},
    contextLabel: "Page context",
    onSubmit: vi.fn(),
  };
  const { rerender } = render(
    <WorkspaceAgentPanel {...baseProps} submitting />,
  );

  const submit = screen.getByRole("button", { name: "Create proposal" });
  const submittingStatus = screen.getByRole("status", { name: "Workspace Agent activity" });
  expect(submittingStatus).toHaveClass("sr-only");
  expect(submittingStatus).toHaveTextContent("Creating a reviewable proposal…");
  expect(submit).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByText("Creating a reviewable proposal…", { selector: "p" })).not.toBeInTheDocument();

  rerender(<WorkspaceAgentPanel {...baseProps} attaching />);
  expect(screen.getByRole("status", { name: "Workspace Agent activity" })).toHaveTextContent(
    "Saving immutable context…",
  );
  expect(screen.queryByText("Saving immutable context…", { selector: "p" })).not.toBeInTheDocument();
});

test("keeps task history in the transcript instead of below the composer", () => {
  const onStatusClick = vi.fn();
  render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      status="Recent · Plan 123"
      onStatusClick={onStatusClick}
    />,
  );

  const status = screen.getByRole("status", { name: "Workspace Agent task status" });
  expect(status.closest("form")).toBeNull();
  expect(status.closest('[aria-label="Workspace Agent transcript"]')).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open build plan" }));
  expect(onStatusClick).toHaveBeenCalledTimes(1);
});
