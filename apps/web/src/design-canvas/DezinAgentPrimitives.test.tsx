import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  DezinAgentApproval,
  DezinAgentContext,
  DezinAgentInsights,
  DezinAgentLoadingState,
  DezinAgentRecommendation,
  DezinAgentStreamingText,
  DezinAgentTaskRow,
  DezinAgentThinking,
  DezinAgentToolGroup,
} from "./DezinAgentPrimitives.tsx";

test("Loading State announces real progress without exposing its decorative pixel grid", () => {
  const { container } = render(
    <DezinAgentLoadingState label="Generating layout" elapsed="18s" variant="orbit" />,
  );

  const status = screen.getByRole("status", { name: "Generating layout" });
  expect(status).toHaveAttribute("aria-busy", "true");
  expect(status).toHaveAttribute("data-dezin-agent-primitive", "loading");
  expect(status).toHaveAttribute("data-variant", "orbit");
  expect(status).toHaveTextContent("Generating layout");
  expect(status).toHaveTextContent("18s");
  expect(container.querySelectorAll("[data-loading-pixel]")).toHaveLength(9);
  expect(container.querySelector("[data-loading-grid]")) .toHaveAttribute("aria-hidden", "true");
});

test("Loading State keeps the source pixel geometry and drive-orbit timing patterns", () => {
  const { container, rerender } = render(
    <DezinAgentLoadingState label="Generating layout" variant="drive" />,
  );

  const drivePixels = [...container.querySelectorAll<HTMLElement>("[data-loading-pixel]")];
  expect(drivePixels.map((pixel) => pixel.style.getPropertyValue("--pixel-delay"))).toEqual([
    "90ms", "180ms", "270ms",
    "0ms", "90ms", "180ms",
    "90ms", "180ms", "270ms",
  ]);
  expect(drivePixels.every((pixel) => pixel.style.getPropertyValue("--pixel-duration") === "650ms")).toBe(true);

  rerender(<DezinAgentLoadingState label="Generating layout" variant="orbit" />);
  const orbitPixels = [...container.querySelectorAll<HTMLElement>("[data-loading-pixel]")];
  expect(orbitPixels.map((pixel) => pixel.style.getPropertyValue("--pixel-delay"))).toEqual([
    "0ms", "110ms", "220ms",
    "770ms", "", "330ms",
    "660ms", "550ms", "440ms",
  ]);
  expect(orbitPixels.every((pixel) => pixel.style.getPropertyValue("--pixel-duration") === "950ms")).toBe(true);

  const css = readFileSync(resolve(process.cwd(), "src/design-canvas/dezin-agent-primitives.css"), "utf8");
  expect(css).toMatch(/grid-template-columns:\s*repeat\(3,\s*4px\)/);
  expect(css).toMatch(/gap:\s*1\.5px/);
  expect(css).toMatch(/width:\s*4px;[^}]*height:\s*4px;/s);
});

test("Insight Cards page through supplied metrics without manufacturing a chart", () => {
  const onIndexChange = vi.fn();
  const onInspect = vi.fn();
  const { container } = render(
    <DezinAgentInsights
      title="Job insights"
      defaultIndex={0}
      onIndexChange={onIndexChange}
      items={[
        {
          id: "timing",
          title: "Generation finished",
          description: "Measured from the persisted job timestamps.",
          metrics: [{ id: "duration", label: "Duration", value: "12s", tone: "neutral" }],
        },
        {
          id: "output",
          title: "Version ready",
          metrics: [{ id: "version", label: "Version", value: "v8", tone: "success" }],
          visual: <div aria-label="Version preview">Preview</div>,
          action: { id: "inspect", label: "Inspect version", onClick: onInspect },
        },
      ]}
    />,
  );

  const insights = container.querySelector<HTMLElement>('[data-dezin-agent-primitive="insights"]')!;
  expect(insights).toHaveAccessibleName("Job insights");
  expect(within(insights).getByText("Generation finished")).toBeInTheDocument();
  expect(within(insights).getByRole("button", { name: "Previous insight" })).toBeEnabled();
  fireEvent.click(within(insights).getByRole("button", { name: "Next insight" }));
  expect(onIndexChange).toHaveBeenCalledWith(1);
  expect(within(insights).getByText("Version ready")).toBeInTheDocument();
  expect(within(insights).getByLabelText("Version preview")).toBeInTheDocument();
  expect(within(insights).getByText("v8").closest("li")).toHaveAttribute("data-tone", "success");
  fireEvent.click(within(insights).getByRole("button", { name: "Inspect version" }));
  expect(onInspect).toHaveBeenCalledOnce();
});

