import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { MODEL_PROVIDERS } from "./model-provider-registry.ts";
import { ModelProviderSidebar } from "./ModelProviderSidebar.tsx";

test("ModelProviderSidebar only lights the active provider when it is enabled", () => {
  const props = {
    providers: MODEL_PROVIDERS.slice(0, 2),
    selectedId: "openai",
    activeProviderId: "openai",
    apiKey: "sk-test",
    query: "",
    onQueryChange: vi.fn(),
    onSelect: vi.fn(),
  };

  const { rerender } = render(<ModelProviderSidebar {...props} enabled={false} />);
  expect(screen.getByLabelText("OpenAI disabled")).toHaveClass("bg-border-strong");

  rerender(<ModelProviderSidebar {...props} enabled />);
  expect(screen.getByLabelText("OpenAI enabled")).toHaveClass("bg-[var(--success)]");
});
