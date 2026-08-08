import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { AgentReasoning, AgentWebSearch } from "./AgentActivityBlocks.tsx";
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
  expect(container.querySelector('[data-agent-component="image-generation"]')).toHaveTextContent("Generating image");
  expect(screen.getByRole("link", { name: "Source 1: Interface spec" })).toBeInTheDocument();
  const sources = screen.getByRole("contentinfo", { name: "Sources" });
  expect(sources).toHaveTextContent("Interface spec");
  expect(sources).toHaveTextContent("example.com");
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

  expect(screen.getByText("Searched")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Accessible publishing/ })).toHaveAttribute("href", "https://example.com/a11y");
});
