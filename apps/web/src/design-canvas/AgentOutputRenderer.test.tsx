import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { AgentOutputRenderer } from "./AgentOutputRenderer.tsx";
import type { AgentOutputModel } from "./agent-panel-model.ts";

test("the typed output registry renders Thinking and real tool details in one activity disclosure", async () => {
  const user = userEvent.setup();
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
        messageCount: 3,
        items: [
          { id: "read", text: "Read design/project.json", kind: "tool", toolName: "read", rawText: "Read design/project.json", createdAt: 4 },
          {
            id: "write",
            text: "Write components.json",
            kind: "tool",
            toolName: "write",
            toolInput: JSON.stringify({ file_path: "components.json", content: "export const hero = true;" }),
            rawText: "Write components.json",
            createdAt: 5,
          },
        ],
      },
    ],
  };

  const { container } = render(<AgentOutputRenderer model={model} />);

  expect([...container.querySelectorAll("[data-agent-output-block]")].map((block) => (
    block.getAttribute("data-agent-output-block")
  ))).toEqual(["tool-group", "search", "image"]);
  expect(container.querySelectorAll('[data-dezin-agent-primitive="thinking"]')).toHaveLength(2);
  const toolGroup = container.querySelector<HTMLElement>('[data-dezin-agent-primitive="tools"]')!;
  expect(within(toolGroup).getByRole("button", { name: "2 tool calls, 1 message" })).toBeInTheDocument();
  expect(within(toolGroup).getAllByRole("listitem").map((chip) => chip.dataset.state)).toEqual(["done", "done", "active"]);
  expect(within(toolGroup).getAllByRole("listitem").map((chip) => chip.dataset.kind)).toEqual(["thinking", "read", "write"]);
  expect(within(toolGroup).getByRole("button", { name: "Thinking" })).toHaveAttribute("aria-expanded", "false");
  await user.click(within(toolGroup).getByRole("button", { name: "Write" }));
  expect(within(toolGroup).getByRole("figure")).toHaveAttribute("data-agent-component", "code-block");
  expect(within(toolGroup).getByText("export const hero = true;")).toBeInTheDocument();
});

test("an activity-free live registry renders only Loading", () => {
  const { container } = render(<AgentOutputRenderer model={{
    jobId: "job-empty-live",
    activePhase: "reasoning",
    blocks: [{
      type: "loading",
      id: "job-empty-live:loading",
      createdAt: 1,
      active: true,
      phase: null,
      status: "running",
      label: "Planning the canvas",
      startedAt: 1,
    }],
  }} />);

  expect(container.querySelector('[data-agent-output-block="loading"]')).toHaveTextContent("Planning the canvas");
  expect(container.querySelector('[data-dezin-agent-primitive="thinking"]')).toBeNull();
});

test("terminal output renders only grounded recommendation and approval actions", async () => {
  const user = userEvent.setup();
  const onRevealExport = vi.fn(async () => "revealed" as const);
  const onRetry = vi.fn(async () => {});
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
