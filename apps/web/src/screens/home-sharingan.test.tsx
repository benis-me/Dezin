import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
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
    getSettings: async () => ({ ...(await makeFakeApi().getSettings()), sharinganAffirmed: true }),
  });
  return render(
    <ApiProvider client={api}>
      <ToastProvider>
        <AgentsProvider>
          <HomeScreen projects={[]} onNewProject={onNewProject} onOpenProject={vi.fn()} />
        </AgentsProvider>
      </ToastProvider>
    </ApiProvider>,
  );
}

describe("HomeScreen Sharingan red entry theme", () => {
  it("double-clicking the heading enters Sharingan mode: red theme, 'Sharingan' label, no mode badge", () => {
    const { getByText, queryByText, container } = renderHome();

    const heading = getByText("Start a design");
    fireEvent.doubleClick(heading);

    expect(queryByText("Sharingan")).toBeInTheDocument();
    expect(queryByText("Start a design")).not.toBeInTheDocument();
    // mode badge gone
    expect(queryByText("Sharingan ✕")).not.toBeInTheDocument();
    // red theme applied (a data attribute on the composer/dropzone container)
    expect(container.querySelector("[data-sharingan='true']")).toBeTruthy();

    // exit by double-clicking the heading again
    fireEvent.doubleClick(getByText("Sharingan"));
    expect(queryByText("Start a design")).toBeInTheDocument();
  });
});

describe("HomeScreen Build double-click guard", () => {
  it("a rapid double-click creates only ONE project (no empty orphan)", () => {
    let resolve = () => {};
    const onNewProject = vi.fn(() => new Promise<void>((r) => { resolve = r; })); // stays in-flight
    const { getByRole, container } = renderHome(onNewProject);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "A pricing page with three plans" } });
    const build = getByRole("button", { name: "Design" });
    fireEvent.click(build);
    fireEvent.click(build); // second click must be blocked (creatingRef guard + disabled button)
    expect(onNewProject).toHaveBeenCalledTimes(1);
    resolve();
  });
});
