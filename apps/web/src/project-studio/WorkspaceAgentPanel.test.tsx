import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { ToastProvider } from "../components/Toast.tsx";
import { WorkspaceAgentPanel } from "./WorkspaceAgentPanel.tsx";

afterEach(cleanup);

test("Studio Agent restores project navigation, Agent selection, and Design System selection", async () => {
  const user = userEvent.setup();
  const onBackHome = vi.fn();
  const onAgentChange = vi.fn();
  const onModelChange = vi.fn();
  const onDesignSystemChange = vi.fn();

  const { container } = render(
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
  expect(back).toHaveAttribute("title", "Back to projects · Atlas");
  await user.click(back);
  expect(onBackHome).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "Agent and model" }));
  await user.click(await screen.findByRole("button", { name: /Claude/ }));
  expect(onAgentChange).toHaveBeenCalledWith("claude");
  await user.keyboard("{Escape}");

  await user.click(screen.getByRole("button", { name: "Design system" }));
  await user.click(await screen.findByRole("button", { name: /No design system/ }));
  expect(onDesignSystemChange).toHaveBeenCalledWith("");

  const composerShell = container.querySelector("[data-agent-composer-shell]");
  const composerActions = container.querySelector("[data-workspace-agent-actions]");
  const designSystemControls = container.querySelector("[data-workspace-agent-design-system]");
  const agentPicker = screen.getByRole("button", { name: "Agent and model" });
  const designSystemPicker = screen.getByRole("button", { name: "Design system" });
  expect(composerShell).not.toBeNull();
  expect(composerShell).toContainElement(screen.getByRole("textbox", { name: "Workspace Agent draft" }));
  expect(composerShell).toContainElement(agentPicker);
  expect(composerShell).not.toContainElement(designSystemPicker);
  expect(composerActions).toContainElement(agentPicker);
  expect(designSystemControls).toContainElement(designSystemPicker);
  expect(composerActions).not.toHaveClass("border-t");
  expect(composerActions).not.toHaveClass("flex-wrap");
});

