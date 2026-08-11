import { fireEvent, render, screen, within } from "@testing-library/react";
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

test("assistant output exposes one Message Response surface with explicit streaming state and Sources", () => {
  const { container, rerender } = render(
    <AgentOutputText text={'Grounded answer [1](https://example.com/spec "Product spec")'} animate />,
  );

  const response = container.querySelector('[data-agent-component="message-response"]');
  expect(response).toHaveAttribute("data-output-state", "streaming");
  const sources = within(response as HTMLElement).getByRole("contentinfo", { name: "Sources" });
  expect(sources).toHaveAttribute("data-agent-component", "sources");
  expect(sources).toHaveTextContent("Product spec");
  const sourcesToggle = within(sources).getByRole("button", { name: "Sources (1)" });
  expect(sourcesToggle).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(sourcesToggle);
  expect(sourcesToggle).toHaveAttribute("aria-expanded", "false");
  expect(sources.querySelector(".agent-citations__collapsible")).toHaveAttribute("aria-hidden", "true");
  expect(sources.querySelector(".agent-citations__collapsible")).toHaveAttribute("inert");

  rerender(<AgentOutputText text="Grounded answer" />);
  expect(container.querySelector('[data-agent-component="message-response"]')).toHaveAttribute(
    "data-output-state",
    "complete",
  );
});
