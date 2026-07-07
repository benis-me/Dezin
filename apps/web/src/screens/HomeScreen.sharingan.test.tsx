import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApiProvider } from "../lib/api-context.tsx";
import { ToastProvider } from "../components/Toast.tsx";
import { AgentsProvider } from "../lib/agents-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { HomeScreen } from "./HomeScreen.tsx";

// Desktop build: Sharingan entry is enabled only when native.isElectron is true.
vi.mock("../lib/native.ts", () => ({
  native: { isElectron: true, platform: "darwin", pickFiles: async () => [], pickFolder: async () => [] },
}));

function renderHome(onNewProject = vi.fn()) {
  const api = makeFakeApi({
    // getSettings is used to init research/visual toggles; affirmed=true so this task's
    // submit path calls onNewProject directly (the not-affirmed gate arrives in Task 5).
    getSettings: async () => ({ ...(await makeFakeApi().getSettings()), sharinganAffirmed: true }),
  });
  render(
    <ApiProvider client={api}>
      <ToastProvider>
        <AgentsProvider>
          <HomeScreen projects={[]} onNewProject={onNewProject} onOpenProject={vi.fn()} />
        </AgentsProvider>
      </ToastProvider>
    </ApiProvider>,
  );
  return onNewProject;
}

describe("HomeScreen Sharingan mode", () => {
  it("double-clicking the heading enters Sharingan mode: URL placeholder shown, Research hidden", () => {
    renderHome();
    expect(screen.queryByPlaceholderText("Paste a URL to clone…")).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText("Start a design"));
    expect(screen.getByPlaceholderText("Paste a URL to clone…")).toBeInTheDocument();
    expect(screen.queryByText("Design Research")).not.toBeInTheDocument();
    expect(screen.getByText(/Sharingan/i)).toBeInTheDocument();
  });

  it("submitting a valid URL calls onNewProject with the sourceUrl and standard mode", () => {
    const onNewProject = renderHome();
    fireEvent.doubleClick(screen.getByText("Start a design"));
    fireEvent.change(screen.getByPlaceholderText("Paste a URL to clone…"), { target: { value: "https://example.com" } });
    // HomeScreen's composer submit button has accessible name "Design" (aria-label="Design").
    fireEvent.click(screen.getByRole("button", { name: "Design" }));
    expect(onNewProject).toHaveBeenCalledWith(
      "https://example.com",
      expect.any(String),
      expect.any(String),
      "standard",
      { sourceUrl: "https://example.com" },
    );
  });

  it("does not submit an invalid URL", () => {
    const onNewProject = renderHome();
    fireEvent.doubleClick(screen.getByText("Start a design"));
    fireEvent.change(screen.getByPlaceholderText("Paste a URL to clone…"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: "Design" }));
    expect(onNewProject).not.toHaveBeenCalled();
  });
});
