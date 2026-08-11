import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { AgentImageGenerationState, AgentProgressList, AgentReasoning, AgentWebSearch } from "./AgentActivityBlocks.tsx";
import { AgentOutputText } from "./AgentOutputText.tsx";
import { citationReferences } from "./AgentRichContent.tsx";

test("Agent output uses the AIcss-inspired code, diff, task, table, image, and citation surfaces", async () => {
  const markdown = [
    "A grounded answer with source [1](https://example.com/spec \"Interface spec\").",
    "",
    "```ts",
    "const answer = 42;",
    "```",
    "",
    "```diff",
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,2 +1,2 @@",
    "-const safe = false;",
    "+const safe = true;",
    "```",
    "",
    "- [x] Read the context",
    "- [ ] Publish the result",
    "",
    "| Model | Context |",
    "| --- | ---: |",
    "| hy3-ioa | 128k |",
    "",
    "![Tokyo campaign frame](https://example.com/frame.webp)",
  ].join("\n");

  const { container } = render(<AgentOutputText text={markdown} />);

  expect(await screen.findByText("const answer = 42;")).toBeInTheDocument();
  expect(container.querySelector('[data-agent-component="code-block"]')).toBeInTheDocument();
  const diff = container.querySelector<HTMLElement>('[data-agent-component="file-diff"]');
  expect(diff).toBeInTheDocument();
  expect(within(diff!).getByText("src/auth.ts")).toBeInTheDocument();
  expect(diff).toHaveTextContent("+1-1");
  expect(container.querySelector('[data-agent-component="task-list"]')).toHaveTextContent("1/2");
  expect(container.querySelector('[data-agent-component="data-table"]')).toHaveTextContent("hy3-ioa128k");
  const image = container.querySelector('[data-agent-component="image-generation"]');
  expect(image).toHaveTextContent("External image blocked");
  expect(image?.querySelector("img")).toBeNull();
  expect(within(image as HTMLElement).getByRole("link", { name: "Open image explicitly" })).toHaveAttribute(
    "href",
    "https://example.com/frame.webp",
  );
  expect(screen.getByRole("link", { name: "Source 1: Interface spec" })).toBeInTheDocument();
  const sources = screen.getByRole("contentinfo", { name: "Sources" });
  expect(sources).toHaveTextContent("Interface spec");
  expect(sources).toHaveTextContent("example.com");
});

test("Agent disclosures isolate one measured flow-size track and keep visible motion on the compositor", () => {
  const css = readFileSync(join(process.cwd(), "src/components/agent-conversation.css"), "utf8");
  expect(css).not.toContain("grid-template-rows 200ms");
  expect(css).toMatch(/\.agent-collapsible\s*\{[^}]*contain:\s*layout paint[^}]*transition:\s*block-size 220ms cubic-bezier\(0\.23, 1, 0\.32, 1\)/s);
  expect(css).toMatch(/\.agent-collapsible > \[data-agent-collapsible-content\]\s*\{[^}]*display:\s*flow-root;[^}]*transition:\s*opacity 180ms[^;]*, transform 210ms/s);
  expect(css).toMatch(/\.agent-collapsible\[data-collapsed\][\s\S]*translate3d\(0, -6px, 0\) scale\(0\.985\)/s);
});

test("Agent activity blocks share one editorial log-row anatomy", () => {
  const { container } = render(
    <>
      <AgentReasoning active durationMs={4_000} items={[{ id: "r", text: "Inspecting the canvas" }]} />
      <AgentProgressList items={[{ id: "p", text: "Render the page", state: "active" }]} />
      <AgentWebSearch active query="motion craft" results={[]} />
    </>,
  );

  expect(container.querySelectorAll(".agent-activity-card")).toHaveLength(3);
  expect(container.querySelectorAll(".agent-activity-card__header")).toHaveLength(3);
  expect(container.querySelectorAll(".agent-activity-card__marker")).toHaveLength(3);
  expect(container.querySelectorAll(".agent-activity-card__summary")).toHaveLength(3);
  expect(container.querySelectorAll(".agent-activity-card__label")).toHaveLength(3);
  expect(container.querySelectorAll(".agent-activity-card__meta")).toHaveLength(3);
  expect(container.querySelectorAll(".agent-activity-card__chevron")).toHaveLength(3);
  expect([...container.querySelectorAll("[data-activity-kind]")].map((element) => element.getAttribute("data-activity-kind")))
    .toEqual(["thinking", "actions", "search"]);
});

test("the image-generation card uses the same accessible disclosure contract", () => {
  const { container } = render(<AgentImageGenerationState prompt="A quiet editorial cover" />);
  const toggle = screen.getByRole("button", { name: "Image generation: Generating" });
  const collapsible = container.querySelector(".agent-image-generation-state__collapsible");

  expect(toggle).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(collapsible).toHaveAttribute("aria-hidden", "true");
  expect(collapsible).toHaveAttribute("inert");
});

