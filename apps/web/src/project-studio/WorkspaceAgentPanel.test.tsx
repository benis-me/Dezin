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
  expect(composerActions).toHaveClass("min-w-0", "justify-between");
  expect(composerActions).not.toHaveClass("flex-wrap");
  expect(composerRouting).toBeNull();
  expect(designSystemControls).toContainElement(designSystemPicker);
  expect(designSystemControls).toHaveClass("mb-1.5");
  expect(contextRail).toHaveClass("mb-1.5", "border-b-0", "pb-0");
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
          state: "queued",
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
  expect(container.querySelector('[data-agent-turn-state="assistant-turn"]')).toHaveTextContent("queued");
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
  expect(body).toHaveClass("max-h-56", "overflow-hidden");
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
  expect(textarea).toHaveClass("field-sizing-content", "min-h-[44px]", "max-h-40");
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

test("keeps a compact restorable Plan affordance in the transcript without transient activity layout shifts", () => {
  const onOpenPlan = vi.fn();
  render(
    <WorkspaceAgentPanel
      draft=""
      onDraftChange={() => {}}
      contextLabel="Workspace"
      submissionBlockedPending
      planAffordance={{
        label: "Recent build plan",
        technicalLabel: "Build plan 123",
        onOpen: onOpenPlan,
      }}
    />,
  );

  const affordance = screen.getByRole("button", { name: "Open build plan" });
  expect(affordance).toHaveTextContent("Recent build plan");
  expect(affordance).not.toHaveTextContent("123");
  expect(affordance).toHaveAttribute("title", "Build plan 123");
  expect(affordance).toHaveClass("h-7", "max-w-full", "rounded-full");
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
