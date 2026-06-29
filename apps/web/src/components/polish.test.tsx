import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { test, expect, afterEach } from "vitest";
import { ToastProvider, useToast } from "./Toast.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import App from "../App.tsx";
import { HomeScreen } from "../screens/HomeScreen.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";

afterEach(cleanup);

function ToastHarness() {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast("boom", { variant: "error" })}>
      fire
    </button>
  );
}

test("toast shows then dismisses", () => {
  render(
    <ToastProvider>
      <ToastHarness />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText("fire"));
  expect(screen.getByRole("alert")).toHaveTextContent("boom");
  fireEvent.click(screen.getByLabelText("Dismiss"));
  expect(screen.queryByText("boom")).toBeNull();
});

test("HomeScreen surfaces an error toast when archive fails", async () => {
  const api = makeFakeApi({
    listProjects: async () => [
      { id: "p1", name: "Pricing", skillId: null, designSystemId: "modern-minimal", mode: "prototype" as const, createdAt: 1, updatedAt: 2 },
    ],
    patchProject: async () => {
      throw new Error("nope");
    },
  });
  render(
    <ApiProvider client={api}>
      <ToastProvider>
        <HomeScreen />
      </ToastProvider>
    </ApiProvider>,
  );
  fireEvent.click(await screen.findByLabelText("Archive Pricing"));
  expect(await screen.findByText(/Couldn't archive/)).toBeInTheDocument();
});

test("⌘K opens the command palette", () => {
  window.history.pushState({}, "", "/");
  render(
    <ApiProvider client={makeFakeApi({})}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ApiProvider>,
  );
  expect(screen.queryByLabelText("Command")).toBeNull();
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(screen.getByLabelText("Command")).toBeInTheDocument();
});

test("command palette filters projects and navigates on Enter", async () => {
  window.history.pushState({}, "", "/");
  const api = makeFakeApi({
    listProjects: async () => [
      { id: "p1", name: "Pricing page", skillId: null, designSystemId: null, mode: "prototype" as const, createdAt: 1, updatedAt: 1 },
      { id: "p2", name: "Marketing site", skillId: null, designSystemId: null, mode: "prototype" as const, createdAt: 1, updatedAt: 1 },
    ],
  });
  render(
    <ApiProvider client={api}>
      <CommandPalette open onClose={() => {}} />
    </ApiProvider>,
  );
  const input = await screen.findByLabelText("Command");
  expect(await screen.findByText("Pricing page")).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "pricing" } });
  expect(screen.queryByText("Marketing site")).toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(window.location.pathname).toBe("/projects/p1");
});
