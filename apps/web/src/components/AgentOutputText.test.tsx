import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { AgentOutputText } from "./AgentOutputText.tsx";

test("AgentOutputText does not animate stable assistant output by default", () => {
  const { container } = render(<AgentOutputText text="Ship it" />);

  expect(container).toHaveTextContent("Ship it");
  expect(container.querySelector("[data-sd-animate]")).toBeNull();
  expect(container.querySelector('[data-agent-output-animated="true"]')).toBeNull();
  expect(container.querySelector("[data-agent-output-char]")).toBeNull();
});

test("AgentOutputText animates only when explicitly requested", () => {
  const { container } = render(<AgentOutputText text="Ship it" animate />);

  expect(container).toHaveTextContent("Ship it");
  expect(container.querySelector("[data-sd-animate]")).not.toBeNull();
});

test("AgentOutputText preserves Markdown links and emphasis", () => {
  render(<AgentOutputText text="**Done** with [preview](https://example.com)." animate={false} />);

  expect(screen.getByText("Done")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "preview" })).toHaveAttribute("href", "https://example.com/");
});

test("AgentOutputText keeps long paths and inline code inside the chat column", () => {
  const { container } = render(
    <AgentOutputText text="Files: src/components/{Sidebar,Thread,Composer,Inspector,Logo,icons}/very-long-unbroken-path. Run with `npm run dev`." />,
  );

  const output = container.querySelector(".dz-selectable");
  const command = screen.getByText("npm run dev");

  expect(output).toHaveClass("min-w-0", "max-w-full", "overflow-x-hidden", "[overflow-wrap:anywhere]");
  expect(command.tagName).toBe("CODE");
  expect(command).toHaveClass("whitespace-normal", "[overflow-wrap:anywhere]");
});