test("keeps Design System above the composer and Agent selection beside send", () => {
  const { container } = render(
    <WorkspaceAgentPanel
      draft="Refine this page"
      onDraftChange={() => {}}
      contextLabel="Page"
      contextItems={[
        {
          id: "context-1",
          type: "text-context",
          title: "Editorial direction",
          body: "Use a restrained editorial hierarchy.",
        },
      ]}
      onContextItemsChange={() => {}}
      onRemoveContextItem={() => {}}
      onSubmit={() => {}}
      onAttachFiles={() => {}}
      agents={[
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: ["default"] },
      ]}
      agent="codebuddy"
      model="default"
      onAgentChange={() => {}}
      onModelChange={() => {}}
      onRescanAgents={async () => {}}
      designSystems={[
        { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
      ]}
      designSystemId="modern-minimal"
      onDesignSystemChange={() => {}}
    />,
  );

  const composerShell = container.querySelector("[data-agent-composer-shell]");
  const composerActions = container.querySelector("[data-workspace-agent-actions]");
  const designSystemControls = container.querySelector("[data-workspace-agent-design-system]");
  const composerRouting = container.querySelector("[data-workspace-agent-routing]");
  const agentPicker = screen.getByRole("button", { name: "Agent and model" });
  const designSystemPicker = screen.getByRole("button", { name: "Design system" });
  const contextRail = screen.getByRole("list", { name: "Selected Agent Context" });
  const attach = screen.getByRole("button", { name: "Add files and context" });
  const submit = screen.getByRole("button", { name: "Create proposal" });
  expect(composerShell).not.toBeNull();
  expect(composerShell).not.toContainElement(contextRail);
  expect(composerShell).toContainElement(attach);
  expect(composerShell).not.toContainElement(designSystemPicker);
  expect(composerShell).toContainElement(agentPicker);
  expect(composerShell).toContainElement(submit);
  expect(agentPicker).toHaveTextContent("CodeBuddy");
  expect(composerActions).toContainElement(attach);
  expect(composerActions).toContainElement(submit);
  expect(composerActions).toContainElement(agentPicker);
  expect(composerActions).not.toContainElement(designSystemPicker);
  expect(composerActions).toHaveAttribute("data-workspace-agent-actions");
  expect(composerActions).not.toHaveClass("flex-wrap");
  expect(composerRouting).toBeNull();
  expect(designSystemControls).toContainElement(designSystemPicker);
  expect(designSystemControls).toHaveAttribute("data-workspace-agent-design-system");
  expect(contextRail).toHaveAttribute("aria-label", "Selected Agent Context");
  expect(
    designSystemControls!.compareDocumentPosition(composerShell!) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    contextRail.compareDocumentPosition(composerShell!) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("renders user and assistant turns with the shared Dezin message hierarchy and rich text", () => {
  const { container } = render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      transcript={[
        {
          id: "user-turn",
          turnId: "turn-user",
          role: "user",
          content: "**Keep** the hierarchy.",
          createdAt: 1,
          state: "submitted",
        },
        {
          id: "assistant-turn",
          turnId: "turn-assistant",
          role: "assistant",
          content: "## Proposal\n- Preserve the rhythm",
          createdAt: 2,
          state: "submitted",
        },
      ]}
    />,
  );

  const userMessage = container.querySelector('[data-agent-message-body="user"]');
  const assistantMessage = container.querySelector('[data-agent-message-body="assistant"]');
  expect(userMessage).not.toBeNull();
  expect(assistantMessage).not.toBeNull();
  expect(userMessage).toHaveClass("rounded-2xl", "rounded-br-md", "bg-surface-2", "text-sm");
  expect(userMessage).not.toHaveClass("border");
  expect(within(userMessage as HTMLElement).getByText("Keep").tagName).toBe("STRONG");
  expect(assistantMessage).toHaveClass("text-sm");
  expect(assistantMessage).not.toHaveClass("border", "bg-card");
  expect(within(assistantMessage as HTMLElement).getByRole("heading", { name: "Proposal" })).toBeInTheDocument();
  expect(within(assistantMessage as HTMLElement).getByRole("listitem")).toHaveTextContent("Preserve the rhythm");
  expect(container.querySelector('[data-agent-message-meta="user-turn"]')).toHaveTextContent("You");
  expect(container.querySelector('[data-agent-turn-state="user-turn"]')).toHaveTextContent("Sent");
  expect(container.querySelector('[data-agent-message-meta="assistant-turn"]')).toHaveTextContent("Dezin Agent");
  expect(container.querySelector('[data-agent-turn-state="assistant-turn"]')).toHaveTextContent("Working");
  expect(container.querySelector('[data-agent-message-meta="user-turn"] time')).toHaveAttribute(
    "datetime",
    new Date(1).toISOString(),
  );
  expect(container.querySelector('[data-agent-message-meta="assistant-turn"] time')).toHaveAttribute(
    "datetime",
    new Date(2).toISOString(),
  );
  expect(container.querySelector('[data-agent-turn-state="assistant-turn"]')).not.toHaveTextContent("submitted");
});

test("turns queued planner identifiers into designer-readable build status", () => {
  const { container } = render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      transcript={[{
        id: "assistant-queued",
        turnId: "turn-assistant-queued",
        role: "assistant",
        content: "Queued Task 2e1b3d46-192e-42e0-8f9a-8e4b1190a3ca in Plan 7b8e2a00-2da2-48cc-af17-f607f942194b.",
        createdAt: 1,
        state: "queued",
      }]}
    />,
  );

  expect(screen.getByText("Design work is queued in the build plan.")).toBeInTheDocument();
  expect(container.querySelector('[data-agent-trace-state="queued"]')).not.toBeNull();
  expect(container.querySelector('[data-agent-turn-state="assistant-queued"]')).toHaveTextContent("Build queued");
  expect(screen.queryByText(/2e1b3d46|7b8e2a00/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open build plan" })).not.toBeInTheDocument();
  expect(container.querySelector('[data-agent-turn-state="assistant-queued"]')).not.toHaveTextContent(/^queued$/i);
});

test("opens traceable proposal and build cards without exposing their persisted identities", async () => {
  const user = userEvent.setup();
  const onOpenTrace = vi.fn();
  const proposal = {
    id: "assistant-proposal-history",
    turnId: "turn-assistant-proposal-history",
    role: "assistant" as const,
    content: "Proposal proposal-long-internal-id is ready.",
    createdAt: 1,
    state: "proposal" as const,
    proposalId: "proposal-long-internal-id",
  };
  const queued = {
    id: "assistant-queued-history",
    turnId: "turn-assistant-queued-history",
    role: "assistant" as const,
    content: "Queued task-long-internal-id in plan-long-internal-id.",
    createdAt: 2,
    state: "queued" as const,
    planId: "plan-long-internal-id",
    taskId: "task-long-internal-id",
    resultRevisionId: "revision-long-internal-id",
  };
  const { container } = render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      transcript={[proposal, queued]}
      onOpenTrace={onOpenTrace}
    />,
  );

  expect(container.querySelectorAll("[data-agent-trace-state]")).toHaveLength(2);
  expect(screen.getByText("A reviewable workspace proposal is ready.")).toBeInTheDocument();
  expect(screen.getByText("Design work is queued in the build plan.")).toBeInTheDocument();
  expect(screen.queryByText(/proposal-long|plan-long|task-long|revision-long/)).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Review proposal" }));
  await user.click(screen.getByRole("button", { name: "View in plan" }));
  expect(onOpenTrace).toHaveBeenNthCalledWith(1, proposal);
  expect(onOpenTrace).toHaveBeenNthCalledWith(2, queued);
});

test("projects failed and cancelled terminal Plans into readable transcript states", () => {
  const { container } = render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      transcript={[
        {
          id: "assistant-failed",
          turnId: "turn-assistant-failed",
          role: "assistant",
          content: "plan-sensitive-failed task-sensitive-failed",
          createdAt: 1,
          state: "queued",
          trace: { status: "failed", planId: "plan-sensitive-failed", taskId: "task-sensitive-failed" },
        },
        {
          id: "assistant-cancelled",
          turnId: "turn-assistant-cancelled",
          role: "assistant",
          content: "plan-sensitive-cancelled task-sensitive-cancelled",
          createdAt: 2,
          state: "queued",
          trace: { status: "cancelled", planId: "plan-sensitive-cancelled", taskId: "task-sensitive-cancelled" },
        },
      ]}
      onOpenTrace={() => {}}
    />,
  );

  expect(container.querySelector("[data-agent-trace-state='failed']")).toHaveTextContent("Build needs attention");
  expect(container.querySelector("[data-agent-trace-state='cancelled']")).toHaveTextContent("Build cancelled");
  expect(container.querySelector('[data-agent-turn-state="assistant-failed"]')).toHaveTextContent("Needs attention");
  expect(container.querySelector('[data-agent-turn-state="assistant-cancelled"]')).toHaveTextContent("Cancelled");
  expect(screen.queryByText(/plan-sensitive|task-sensitive/)).not.toBeInTheDocument();
});

test("renders a durable proposal failure with the retained brief and a direct retry", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  const { container } = render(
    <WorkspaceAgentPanel
      draft="Build three complete visual directions"
      onDraftChange={() => {}}
      contextLabel="Workspace"
      onSubmit={onSubmit}
      transcript={[{
        id: "assistant-failed-proposal",
        turnId: "turn-sensitive-internal-id",
        role: "assistant",
        content: "Workspace Planner is unavailable: structured Agent timed out",
        createdAt: 1,
        state: "failed",
      }]}
    />,
  );

  const failure = container.querySelector("[data-agent-trace-state='failed']");
  expect(failure).toHaveTextContent("Needs attention");
  expect(failure).toHaveTextContent("Workspace Planner is unavailable: structured Agent timed out");
  expect(failure).toHaveTextContent("Your brief is retained");
  expect(failure).not.toHaveTextContent("turn-sensitive-internal-id");
  expect(container.querySelector('[data-agent-turn-state="assistant-failed-proposal"]'))
    .toHaveTextContent("Needs attention");

  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test("keeps a long Workspace brief compact until the reader expands it", async () => {
  const user = userEvent.setup();
  const brief = Array.from(
    { length: 14 },
    (_, index) => `Direction ${index + 1}: preserve a distinct, designer-readable decision.`,
  ).join("\n");
  const { container } = render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      transcript={[{
        id: "long-user-brief",
        turnId: "turn-long-user-brief",
        role: "user",
        content: brief,
        createdAt: 1,
        state: "submitted",
      }]}
    />,
  );

  const body = container.querySelector('[data-agent-message-body="user"]');
  expect(body).toHaveAttribute("data-agent-message-body", "user");
  const expand = screen.getByRole("button", { name: "Show full brief" });
  expect(expand).toHaveAttribute("aria-expanded", "false");

  await user.click(expand);
  expect(body).not.toHaveClass("max-h-56", "overflow-hidden");
  expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  expect(body).toHaveTextContent("Direction 14");
});

test("estimates dense CJK briefs by visual width before collapsing them", () => {
  render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      transcript={[{
        id: "dense-cjk-brief",
        turnId: "turn-dense-cjk-brief",
        role: "user",
        content: "继续完善多页面设计、组件关系、研究证据和设计方向。".repeat(10),
        createdAt: 1,
        state: "submitted",
      }]}
    />,
  );

  expect(screen.getByRole("button", { name: "Show full brief" })).toBeInTheDocument();
});

