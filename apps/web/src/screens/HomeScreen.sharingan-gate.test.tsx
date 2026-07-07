import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApiProvider } from "../lib/api-context.tsx";
import { ToastProvider } from "../components/Toast.tsx";
import { AgentsProvider } from "../lib/agents-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { HomeScreen } from "./HomeScreen.tsx";

// Non-desktop build: no Electron preload bridge, so native is undefined and Sharingan
// entry must be denied.
vi.mock("../lib/native.ts", () => ({ native: undefined }));

function renderHome(onNewProject = vi.fn()) {
  const api = makeFakeApi({
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

describe("HomeScreen Sharingan mode desktop gate", () => {
  it("denies entering Sharingan mode on a non-desktop build", () => {
    renderHome();
    fireEvent.doubleClick(screen.getByText("Start a design"));
    expect(screen.queryByPlaceholderText("Paste a URL to clone…")).not.toBeInTheDocument();
  });
});
