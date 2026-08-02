import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ApiProvider } from "../lib/api-context.tsx";
import { ToastProvider } from "../components/Toast.tsx";
import { AgentsProvider } from "../lib/agents-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { HomeScreen } from "./HomeScreen.tsx";
import { validPngFile } from "../test/image-fixtures.ts";

// Desktop build: Sharingan entry is enabled only when native.isElectron is true.
vi.mock("../lib/native.ts", () => ({
  native: { isElectron: true, platform: "darwin", pickFiles: async () => [], pickFolder: async () => [] },
}));

function renderHome(onNewProject = vi.fn()) {
  const api = makeFakeApi({
    // affirmed=true makes this task's submit path call onNewProject directly.
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
  it("double-clicking the heading enters Sharingan mode", () => {
    renderHome();
    expect(screen.queryByPlaceholderText("Paste a URL to clone…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Blank canvas" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Design system" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sharingan clone from URL" })).toBeNull();
    fireEvent.doubleClick(screen.getByText("Start a design"));
    expect(screen.getByPlaceholderText("Paste a URL to clone…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Blank canvas" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sharingan" })).toBeInTheDocument();
  });

  it("submitting a valid URL calls onNewProject with the sourceUrl", async () => {
    const onNewProject = renderHome();
    // Let the mount-time getSettings() resolve (it carries sharinganAffirmed: true here) before
    // submitting — otherwise the affirmation gate would still see the initial `affirmed=false`.
    await act(async () => {});
    fireEvent.doubleClick(screen.getByText("Start a design"));
    fireEvent.change(screen.getByPlaceholderText("Paste a URL to clone…"), { target: { value: "https://example.com" } });
    // HomeScreen's composer submit button has accessible name "Design" (aria-label="Design").
    fireEvent.click(screen.getByRole("button", { name: "Design" }));
    expect(onNewProject).toHaveBeenCalledWith(
      "https://example.com",
      { sourceUrl: "https://example.com" },
      undefined,
      undefined,
    );
  });

  it("keeps attached image context when a Sharingan project is created", async () => {
    const onNewProject = renderHome();
    await act(async () => {});
    fireEvent.doubleClick(screen.getByText("Start a design"));
    const imageInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]');
    expect(imageInput).not.toBeNull();
    fireEvent.change(imageInput!, {
      target: { files: [validPngFile("direction.png")] },
    });
    await screen.findByLabelText("Remove direction.png");
    fireEvent.change(screen.getByPlaceholderText("Paste a URL to clone…"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Design" }));

    expect(onNewProject).toHaveBeenCalledWith(
      "https://example.com",
      { sourceUrl: "https://example.com" },
      undefined,
      {
        images: [{ name: "direction.png", base64: expect.any(String), mimeType: "image/png" }],
        refs: [],
      },
    );
  });

  it("does not submit an invalid URL", () => {
    const onNewProject = renderHome();
    fireEvent.doubleClick(screen.getByText("Start a design"));
    fireEvent.change(screen.getByPlaceholderText("Paste a URL to clone…"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: "Design" }));
    expect(onNewProject).not.toHaveBeenCalled();
  });

  it("hides the Optimize prompt affordance while in Sharingan mode", () => {
    renderHome();
    fireEvent.doubleClick(screen.getByText("Start a design"));
    fireEvent.change(screen.getByPlaceholderText("Paste a URL to clone…"), { target: { value: "https://example.com" } });
    expect(screen.queryByRole("button", { name: "Optimize prompt" })).not.toBeInTheDocument();
  });

  it("first Sharingan run gates on the authorized-use affirmation, then proceeds", async () => {
    const onNewProject = vi.fn();
    const updateSettings = vi.fn(async (patch: Record<string, unknown>) => ({ ...(await makeFakeApi().getSettings()), ...patch }));
    const api = makeFakeApi({
      getSettings: async () => ({ ...(await makeFakeApi().getSettings()), sharinganAffirmed: false }),
      updateSettings,
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
    fireEvent.doubleClick(screen.getByText("Start a design"));
    fireEvent.change(screen.getByPlaceholderText("Paste a URL to clone…"), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Design" }));

    // The affirmation gates the run: onNewProject not called yet, a dialog is shown.
    expect(onNewProject).not.toHaveBeenCalled();
    const affirm = await screen.findByRole("button", { name: /i have the right/i });
    fireEvent.click(affirm);

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ sharinganAffirmed: true }));
    await waitFor(() =>
      expect(onNewProject).toHaveBeenCalledWith(
        "https://example.com",
        { sourceUrl: "https://example.com" },
        undefined,
        undefined,
      ),
    );
  });
});