test("summarizes the active proposal with a change count and Review action instead of its internal id", async () => {
  const user = userEvent.setup();
  const onReview = vi.fn();
  render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      transcript={[{
        id: "assistant-proposal",
        turnId: "turn-assistant-proposal",
        role: "assistant",
        content: "Proposal 2e1b3d46-192e-42e0-8f9a-8e4b1190a3ca is ready for review.",
        createdAt: 1,
        state: "proposal",
      }]}
      proposalAffordance={{
        summary: "Create three distinct festival directions with shared components.",
        changeCount: 9,
        onOpen: onReview,
      }}
    />,
  );

  expect(screen.getByRole("heading", { name: "Proposal ready" })).toBeInTheDocument();
  expect(screen.getByText("Create three distinct festival directions with shared components.")).toBeInTheDocument();
  expect(screen.getByText("9 changes")).toBeInTheDocument();
  expect(screen.queryByText(/2e1b3d46/)).not.toBeInTheDocument();
  expect(screen.getByText("Ready for review")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Review proposal" }));
  expect(onReview).toHaveBeenCalledOnce();
});

test("uses the mature Dezin 44px content-sized composer with a 160px ceiling", () => {
  render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
    />,
  );
  const textarea = screen.getByRole("textbox", { name: "Workspace Agent draft" });
  expect(textarea).toHaveAttribute("id", "workspace-agent-draft");
  expect(textarea).not.toHaveClass("min-h-[72px]");
  expect(textarea).toHaveAttribute("rows", "1");
});