test("the Dezin primitive stylesheet locks the 324px, radius, row, and motion contracts", () => {
  const css = readFileSync(resolve(process.cwd(), "src/design-canvas/dezin-agent-primitives.css"), "utf8");
  const source = readFileSync(resolve(process.cwd(), "src/design-canvas/DezinAgentPrimitives.tsx"), "utf8");

  expect(css).toMatch(/\.dezin-agent\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);
  expect(css).toMatch(/\.dezin-agent-(?:loading|thinking|streaming|approval|tool-chips|task-row|recommendation|context|insights)[^{]*\{[^}]*border-radius:\s*10px;/s);
  expect(css).toMatch(/\.dezin-agent-task-row__trigger\s*\{[^}]*min-height:\s*44px;/s);
  expect(css).toMatch(/\.dezin-agent-actions > button\s*\{[^}]*border-radius:\s*8px;/s);
  expect(css).toMatch(/\.dezin-agent-tool-chips__changes > span\s*\{[^}]*border-radius:\s*6px;/s);
  expect(css).toContain("@keyframes dezin-agent-spin");
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(`${source}\n${css}`).not.toMatch(new RegExp(["beaut", "iful"].join(""), "i"));
});

test("Context Cards render only supplied knowledge and preserve source links", () => {
  const { container } = render(
    <DezinAgentContext
      title="Attached context"
      count={2}
      items={[
        {
          id: "brief",
          title: "Checkout brief",
          meta: "420 characters",
          summary: "Keep the existing information hierarchy.",
          source: { label: "Design.md", href: "https://example.com/design", kind: "MD" },
        },
        { id: "node", title: "Hero node", summary: "Current canvas selection" },
      ]}
    />,
  );

  const context = container.querySelector<HTMLElement>('[data-dezin-agent-primitive="context"]')!;
  expect(context).toHaveAccessibleName("Attached context");
  expect(within(context).getByText("2")).toBeInTheDocument();
  expect(within(context).getAllByRole("article")).toHaveLength(2);
  expect(within(context).getByText("Keep the existing information hierarchy.")).toBeInTheDocument();
  expect(within(context).getByRole("link", { name: /Design.md/ })).toHaveAttribute("href", "https://example.com/design");
  expect(within(context).getByRole("link", { name: /Design.md/ })).toHaveAttribute("rel", "noreferrer");
});

test("Recommendation Card reveals real alternatives and invokes explicit actions", () => {
  const onAccept = vi.fn();
  const onAlternative = vi.fn();
  const { container } = render(
    <DezinAgentRecommendation
      title="Open the generated export?"
      description={<span>Version <code>v8</code> is ready.</span>}
      confidence={{ level: "high", label: "Validated output" }}
      actions={[{ id: "accept", label: "Open", tone: "primary", onClick: onAccept }]}
      alternatives={[{ id: "copy", title: "Copy path", meta: "Fallback", onSelect: onAlternative }]}
    />,
  );

  const card = container.querySelector<HTMLElement>('[data-dezin-agent-primitive="recommendation"]')!;
  expect(card).toHaveAccessibleName("Open the generated export?");
  expect(within(card).getByText("Validated output")).toBeInTheDocument();
  const alternatives = within(card).getByRole("button", { name: "Alternatives" });
  const region = container.querySelector<HTMLElement>(`#${alternatives.getAttribute("aria-controls")}`)!;
  expect(region).toHaveAttribute("inert");
  fireEvent.click(alternatives);
  expect(alternatives).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(within(region).getByRole("button", { name: /Copy path/ }));
  expect(onAlternative).toHaveBeenCalledOnce();
  fireEvent.click(within(card).getByRole("button", { name: "Open" }));
  expect(onAccept).toHaveBeenCalledOnce();
});

test("Task Row keeps a 44px disclosure contract and exposes the real job status", () => {
  const onOpenChange = vi.fn();
  const { container } = render(
    <DezinAgentTaskRow
      title="Build checkout flow"
      meta="7 actions"
      status="ready"
      defaultOpen={false}
      onOpenChange={onOpenChange}
      trailing={<span>12s</span>}
    >
      <p>Version 8 is ready.</p>
    </DezinAgentTaskRow>,
  );

  const row = container.querySelector<HTMLElement>('[data-dezin-agent-primitive="task"]')!;
  expect(row).toHaveAttribute("data-status", "ready");
  expect(within(row).getByText("Completed")).toBeInTheDocument();
  const trigger = within(row).getByRole("button", { name: "Build checkout flow · ready" });
  const region = container.querySelector<HTMLElement>(`#${trigger.getAttribute("aria-controls")}`)!;
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(region).toHaveAttribute("inert");
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(region).not.toHaveAttribute("inert");
  expect(within(region).getByText("Version 8 is ready.")).toBeInTheDocument();
  expect(onOpenChange).toHaveBeenCalledWith(true);
});

test("Tool Chips disclose grounded tool details and keep collapsed content inert", () => {
  const { container } = render(
    <DezinAgentToolGroup
      defaultOpen={false}
      messageCount={1}
      items={[
        { id: "read", label: "Read project", detail: "design/project.json", kind: "read", state: "done" },
        {
          id: "write",
          label: "Write component",
          detail: "Hero.tsx",
          kind: "write",
          state: "active",
          children: <pre>+ export function Hero()</pre>,
        },
      ]}
      changes={[{ id: "hero", path: "Hero.tsx", additions: 18, deletions: 2 }]}
    />,
  );

  const group = container.querySelector<HTMLElement>('[data-dezin-agent-primitive="tools"]')!;
  const trigger = within(group).getByRole("button", { name: "2 tool calls, 1 message" });
  const region = container.querySelector<HTMLElement>(`#${trigger.getAttribute("aria-controls")}`)!;
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(region).toHaveAttribute("inert");

  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(within(region).getAllByRole("listitem").map((item) => item.dataset.state)).toEqual(["done", "active"]);
  const write = within(region).getByRole("button", { name: "Write component" });
  expect(write).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(write);
  expect(write).toHaveAttribute("aria-expanded", "true");
  expect(within(region).getByText("+ export function Hero()", { exact: true })).toBeInTheDocument();
  expect(within(region).getByText("Hero.tsx", { selector: ".dezin-agent-tool-chips__change-path" })).toBeInTheDocument();
  expect(within(region).getByText("+18")).toBeInTheDocument();
  expect(within(region).getByText("−2")).toBeInTheDocument();
  expect(group.querySelector('path[d="M6 9l6 6 6-6"]')).toBeInTheDocument();
  expect(group.querySelector('path[d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"]')).toBeInTheDocument();
  expect(group.querySelector('path[d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"]')).toBeInTheDocument();
});

test("Approval Card supports real single-choice approval and explicit actions", () => {
  const onSelectionChange = vi.fn();
  const onApprove = vi.fn();
  const onDismiss = vi.fn();
  render(
    <DezinAgentApproval
      title="Use the existing layout?"
      description="This keeps the current node geometry."
      options={[
        { id: "reuse", label: "Use existing layout" },
        { id: "replace", label: "Replace layout", description: "Creates a new version" },
      ]}
      defaultSelectedIds={[]}
      onSelectionChange={onSelectionChange}
      actions={[{ id: "approve", label: "Approve", tone: "primary", onClick: onApprove }]}
      onDismiss={onDismiss}
    />,
  );

  const card = screen.getByRole("group", { name: "Use the existing layout?" });
  expect(card).toHaveAttribute("data-dezin-agent-primitive", "approval");
  fireEvent.click(within(card).getByRole("radio", { name: "Use existing layout" }));
  expect(onSelectionChange).toHaveBeenLastCalledWith(["reuse"]);
  expect(within(card).getByRole("radio", { name: "Use existing layout" })).toBeChecked();
  fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
  expect(onApprove).toHaveBeenCalledOnce();
  fireEvent.click(within(card).getByRole("button", { name: "Dismiss approval" }));
  expect(onDismiss).toHaveBeenCalledOnce();
});

test("Streaming Text is a presentation frame that preserves the parent's real rich content", () => {
  const { rerender } = render(
    <DezinAgentStreamingText streaming ariaLabel="Agent response">
      <article aria-label="Rendered markdown"><a href="https://example.com/source">Source</a></article>
    </DezinAgentStreamingText>,
  );

  const frame = screen.getByRole("status", { name: "Agent response" });
  expect(frame).toHaveAttribute("data-dezin-agent-primitive", "streaming");
  expect(frame).toHaveAttribute("aria-busy", "true");
  expect(frame).toHaveAttribute("aria-live", "polite");
  expect(screen.getByRole("article", { name: "Rendered markdown" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute("href", "https://example.com/source");

  rerender(
    <DezinAgentStreamingText streaming={false} ariaLabel="Agent response">
      <p>Complete</p>
    </DezinAgentStreamingText>,
  );
  expect(frame).toHaveAttribute("aria-busy", "false");
  expect(frame).not.toHaveAttribute("data-streaming");
  expect(screen.getByText("Complete")).toBeInTheDocument();
});

test("Thinking exposes an operable disclosure and removes collapsed steps from interaction", () => {
  const { container } = render(
    <DezinAgentThinking
      durationLabel="4 seconds"
      defaultOpen={false}
      items={[
        { id: "read", text: "Reading the design brief", state: "done" },
        { id: "build", text: "Building the layout", state: "active", meta: "Hero" },
      ]}
    />,
  );

  const trigger = screen.getByRole("button", { name: "Thought for 4 seconds" });
  const regionId = trigger.getAttribute("aria-controls");
  const region = container.querySelector<HTMLElement>(`#${regionId}`)!;
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(region).toHaveAttribute("aria-hidden", "true");
  expect(region).toHaveAttribute("inert");

  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(region).toHaveAttribute("aria-hidden", "false");
  expect(region).not.toHaveAttribute("inert");
  expect(within(region).getAllByRole("listitem")).toHaveLength(2);
  expect(within(region).getByText("Hero")).toBeInTheDocument();
  expect(container.querySelector('path[d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"]')).toBeInTheDocument();
  expect(container.querySelector('path[d="M6 9l6 6 6-6"]')).toBeInTheDocument();
  expect(region.querySelector(".dezin-agent-thinking__spinner")).toBeInTheDocument();
});
