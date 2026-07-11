import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App.tsx";
import { ApiProvider } from "./lib/api-context.tsx";
import { makeFakeApi } from "./test/fake-api.ts";

const loaded = vi.hoisted(() => ({ workspace: 0, settings: 0, canvas: 0 }));

vi.mock("./screens/WorkspaceScreen.tsx", () => {
  loaded.workspace += 1;
  return { WorkspaceScreen: () => <div>Lazy workspace</div> };
});

vi.mock("./screens/SettingsScreen.tsx", () => {
  loaded.settings += 1;
  return { SettingsScreen: () => <div>Lazy settings</div> };
});

vi.mock("./moodboard/MoodboardCanvas.tsx", () => {
  loaded.canvas += 1;
  return { MoodboardCanvas: () => <div>Lazy canvas</div> };
});

beforeEach(() => {
  localStorage.setItem("dezin.onboarded", "1");
  window.history.pushState({}, "", "/");
});

afterEach(cleanup);

const api = makeFakeApi({
  listSkills: async () => [],
  listDesignSystems: async () => [],
  getMoodboard: async (id) => ({
    id,
    name: "Lazy board",
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    coverAssetId: null,
    assets: [],
    nodes: [],
    conversations: [],
    messages: [],
  }),
});

function renderApp() {
  return render(
    <ApiProvider client={api}>
      <App />
    </ApiProvider>,
  );
}

test("Home keeps route modules unloaded until each route is entered", async () => {
  renderApp();
  expect(screen.getByRole("heading", { name: "Start a design" })).toBeInTheDocument();
  expect(loaded).toEqual({ workspace: 0, settings: 0, canvas: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await waitFor(() => expect(loaded.settings).toBe(1));
  expect(loaded.workspace).toBe(0);
  expect(loaded.canvas).toBe(0);

  cleanup();
  window.history.pushState({}, "", "/projects/p1");
  renderApp();
  await waitFor(() => expect(loaded.workspace).toBe(1));
  expect(loaded.canvas).toBe(0);

  cleanup();
  window.history.pushState({}, "", "/moodboards/b1");
  renderApp();
  await waitFor(() => expect(loaded.canvas).toBe(1));
});