test("Agent output renders passive local images without authorizing remote image requests", () => {
  const { container } = render(<AgentOutputText text="![Local preview](/api/assets/preview.png)" />);
  const image = container.querySelector<HTMLImageElement>('[data-agent-component="image-generation"] img');
  expect(image).toHaveAttribute("src", "/api/assets/preview.png");
  fireEvent.load(image!);
  expect(container.querySelector('[data-agent-component="image-generation"]')).toHaveTextContent("Generated image");

  const remote = render(<AgentOutputText text="![Remote](https://example.com/remote.png)" animate />);
  expect(remote.container.querySelector('img[src^="https://"]')).toBeNull();
  expect(remote.container).toHaveTextContent("External image blocked");
  remote.rerender(<AgentOutputText text="![Now local](/api/assets/local.png)" animate />);
  expect(remote.container.querySelector('img[src="/api/assets/local.png"]')).not.toBeNull();
  expect(remote.container).toHaveTextContent("Generating image");
});

test("citationReferences keeps numbered sources ordered and deduplicated", () => {
  expect(citationReferences([
    "Claim [2](https://docs.example.com/a \"Primary docs\")",
    "Repeat [2](https://docs.example.com/a \"Primary docs\")",
    "More [3](https://example.org/b)",
  ].join("\n"))).toEqual([
    { number: "2", href: "https://docs.example.com/a", label: "Primary docs", host: "docs.example.com" },
    { number: "3", href: "https://example.org/b", label: "example.org", host: "example.org" },
  ]);
});

test("reasoning and web search disclose live detail without losing their compact summary", () => {
  render(
    <>
      <AgentReasoning
        active
        durationMs={4_000}
        items={[{ id: "reason-1", text: "Reading the frozen canvas context." }]}
      />
      <AgentWebSearch
        active={false}
        query="editorial accessibility"
        results={[{ id: "result-1", title: "Accessible publishing", href: "https://example.com/a11y", state: "done" }]}
      />
    </>,
  );

  const thought = screen.getByRole("button", { name: /Thinking/ });
  expect(thought).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Reading the frozen canvas context.")).toBeInTheDocument();
  fireEvent.click(thought);
  expect(thought).toHaveAttribute("aria-expanded", "false");

  expect(screen.getByText("Search")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Accessible publishing/ })).toHaveAttribute("href", "https://example.com/a11y");
});

test("completed Thinking does not present the whole Job duration as reasoning time", () => {
  const { container } = render(
    <AgentReasoning
      active={false}
      durationMs={8 * 60_000 + 27_000}
      items={[{ id: "reason-1", text: "Read the frozen canvas context." }]}
    />,
  );

  expect(screen.getByRole("button", { name: "Thinking" })).toBeInTheDocument();
  expect(screen.queryByText("8m 27s")).not.toBeInTheDocument();
  expect(screen.getByText("Completed")).toHaveClass("agent-activity-card__meta");
  expect(container.querySelector(".agent-reasoning")).not.toHaveAttribute("data-active");
  expect(container.querySelector(".agent-reasoning .agent-activity-card__marker")).toHaveAttribute("data-state", "complete");
  expect(container.querySelector(".agent-reasoning .agent-activity-card__pulse")).toBeNull();
});

test("live Thinking alone owns the pulse treatment", () => {
  const { container } = render(
    <AgentReasoning
      active
      durationMs={4_000}
      items={[{ id: "reason-live", text: "Inspect the canvas." }]}
    />,
  );

  expect(screen.getByText("Live")).toHaveClass("agent-activity-card__meta");
  expect(container.querySelector(".agent-reasoning")).toHaveAttribute("data-active", "true");
  expect(container.querySelector(".agent-reasoning .agent-activity-card__marker")).toHaveAttribute("data-state", "active");
  expect(container.querySelector(".agent-reasoning .agent-activity-card__pulse")).toBeInTheDocument();
});

test("collapsed Agent activity sections remove hidden detail from the accessibility tree", () => {
  const { container } = render(
    <>
      <AgentProgressList
        items={[{ id: "step-1", text: "Inspect the canvas", state: "done" }]}
      />
      <AgentWebSearch
        active={false}
        query="motion accessibility"
        results={[{ id: "result-1", title: "Motion guidance", href: "https://example.com/motion", state: "done" }]}
      />
    </>,
  );

  fireEvent.click(screen.getByRole("button", { name: /Actions/ }));
  fireEvent.click(screen.getByRole("button", { name: "Search: motion accessibility" }));

  const progress = container.querySelector(".agent-progress__collapsible");
  const search = container.querySelector(".agent-web-search__collapsible");
  expect(progress).toHaveAttribute("aria-hidden", "true");
  expect(progress).toHaveAttribute("inert");
  expect(search).toHaveAttribute("aria-hidden", "true");
  expect(search).toHaveAttribute("inert");
});