test("preserves the reader's history position when a newer Agent turn arrives", () => {
  const transcript = [
    {
      id: "turn-1",
      turnId: "turn-1",
      role: "assistant" as const,
      content: "First answer",
      createdAt: 1,
      state: "proposal" as const,
    },
    {
      id: "turn-2",
      turnId: "turn-2",
      role: "assistant" as const,
      content: "Second answer",
      createdAt: 2,
      state: "proposal" as const,
    },
  ];
  const renderPanel = (entries: typeof transcript) => (
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      transcript={entries}
    />
  );
  const { rerender } = render(renderPanel(transcript));
  const transcriptScroll = screen.getByLabelText("Workspace Agent transcript");
  Object.defineProperties(transcriptScroll, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, value: 100, writable: true },
    scrollTo: { configurable: true, value: vi.fn() },
  });

  fireEvent.scroll(transcriptScroll);
  const scrollToLatest = screen.getByRole("button", { name: "Scroll to latest" });
  expect(scrollToLatest).toBeInTheDocument();
  const scrollTo = transcriptScroll.scrollTo as ReturnType<typeof vi.fn>;
  scrollTo.mockClear();

  rerender(renderPanel([
    ...transcript,
    {
      id: "turn-3",
      turnId: "turn-3",
      role: "assistant",
      content: "Newest answer",
      createdAt: 3,
      state: "proposal" as const,
    },
  ]));

  expect(transcriptScroll.scrollTop).toBe(100);
  expect(scrollTo).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Scroll to latest" })).toBeInTheDocument();
});

