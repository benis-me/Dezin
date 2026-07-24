import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { DesignSystemSelect } from "./DesignSystemSelect.tsx";
import { AgentModelSelect } from "./AgentModelSelect.tsx";
import { AgentLogo, agentLabel } from "./agent-logos.tsx";

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
  expect(await screen.findByRole("dialog")).toHaveClass("overflow-y-auto");
  const rescan = await screen.findByRole("button", { name: "Rescan agents" });
  expect(rescan.parentElement?.className).toContain("border-border/60");
});

test("AgentModelSelect delegates an agent switch once without a stale model callback", async () => {
  const user = userEvent.setup();
  const onAgentChange = vi.fn();
  const onModelChange = vi.fn();
  render(
    <AgentModelSelect
      agents={[
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5"] },
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
      ]}
      agent="codex"
      model="gpt-5"
      onAgentChange={onAgentChange}
      onModelChange={onModelChange}
      onRescan={vi.fn(async () => {})}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Agent and model" }));
  await user.click(await screen.findByRole("button", { name: /Claude/ }));

  expect(onAgentChange).toHaveBeenCalledOnce();
  expect(onAgentChange).toHaveBeenCalledWith("claude");
  expect(onModelChange).not.toHaveBeenCalled();
});

test("AgentModelSelect keeps unsupported agents visible but prevents selecting them", async () => {
  const user = userEvent.setup();
  const onAgentChange = vi.fn();
  render(
    <AgentModelSelect
      agents={[
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5"] },
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
      ]}
      agent="claude"
      model=""
      onAgentChange={onAgentChange}
      onModelChange={vi.fn()}
      onRescan={vi.fn(async () => {})}
      agentDisabledReason={(candidate) => candidate.command === "claude"
        ? null
        : "Design Workspace generation requires Claude"}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Agent and model" }));
  const codex = await screen.findByRole("button", { name: /Codex/ });
  expect(codex).toBeDisabled();
  expect(codex).toHaveAttribute("title", "Design Workspace generation requires Claude");
  expect(codex).toHaveTextContent("Design Workspace generation requires Claude");
  await user.click(codex);
  expect(onAgentChange).not.toHaveBeenCalled();
});

test("AgentModelSelect keeps an installed but signed-out CodeBuddy visible with a recovery reason", async () => {
  const user = userEvent.setup();
  const onAgentChange = vi.fn();
  render(
    <AgentModelSelect
      agents={[
        { id: "claude", command: "claude", available: true, availability: "ready", version: "1", models: ["sonnet"] },
        {
          id: "codebuddy",
          command: "codebuddy",
          available: false,
          availability: "authentication-required",
          unavailableReason: "Sign in to CodeBuddy, then rescan agents.",
          version: "2.126.0",
          models: ["gpt-5.5"],
        },
      ]}
      agent="claude"
      model=""
      onAgentChange={onAgentChange}
      onModelChange={vi.fn()}
      onRescan={vi.fn(async () => {})}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Agent and model" }));
  const codebuddy = await screen.findByRole("button", { name: /CodeBuddy/ });
  expect(codebuddy).toBeDisabled();
  expect(codebuddy).toHaveTextContent("Sign in to CodeBuddy, then rescan agents.");
  await user.click(codebuddy);
  expect(onAgentChange).not.toHaveBeenCalled();
});

test("agent labels cover supported CLIs and no longer special-case Aider", () => {
  expect(agentLabel("kimi")).toBe("Kimi CLI");
  expect(agentLabel("trae")).toBe("Trae CLI");
  expect(agentLabel("pi")).toBe("Pi");
  expect(agentLabel("hermes")).toBe("Hermes");
  expect(agentLabel("codebuddy")).toBe("CodeBuddy");
  expect(agentLabel("opencode")).toBe("opencode");
  expect(agentLabel("aider")).toBe("aider");
});

test("AgentLogo renders the supported brand IDs", () => {
  for (const id of ["kimi", "trae", "pi", "hermes", "codebuddy", "opencode"]) {
    const { container, unmount } = render(<AgentLogo id={id} className="size-4" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    unmount();
  }
});
