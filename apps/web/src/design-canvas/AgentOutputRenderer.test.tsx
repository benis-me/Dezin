import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { AgentOutputRenderer } from "./AgentOutputRenderer.tsx";
import type { AgentOutputModel } from "./agent-panel-model.ts";

test("the typed output registry is the only ordered renderer input for Trace and Tool primitives", () => {
  const model: AgentOutputModel = {
    jobId: "job-live",
    activePhase: "progress",
    blocks: [
      {
        type: "trace",
        id: "job-live:reasoning",
        createdAt: 1,
        active: false,
        phase: "reasoning",
        items: [{ id: "reason", text: "Inspecting the canvas", createdAt: 1 }],
      },
      {
        type: "search",
        id: "job-live:search",
        createdAt: 2,
        active: false,
        phase: "search",
        query: "editorial references",
        items: [{ id: "search", text: "Searched the web", createdAt: 2 }],
        results: [{ id: "source", title: "Product spec", href: "https://example.com/spec", state: "done" }],
      },
      {
        type: "image",
        id: "job-live:image",
        createdAt: 3,
        active: false,
        phase: "image",
        prompt: "A quiet editorial cover",
        items: [{ id: "image", text: "Generated an image", createdAt: 3 }],
      },
      {
        type: "tool-group",
        id: "job-live:progress",
        createdAt: 4,
        active: true,
        phase: "progress",
        items: [
          { id: "read", text: "Read design/project.json", createdAt: 4 },
          { id: "write", text: "Write components.json", createdAt: 5 },
        ],
      },
    ],
  };

  const { container } = render(<AgentOutputRenderer model={model} />);

  expect([...container.querySelectorAll("[data-agent-output-block]")].map((block) => (
    block.getAttribute("data-agent-output-block")
  ))).toEqual(["trace", "search", "image", "tool-group"]);
  expect(container.querySelectorAll('[data-dezin-agent-primitive="thinking"]')).toHaveLength(3);
  const toolGroup = container.querySelector<HTMLElement>('[data-dezin-agent-primitive="tools"]')!;
  expect(within(toolGroup).getAllByRole("listitem").map((chip) => chip.dataset.state)).toEqual(["done", "active"]);
  expect(within(toolGroup).getAllByRole("listitem").map((chip) => chip.dataset.kind)).toEqual(["tool", "tool"]);
});

test("an empty live registry still renders a typed Thinking Trace", () => {
  const { container } = render(<AgentOutputRenderer model={{
    jobId: "job-empty-live",
    activePhase: "reasoning",
    blocks: [{
      type: "trace",
      id: "job-empty-live:reasoning",
      createdAt: 1,
      active: true,
      phase: "reasoning",
      items: [],
    }],
  }} />);

  const trace = container.querySelector('[data-agent-output-block="trace"]');
  expect(trace?.querySelector('[data-dezin-agent-primitive="thinking"]')).toBeInTheDocument();
  expect(trace).toHaveTextContent("Thinking");
});