test("restores transcript auto-follow after the reader chooses Scroll to latest", () => {
  const transcript = [{
    id: "turn-1",
    turnId: "turn-1",
    role: "assistant" as const,
    content: "First answer",
    createdAt: 1,
    state: "proposal" as const,
  }];
  const renderPanel = (status: string | null) => (
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      transcript={transcript}
      status={status}
    />
  );
  const { rerender } = render(renderPanel(null));
  const transcriptScroll = screen.getByLabelText("Workspace Agent transcript");
  const scrollTo = vi.fn();
  Object.defineProperties(transcriptScroll, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, value: 100, writable: true },
    scrollTo: { configurable: true, value: scrollTo },
  });

  fireEvent.scroll(transcriptScroll);
  fireEvent.click(screen.getByRole("button", { name: "Scroll to latest" }));
  expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "smooth" });
  expect(screen.queryByRole("button", { name: "Scroll to latest" })).not.toBeInTheDocument();

  scrollTo.mockClear();
  Object.defineProperty(transcriptScroll, "scrollHeight", { configurable: true, value: 1_200 });
  rerender(renderPanel("Queued · Plan 123"));
  expect(scrollTo).toHaveBeenCalledWith({ top: 1_200, behavior: "auto" });
  expect(screen.queryByRole("button", { name: "Scroll to latest" })).not.toBeInTheDocument();
});

test("passes Design System catalog failure and retry through the Agent composer", async () => {
  const user = userEvent.setup();
  const onRetryDesignSystems = vi.fn();
  render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      designSystems={[]}
      designSystemId="modern-minimal"
      onDesignSystemChange={() => {}}
      designSystemCatalogStatus="error"
      onRetryDesignSystems={onRetryDesignSystems}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Design system" }));
  const dialog = await screen.findByRole("dialog", { name: "Choose Design system" });
  expect(within(dialog).getByRole("alert")).toHaveTextContent("Couldn't load design systems.");
  await user.click(within(dialog).getByRole("button", { name: "Retry loading design systems" }));
  expect(onRetryDesignSystems).toHaveBeenCalledOnce();
});

