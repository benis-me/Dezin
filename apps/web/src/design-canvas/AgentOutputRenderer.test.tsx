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
  expect([...container.querySelectorAll('[data-agent-component="trace"]')].map((trace) => (
    trace.getAttribute("data-trace-kind")
  ))).toEqual(["thinking", "search", "image"]);
  const toolGroup = container.querySelector<HTMLElement>('[data-agent-component="tool-group"]')!;
  expect(within(toolGroup).getAllByRole("listitem").map((chip) => chip.dataset.state)).toEqual(["done", "active"]);
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
  expect(trace).toHaveAttribute("data-agent-component", "trace");
  expect(trace).toHaveAttribute("data-trace-kind", "thinking");
  expect(trace).toHaveTextContent("Thinking");
});

test("terminal output renders accessible outcome, error, and export reveal controls", async () => {
  const user = userEvent.setup();
  const onRevealExport = vi.fn(async () => "revealed" as const);
  const readyOutcome = {
    type: "outcome" as const,
    id: "job-export:outcome",
    createdAt: 8,
    active: false as const,
    phase: null,
    status: "ready" as const,
    label: "Complete",
    durationMs: 7_000,
    versionId: null,
  };
  const model: AgentOutputModel = {
    jobId: "job-export",
    activePhase: null,
    blocks: [
      readyOutcome,
      {
        type: "export",
        id: "job-export:export",
        createdAt: 8,
        active: false,
        phase: null,
        exportId: "export-1",
        status: "ready",
      },
    ],
  };

  const { rerender } = render(<AgentOutputRenderer model={{
    jobId: "job-ready",
    activePhase: null,
    blocks: [readyOutcome],
  }} />);
  expect(screen.getByRole("status", { name: "Job outcome" })).toHaveTextContent("Complete · 7s");

  rerender(
    <AgentOutputRenderer
      model={model}
      projectPath="/tmp/editorial"
      onRevealExport={onRevealExport}
    />,
  );

  expect(screen.queryByRole("status", { name: "Job outcome" })).not.toBeInTheDocument();
  expect(screen.getByTitle("/tmp/editorial/design/exports/export-1")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Reveal export" }));
  expect(onRevealExport).toHaveBeenCalledWith("export-1");
  expect(await screen.findByText("Opened in Finder.")).toBeInTheDocument();

  rerender(<AgentOutputRenderer model={{
    jobId: "job-failed",
    activePhase: null,
    blocks: [{
      type: "error",
      id: "job-failed:error",
      createdAt: 9,
      active: false,
      phase: null,
      status: "failed",
      message: "Generated HTML did not pass validation",
      durationMs: 8_000,
    }],
  }} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Generated HTML did not pass validation");
});
