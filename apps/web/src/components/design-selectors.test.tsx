import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { DesignSystemSelect } from "./DesignSystemSelect.tsx";
import { AgentModelSelect } from "./AgentModelSelect.tsx";

afterEach(cleanup);

const SYSTEMS = [
  { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" as const },
  { id: "custom-brand", name: "Custom Brand", category: "Custom", summary: "", origin: "custom" as const },
];

test("DesignSystemSelect uses the standard tab strip and compact list spacing", async () => {
  const user = userEvent.setup();
  render(<DesignSystemSelect systems={SYSTEMS} value="" onChange={() => {}} />);

  await user.click(screen.getByRole("button", { name: "Design system" }));

  const tablist = await screen.findByRole("tablist", { name: "Design system type" });
  expect(tablist).toHaveClass("flex");
  expect(tablist).toHaveClass("w-auto");
  expect(tablist.className).toContain("border-border");
  expect(tablist.className).toContain("bg-surface-2/60");
  expect(tablist.className).not.toContain("mb-1");
  expect(tablist.className).not.toContain("w-fit");

  expect(screen.getByRole("tab", { name: "Built-in" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("list", { name: "Design systems" })).toHaveClass("py-1");

  const none = screen.getByRole("button", { name: /No design system/ });
  expect(none).toHaveClass("py-2");
  const divider = none.parentElement;
  expect(divider?.className).toContain("border-border/60");
  expect(divider?.className).not.toContain("mt-1");
});

test("AgentModelSelect uses the lighter bottom divider", async () => {
  const user = userEvent.setup();
  render(
    <AgentModelSelect
      agents={[{ id: "codex", command: "codex", available: true, version: "codex 1.0.0", models: ["gpt-5"] }]}
      agent="codex"
      model=""
      onAgentChange={() => {}}
      onModelChange={() => {}}
      onRescan={vi.fn(async () => {})}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Agent and model" }));
  const rescan = await screen.findByRole("button", { name: "Rescan agents" });
  expect(rescan.parentElement?.className).toContain("border-border/60");
});