test("Studio Agent reports a blocked submission through the global toast without changing the composer", () => {
  const onSubmit = vi.fn();
  const { container } = render(
    <ToastProvider>
      <WorkspaceAgentPanel
        draft="Build the complete workspace"
        onDraftChange={vi.fn()}
        contextLabel="Workspace"
        onSubmit={onSubmit}
        submissionBlockedReason="Claude is required for safe Design Workspace generation."
      />
    </ToastProvider>,
  );

  expect(screen.getByRole("button", { name: "Create proposal" })).toBeDisabled();
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(
    "Claude is required for safe Design Workspace generation.",
  );
  expect(alert.closest('[aria-label="Notifications"]')).not.toBeNull();
  expect(container.querySelector("[data-workspace-agent-error]")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Workspace Agent draft" })).not.toHaveAttribute("aria-invalid");
});

test("keeps pending Agent discovery accessible without changing the fixed submit icon", () => {
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
  expect(submit.querySelector("[data-agent-submit-icon]")).not.toBeNull();
  expect(submit.querySelector(".animate-spin")).toBeNull();
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

test("shows proposal thinking in the transcript while keeping attachment activity layout-free", () => {
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
  const submittingStatus = screen.getByRole("status", { name: "Workspace Agent proposal progress" });
  expect(submittingStatus).toHaveAttribute("data-agent-proposal-progress");
  expect(submittingStatus).not.toHaveClass("sr-only");
  expect(submittingStatus).toHaveTextContent("Dezin Agent");
  expect(submittingStatus).toHaveTextContent("Thinking");
  expect(screen.getByRole("heading", { name: "Creating a reviewable proposal…" })).toBeInTheDocument();
  expect(submittingStatus).toHaveTextContent(
    "Reviewing the brief and exact context before the next design action.",
  );
  expect(submit).toHaveAttribute("aria-busy", "true");
  expect(submit.querySelector("[data-agent-submit-icon]")).not.toBeNull();
  expect(submit.querySelector(".animate-spin")).toBeNull();
  expect(submittingStatus.querySelector("svg")).not.toBeNull();

  rerender(<WorkspaceAgentPanel {...baseProps} attaching />);
  expect(screen.getByRole("status", { name: "Workspace Agent activity" })).toHaveTextContent(
    "Saving immutable context…",
  );
  expect(screen.queryByRole("status", { name: "Workspace Agent proposal progress" })).not.toBeInTheDocument();
  expect(screen.queryByText("Saving immutable context…", { selector: "p" })).not.toBeInTheDocument();
});

test("reports an Agent error once through the global toast without a persistent composer error", () => {
  const message = "Workspace Planner returned an invalid structured response with additional diagnostic detail.";
  const view = (contextLabel: string) => (
    <ToastProvider>
      <WorkspaceAgentPanel
        draft="Retry this exact workspace"
        onDraftChange={() => {}}
        contextLabel={contextLabel}
        error={message}
      />
    </ToastProvider>
  );
  const { container, rerender } = render(view("Workspace"));

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(message);
  expect(alert.closest('[aria-label="Notifications"]')).not.toBeNull();
  expect(container.querySelector("[data-workspace-agent-error]")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Workspace Agent draft" })).not.toHaveAttribute("aria-invalid");

  rerender(view("Page"));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

test("presents a structured Build activity card with live status and plan access", () => {
  const onOpenPlan = vi.fn();
  render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      submissionBlockedPending
      planAffordance={{
        open: false,
        status: "Building approved design changes",
        onToggle: onOpenPlan,
      }}
    />,
  );

  const affordance = screen.getByRole("button", { name: "Open build plan" });
  const activity = screen.getByLabelText("Build activity");
  expect(activity).toHaveAttribute("data-agent-build-activity");
  expect(within(activity).getByRole("heading", { name: "Build activity" })).toBeInTheDocument();
  expect(activity).toHaveTextContent("Building approved design changes");
  expect(affordance).toHaveTextContent("Open build plan");
  expect(affordance).not.toHaveTextContent("123");
  expect(affordance.closest("[data-agent-build-activity]")).not.toBeNull();
  expect(affordance).not.toHaveClass("rounded-full");
  expect(affordance.closest("form")).toBeNull();
  expect(affordance.closest('[aria-label="Workspace Agent transcript"]')).not.toBeNull();
  expect(screen.queryByRole("status", { name: "Workspace Agent task status" })).not.toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Checking Agent availability…" })).toHaveClass("sr-only");

  fireEvent.click(affordance);
  expect(onOpenPlan).toHaveBeenCalledTimes(1);
});

test("keeps the transcript and composer on one uninterrupted surface", () => {
  const { container } = render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
    />,
  );

  const composerRegion = container.querySelector("[data-workspace-agent-composer]");
  expect(composerRegion).not.toBeNull();
  expect(composerRegion).not.toHaveClass("border-t");
  expect(composerRegion).not.toHaveClass("border-border");
});