test("terminal output renders Dezin recommendation, approval, insights, and real actions", async () => {
  const user = userEvent.setup();
  const onRevealExport = vi.fn(async () => "revealed" as const);
  const onRetry = vi.fn(async () => {});
  const insights = {
    type: "insights" as const,
    id: "job-export:insights",
    createdAt: 8,
    active: false as const,
    phase: null,
    title: "Run insights",
    items: [
      { id: "elapsed", label: "Elapsed", value: "7s", tone: "positive" as const },
      { id: "activity", label: "Activity", value: "4 events" },
      { id: "result", label: "Result", value: "Complete", tone: "positive" as const },
    ],
  };
  const model: AgentOutputModel = {
    jobId: "job-export",
    activePhase: null,
    blocks: [
      {
        type: "recommendation",
        id: "job-export:recommendation",
        createdAt: 8,
        active: false,
        phase: null,
        title: "Export ready",
        description: "Reveal the verified implementation output in Finder.",
        actionLabel: "Reveal export",
        versionId: null,
        exportId: "export-1",
      },
      insights,
    ],
  };

  const { rerender } = render(
    <AgentOutputRenderer
      model={model}
      projectPath="/tmp/editorial"
      onRevealExport={onRevealExport}
    />,
  );

  expect(screen.getByText("Export ready")).toBeInTheDocument();
  expect(screen.getByTitle("/tmp/editorial/design/exports/export-1")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Reveal export" }));
  expect(onRevealExport).toHaveBeenCalledWith("export-1");
  expect(await screen.findByText("Opened in Finder.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Revealed" })).toBeInTheDocument();
  expect(screen.getByText("Run insights").closest('[data-dezin-agent-primitive="insights"]')).toHaveTextContent("3");
  expect(screen.getAllByText("Elapsed")).toHaveLength(2);
  expect(screen.getByText("7s")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next insight" }));
  expect(screen.getByText("4 events").closest('[data-dezin-agent-primitive="insights"]')).toHaveTextContent(
    "Activity events persisted for this Job.",
  );
  expect(screen.getByText("4 events")).toBeInTheDocument();

  rerender(<AgentOutputRenderer model={{
    jobId: "job-failed",
    activePhase: null,
    blocks: [{
      type: "approval",
      id: "job-failed:approval",
      createdAt: 9,
      active: false,
      phase: null,
      title: "Repair this run?",
      detail: "Generated HTML did not pass validation",
      actionLabel: "Repair & retry",
    }],
  }} onRetry={onRetry} />);
  expect(screen.getByText("Generated HTML did not pass validation")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Repair & retry" }));
  expect(onRetry).toHaveBeenCalledWith("job-failed");
});

test("the production renderer uses every grounded Dezin output primitive", async () => {
  const user = userEvent.setup();
  const onRetry = vi.fn(async () => {});
  const onRevealExport = vi.fn(async () => "revealed" as const);
  const model: AgentOutputModel = {
    jobId: "job-beautiful",
    activePhase: "progress",
    blocks: [
      {
        type: "context",
        id: "context",
        createdAt: 1,
        active: false,
        phase: null,
        items: [{ id: "target", label: "Target", value: "Hero", detail: "node-hero" }],
      },
      {
        type: "loading",
        id: "loading",
        createdAt: 1,
        active: true,
        phase: null,
        status: "running",
        label: "Generating Hero",
        startedAt: 1,
      },
      {
        type: "trace",
        id: "trace",
        createdAt: 2,
        active: false,
        phase: "reasoning",
        items: [{ id: "thought", text: "Inspecting the hierarchy", createdAt: 2 }],
      },
      {
        type: "tool-group",
        id: "tools",
        createdAt: 3,
        active: true,
        phase: "progress",
        items: [{ id: "read", text: "Read design/project.json", createdAt: 3 }],
      },
      {
        type: "approval",
        id: "approval",
        createdAt: 4,
        active: false,
        phase: null,
        title: "Repair this run?",
        detail: "Generated HTML did not pass validation",
        actionLabel: "Repair & retry",
      },
      {
        type: "recommendation",
        id: "recommendation",
        createdAt: 5,
        active: false,
        phase: null,
        title: "Export ready",
        description: "Reveal the verified implementation output in Finder.",
        actionLabel: "Reveal export",
        versionId: null,
        exportId: "export-1",
      },
      {
        type: "insights",
        id: "insights",
        createdAt: 6,
        active: false,
        phase: null,
        title: "Run insights",
        items: [{ id: "elapsed", label: "Elapsed", value: "8s" }],
      },
    ],
  };

  const { container } = render(
    <AgentOutputRenderer
      model={model}
      projectPath="/tmp/editorial"
      onRetry={onRetry}
      onRevealExport={onRevealExport}
    />,
  );

  expect([...container.querySelectorAll("[data-dezin-agent-primitive]")].map((element) => (
    element.getAttribute("data-dezin-agent-primitive")
  ))).toEqual([
    "context",
    "loading",
    "thinking",
    "tools",
    "approval",
    "recommendation",
    "insights",
  ]);
  await user.click(screen.getByRole("button", { name: "Repair & retry" }));
  expect(onRetry).toHaveBeenCalledWith("job-beautiful");
  await user.click(screen.getByRole("button", { name: "Reveal export" }));
  expect(onRevealExport).toHaveBeenCalledWith("export-1");
});
