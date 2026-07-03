import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { AgentOutputText } from "./AgentOutputText.tsx";

test("AgentOutputText renders assistant output as normal Markdown", () => {
  const { container } = render(<AgentOutputText text="Ship it" />);

  expect(screen.getByText("Ship it")).toBeInTheDocument();
  expect(container.querySelector('[data-agent-output-animated="true"]')).toBeNull();
  expect(container.querySelector("[data-agent-output-char]")).toBeNull();
});

test("AgentOutputText preserves Markdown links and emphasis", () => {
  render(<AgentOutputText text="**Done** with [preview](https://example.com)." animate={false} />);

  expect(screen.getByText("Done")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "preview" })).toHaveAttribute("href", "https://example.com");
});
