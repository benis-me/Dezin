import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { test, expect, afterEach, beforeEach, vi } from "vitest";
import App from "./App.tsx";
import { ApiProvider } from "./lib/api-context.tsx";
import { makeFakeApi } from "./test/fake-api.ts";

beforeEach(() => {
  window.history.pushState({}, "", "/");
  localStorage.setItem("dezin.onboarded", "1"); // skip first-run onboarding in app tests
});
afterEach(cleanup);

const api = makeFakeApi({
  listSkills: async () => [
    { id: "frontend-design", name: "Frontend design", description: "d", mode: "prototype", triggers: [], designSystem: true },
  ],
  listDesignSystems: async () => [
    { id: "modern-minimal", name: "Modern Minimal", category: "Modern & Minimal", summary: "neutral" },
  ],
});

function renderApp() {
  return render(
    <ApiProvider client={api}>
      <App />
    </ApiProvider>,
  );
}

test("renders the shell and the Home screen by default", () => {
  renderApp();
  expect(screen.getByText("Dezin")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Start a design" })).toBeInTheDocument();
});

test("routes to each screen", async () => {
  window.history.pushState({}, "", "/design-systems");
  renderApp();
  expect(await screen.findByRole("heading", { name: "Design systems" })).toBeInTheDocument();
  expect(await screen.findByText("Modern Minimal")).toBeInTheDocument();
  cleanup();

  window.history.pushState({}, "", "/projects/new");
  renderApp();
  expect(await screen.findByText("Preview")).toBeInTheDocument();
  expect(await screen.findByLabelText("Conversation")).toBeInTheDocument();
});

test("the gear navigates to route-driven Settings and close returns to the prior route", async () => {
  renderApp();
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  fireEvent.click(screen.getByLabelText("Settings"));
  expect(window.location.pathname).toBe("/settings");
  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Appearance" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(window.location.pathname).toBe("/"));
});

test("route-driven Settings keeps the background screen mounted and uses browser back on close", async () => {
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  renderApp();
  const prompt = screen.getByLabelText("Describe your design");
  fireEvent.change(prompt, { target: { value: "Keep this draft while settings are open" } });
  fireEvent.click(screen.getByLabelText("Settings"));
  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByLabelText("Describe your design")).toHaveValue("Keep this draft while settings are open");

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(back).toHaveBeenCalledTimes(1);
});

test("direct /settings renders Settings instead of falling back to Home", async () => {
  window.history.pushState({}, "", "/settings");
  renderApp();
  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Appearance" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Start a design" })).toBeNull();
});

test("closing a direct /settings entry replaces it instead of pushing a history trap", async () => {
  window.history.pushState({}, "", "/settings");
  const replaceState = vi.spyOn(window.history, "replaceState");
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  expect(replaceState).toHaveBeenCalledWith({}, "", "/");
  expect(window.location.pathname).toBe("/");
});

test("the theme toggle flips the .dark class", () => {
  renderApp();
  const before = document.documentElement.classList.contains("dark");
  fireEvent.click(screen.getByLabelText(/Switch to (light|dark) mode/));
  expect(document.documentElement.classList.contains("dark")).toBe(!before);
});

test("creating a project asks the daemon for a generated title in the background", async () => {
  const createProject = vi.fn(async () => ({
    id: "p1",
    name: "A dashboard for pricing experiments",
    skillId: "frontend-design",
    designSystemId: "modern-minimal",
    mode: "prototype" as const,
    createdAt: 1,
    updatedAt: 1,
  }));
  const generateProjectTitle = vi.fn(async () => ({
    id: "p1",
    name: "Pricing Control Room",
    skillId: "frontend-design",
    designSystemId: "modern-minimal",
    mode: "prototype" as const,
    createdAt: 1,
    updatedAt: 2,
  }));
  render(
    <ApiProvider client={makeFakeApi({ ...api, createProject, generateProjectTitle })}>
      <App />
    </ApiProvider>,
  );

  fireEvent.change(screen.getByLabelText("Describe your design"), { target: { value: "A dashboard for pricing experiments" } });
  fireEvent.click(screen.getByLabelText("Design"));

  await waitFor(() => expect(createProject).toHaveBeenCalled());
  await waitFor(() => expect(generateProjectTitle).toHaveBeenCalledWith("p1", "A dashboard for pricing experiments"));
});
