import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { AgentOutputText } from "./AgentOutputText.tsx";

test("AgentOutputText renders new assistant output with per-character fade spans", () => {
  const { container } = render(<AgentOutputText text="Ship it" />);

  expect(screen.getByText("Ship it")).toBeInTheDocument();
  expect(container.querySelector('[data-agent-output-animated="true"]')).not.toBeNull();
  expect(container.querySelectorAll("[data-agent-output-char]").length).toBe("Ship it".length);
});

test("AgentOutputText falls back to Markdown for long messages after the character pass", () => {
  render(<AgentOutputText text="**Done** with [preview](https://example.com)." animate={false} />);

  expect(screen.getByText("Done")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "preview" })).toHaveAttribute("href", "https://example.com");
});