test("Agent activity headers own their disclosure regions and action state is not color-only", () => {
  render(
    <AgentProgressList
      items={[
        { id: "step-active", text: "Inspect the canvas", state: "active" },
        { id: "step-failed", text: "Publish the result", state: "failed" },
      ]}
    />,
  );

  const toggle = screen.getByRole("button", { name: /Actions/ });
  const controlledId = toggle.getAttribute("aria-controls");
  expect(controlledId).toBeTruthy();
  expect(document.getElementById(controlledId!)).toHaveClass("agent-progress__collapsible");
  expect(screen.getByText("Active:")).toHaveClass("agent-visually-hidden");
  expect(screen.getByText("Failed:")).toHaveClass("agent-visually-hidden");
});

test("terminal non-success jobs can keep completed action facts without a green overall summary", () => {
  const { container } = render(
    <AgentProgressList
      completionTone="neutral"
      items={[
        { id: "step-one", text: "Read context", state: "done" },
        { id: "step-two", text: "Stop generation", state: "done" },
      ]}
    />,
  );

  expect(container.querySelector(".agent-activity-card__marker")).toHaveAttribute("data-state", "idle");
  expect(screen.getByText("2 steps completed")).toBeInTheDocument();
  expect(screen.getAllByText("Complete:")).toHaveLength(2);
});

test("expanded reasoning reveals complete history in bounded windows without shortening detail", () => {
  const completeDetail = [
    "Inspect the complete generated page structure before making a decision.",
    "Keep every constraint, dependency, and verification note visible in the expanded transcript.",
  ].join(" ").repeat(4);
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: `reason-${index + 1}`,
    text: index === 0 ? completeDetail : `Reasoning step ${index + 1}`,
  }));

  const { container } = render(<AgentReasoning active durationMs={9_000} items={items} />);

  const toggle = screen.getByRole("button", { name: "Thinking" });
  const collapsible = container.querySelector(".agent-reasoning__collapsible");
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(collapsible).toHaveAttribute("aria-hidden", "false");
  expect(collapsible).not.toHaveAttribute("inert");
  expect(container.querySelectorAll(".agent-reasoning__viewport p")).toHaveLength(24);
  expect(screen.queryByText(completeDetail)).not.toBeInTheDocument();
  expect(screen.queryByText("Reasoning step 76")).not.toBeInTheDocument();
  expect(screen.getByText("Reasoning step 77")).toBeInTheDocument();

  const showEarlier = screen.getByRole("button", { name: "Show earlier Thinking (+24 · 76 remaining)" });
  fireEvent.click(toggle);
  expect(collapsible).toHaveAttribute("aria-hidden", "true");
  expect(collapsible).toHaveAttribute("inert");
  expect(screen.queryByRole("button", { name: /Show earlier Thinking/ })).not.toBeInTheDocument();

  fireEvent.click(toggle);
  expect(collapsible).toHaveAttribute("aria-hidden", "false");
  expect(collapsible).not.toHaveAttribute("inert");
  expect(screen.getByRole("button", { name: "Show earlier Thinking (+24 · 76 remaining)" })).toBeInTheDocument();

  fireEvent.click(showEarlier);
  expect(container.querySelectorAll(".agent-reasoning__viewport p")).toHaveLength(48);
  expect(screen.getByText("Reasoning step 53")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show earlier Thinking (+48 · 52 remaining)" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Show earlier Thinking (+48 · 52 remaining)" }));
  expect(container.querySelectorAll(".agent-reasoning__viewport p")).toHaveLength(96);
  expect(screen.getByText("Reasoning step 5")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show earlier Thinking (+4 · 4 remaining)" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Show earlier Thinking (+4 · 4 remaining)" }));
  expect(container.querySelectorAll(".agent-reasoning__viewport p")).toHaveLength(100);
  expect(screen.getByText(completeDetail)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Show earlier Thinking/ })).not.toBeInTheDocument();
});

test("active reasoning keeps the expanded window and its newest item when activity appends", () => {
  const items = Array.from({ length: 64 }, (_, index) => ({
    id: `reason-${index + 1}`,
    text: `Reasoning step ${index + 1}`,
  }));
  const { rerender } = render(<AgentReasoning active durationMs={9_000} items={items} />);

  fireEvent.click(screen.getByRole("button", { name: "Show earlier Thinking (+24 · 40 remaining)" }));
  expect(screen.getByText("Reasoning step 17")).toBeInTheDocument();

  rerender(<AgentReasoning
    active
    durationMs={10_000}
    items={[
      ...items,
      { id: "reason-65", text: "Reasoning step 65" },
      { id: "reason-66", text: "Reasoning step 66" },
    ]}
  />);

  expect(screen.queryByText("Reasoning step 18")).not.toBeInTheDocument();
  expect(screen.getByText("Reasoning step 19")).toBeInTheDocument();
  expect(screen.getByText("Reasoning step 66")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show earlier Thinking (+18 · 18 remaining)" })).toBeInTheDocument();
});
