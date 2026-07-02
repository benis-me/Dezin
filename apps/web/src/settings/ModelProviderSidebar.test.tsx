import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { MODEL_PROVIDERS } from "./model-provider-registry.ts";
import { ModelProviderSidebar } from "./ModelProviderSidebar.tsx";

test("ModelProviderSidebar lights providers from the enabled provider set", () => {
  const props = {
    providers: MODEL_PROVIDERS.slice(0, 2),
    selectedId: "azure-openai",
    query: "",
    onQueryChange: vi.fn(),
    onSelect: vi.fn(),
  };

  render(<ModelProviderSidebar {...props} enabledProviderIds={new Set(["openai"])} />);
  expect(screen.getByLabelText("OpenAI enabled")).toHaveClass("bg-[var(--success)]");
  expect(screen.getByLabelText("Azure OpenAI disabled")).toHaveClass("bg-border-strong");
});
