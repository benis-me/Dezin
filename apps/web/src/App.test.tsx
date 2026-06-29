import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { test, expect, afterEach, beforeEach } from "vitest";
import App from "./App.tsx";
import { ApiProvider } from "./lib/api-context.tsx";
import { makeFakeApi } from "./test/fake-api.ts";

beforeEach(() => window.history.pushState({}, "", "/"));
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
  expect(screen.getByRole("heading", { name: "Design systems" })).toBeInTheDocument();
  expect(await screen.findByText("Modern Minimal")).toBeInTheDocument();
  cleanup();

  window.history.pushState({}, "", "/projects/new");
  renderApp();
  expect(screen.getByText("Preview")).toBeInTheDocument();
  expect(screen.getByLabelText("Conversation")).toBeInTheDocument();
});

test("the gear opens the Settings dialog", () => {
  renderApp();
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  fireEvent.click(screen.getByLabelText("Settings"));
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Appearance" })).toBeInTheDocument();
});

test("the theme toggle flips the .dark class", () => {
  renderApp();
  const before = document.documentElement.classList.contains("dark");
  fireEvent.click(screen.getByLabelText(/Switch to (light|dark) mode/));
  expect(document.documentElement.classList.contains("dark")).toBe(!before);
});
