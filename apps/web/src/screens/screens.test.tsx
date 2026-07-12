import { render, screen, cleanup, fireEvent, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, afterEach, vi } from "vitest";
import { HomeScreen } from "./HomeScreen.tsx";
import { MoodboardsScreen } from "./MoodboardsScreen.tsx";
import { EffectsScreen } from "./EffectsScreen.tsx";
import { EffectScreen } from "./EffectScreen.tsx";
import { DesignSystemsScreen } from "./DesignSystemsScreen.tsx";
import { DesignSystemDetailScreen } from "./DesignSystemDetailScreen.tsx";
import { DesignSystemNewScreen } from "./DesignSystemNewScreen.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { Shell } from "../components/Shell.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import { AgentsProvider } from "../lib/agents-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import type { Settings } from "../lib/api.ts";
import { SETTINGS_UPDATED_EVENT } from "../lib/settings-events.ts";
import { takePendingImages, takePendingRefs } from "../lib/pending-brief.ts";
import { ToastProvider } from "../components/Toast.tsx";

afterEach(() => {
  localStorage.removeItem("dezin.shell.sidebar.width");
  localStorage.removeItem("dezin.home.composer");
  takePendingImages();
  takePendingRefs();
  cleanup();
});

const SKILLS = [
  { id: "frontend-design", name: "Frontend design", description: "d", mode: "prototype", triggers: [], designSystem: true },
  { id: "dashboard", name: "Dashboard", description: "d", mode: "prototype", triggers: [], designSystem: true },
];

function renderWithApi(ui: React.ReactElement, over = {}) {
  return render(<ApiProvider client={makeFakeApi(over)}>{ui}</ApiProvider>);
}

function renderWithApiAndAgents(ui: React.ReactElement, over = {}) {
  return render(
    <ApiProvider client={makeFakeApi(over)}>
      <AgentsProvider>{ui}</AgentsProvider>
    </ApiProvider>,
  );
}

function renderWithApiToastAndAgents(ui: React.ReactElement, over = {}) {
  return render(
    <ApiProvider client={makeFakeApi(over)}>
      <AgentsProvider>
        <ToastProvider>{ui}</ToastProvider>
      </AgentsProvider>
    </ApiProvider>,
  );
}

function settingsFixture(patch: Partial<Settings> = {}): Settings {
  return {
    agentCommand: "claude",
    model: "",
    apiBaseUrl: "",
    apiKey: "",
    defaultDesignSystemId: "modern-minimal",
    customInstructions: "",
    imageApiBaseUrl: "",
    imageApiKey: "",
    imageModel: "",
    removeBackgroundModel: "",
    editRegionModel: "",
    extractLayerModel: "",
    videoApiBaseUrl: "",
    videoApiKey: "",
    videoModel: "",
    aiProviderId: "openai",
    aiProviderEnabled: false,
    aiProviderModels: "gpt-image-1",
    aiProviderOrganization: "",
    aiProviderProfiles: "",
    visualQaEnabled: false,
    autoFixLiveRuntimeErrors: false,
    sharinganAffirmed: false,
    researchEnabled: false, researchAgentCommand: "", researchModel: "",    visualQaAgentCommand: "",
    visualQaModel: "",
    autoImproveEnabled: true,
    autoImproveMaxRounds: 8,
    ...patch,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("HomeScreen shows an empty state with no projects", () => {
  renderWithApi(<HomeScreen projects={[]} />, { listSkills: async () => SKILLS });
  expect(screen.getByText(/No projects yet/i)).toBeInTheDocument();
});

test("HomeScreen exposes a retryable alert after the first project load fails", async () => {
  const saved = project("p-retry", "Recovered project");
  const listProjects = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue([saved]);
  renderWithApi(<HomeScreen />, { listProjects, listSkills: async () => SKILLS });

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't load projects");
  fireEvent.click(screen.getByRole("button", { name: "Retry loading projects" }));

  expect(await screen.findByText("Recovered project")).toBeInTheDocument();
});

test("HomeScreen keeps last-good project cards when a background refresh fails", async () => {
  const saved = project("p-retained", "Retained project");
  const listProjects = vi
    .fn()
    .mockResolvedValueOnce([saved])
    .mockResolvedValueOnce([saved])
    .mockRejectedValueOnce(new Error("background offline"));
  renderWithApi(<HomeScreen />, { listProjects, listSkills: async () => SKILLS });
  expect(await screen.findByText("Retained project")).toBeInTheDocument();

  act(() => window.dispatchEvent(new Event("focus")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't refresh projects");
  expect(screen.getByText("Retained project")).toBeInTheDocument();
});

test("HomeScreen allows a project reference to be the only design input", async () => {
  const user = userEvent.setup();
  const source = project("p-source", "Reference source");
  const onNewProject = vi.fn();
  renderWithApi(<HomeScreen projects={[]} onNewProject={onNewProject} />, {
    listProjects: async () => [source],
    listSkills: async () => SKILLS,
    getFileText: async () => "<main>Reference artifact</main>",
  });

  const design = screen.getByRole("button", { name: "Design" });
  expect(design).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Add files and context" }));
  await user.hover(await screen.findByText("Reference a project"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Reference source" }));

  const rail = await screen.findByRole("list", { name: "Attached context" });
  expect(rail).toHaveAttribute("data-context-density", "hero");
  expect(within(rail).getByText("Reference source")).toBeInTheDocument();
  expect(within(rail).getByText("Project")).toBeInTheDocument();
  await screen.findByLabelText("Remove Reference source");
  await waitFor(() => expect(design).toBeEnabled());
  fireEvent.click(design);
  expect(onNewProject).toHaveBeenCalledWith("Build on the referenced design.", "frontend-design", "modern-minimal", "prototype");
  expect(takePendingRefs()).toEqual([{ name: "Reference source", base64: expect.any(String) }]);
});

test("HomeScreen persists the selected agent model as the next default", async () => {
  const user = userEvent.setup();
  let current = settingsFixture({ agentCommand: "claude", model: "" });
  const updateSettings = vi.fn(async (patch: Partial<Settings>) => {
    current = { ...current, ...patch };
    return current;
  });
  const overrides = {
    listSkills: async () => SKILLS,
    listAgents: async () => AGENTS,
    getSettings: async () => current,
    updateSettings,
  };

  const { unmount } = renderWithApiAndAgents(<HomeScreen projects={[]} />, overrides);
  await user.click(await screen.findByRole("button", { name: "Agent and model" }));
  await user.click(await screen.findByRole("button", { name: "claude-sonnet-4-6" }));

  await waitFor(() => expect(updateSettings).toHaveBeenLastCalledWith({ agentCommand: "claude", model: "claude-sonnet-4-6" }));

  unmount();
  renderWithApiAndAgents(<HomeScreen projects={[]} />, overrides);

  await waitFor(() => expect(screen.getByRole("button", { name: "Agent and model" })).toHaveTextContent("claude-sonnet-4-6"));
});

test("Shell sidebar can be resized outside project pages", () => {
  window.history.pushState({}, "", "/");
  render(
    <Shell dark={false} onToggleDark={() => {}} onOpenSettings={() => {}}>
      <div>Content</div>
    </Shell>,
  );
  const resize = screen.getByRole("separator", { name: "Resize app sidebar" });
  expect(resize).toHaveAttribute("data-separator");
  expect(resize).toHaveClass("dezin-resize-separator", "app-no-drag");
  expect(resize.className).not.toContain("primary");
  expect(resize.className).not.toContain("focus-visible");
  expect(resize.className).not.toContain("w-1");
  expect(screen.getByRole("button", { name: "Design" })).toBeInTheDocument();
  const design = screen.getByRole("button", { name: "Design" });
  const designSystems = screen.getByRole("button", { name: "Design Systems" });
  const effects = screen.getByRole("button", { name: "Effects" });
  const moodboard = screen.getByRole("button", { name: "Moodboard" });
  expect(design.compareDocumentPosition(designSystems) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(designSystems.compareDocumentPosition(effects) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(effects.compareDocumentPosition(moodboard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Browser extension" })).toBeNull();
});

test("Shell uses a mobile navigation layout at 390px without a resizable sidebar", () => {
  const previous = window.matchMedia;
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("max-width: 639px"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as typeof window.matchMedia;
  window.history.pushState({}, "", "/");
  try {
    render(
      <Shell dark={false} onToggleDark={() => {}} onOpenSettings={() => {}}>
        <div>Mobile content</div>
      </Shell>,
    );
    expect(screen.getByTestId("app-shell")).toHaveAttribute("data-shell-layout", "mobile");
    expect(screen.queryByRole("separator", { name: "Resize app sidebar" })).toBeNull();
    expect(document.querySelector("aside")).toBeNull();
    expect(screen.getByRole("button", { name: "Design" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Moodboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Mobile content")).toBeInTheDocument();
  } finally {
    window.matchMedia = previous;
  }
});

test("HomeScreen lists projects and opens them", () => {
  const onOpenProject = vi.fn();
  renderWithApi(<HomeScreen projects={[project("p1", "Pricing page")]} onOpenProject={onOpenProject} />, {
    listSkills: async () => SKILLS,
  });
  fireEvent.click(screen.getByText("Pricing page"));
  expect(onOpenProject).toHaveBeenCalledWith("p1");
});

test("HomeScreen project cards are keyboard reachable and activate on Enter", () => {
  const onOpenProject = vi.fn();
  renderWithApi(<HomeScreen projects={[project("p-keyboard", "Keyboard project")]} onOpenProject={onOpenProject} />, {
    listSkills: async () => SKILLS,
  });
  const card = screen.getByRole("link", { name: "Open Keyboard project" });
  expect(card).toHaveAttribute("tabindex", "0");
  expect(card.className).toContain("focus-visible:ring");
  expect(card).not.toContainElement(screen.getByRole("button", { name: "Rename Keyboard project" }));
  card.focus();
  fireEvent.keyDown(card, { key: "Enter" });
  expect(onOpenProject).toHaveBeenCalledWith("p-keyboard");
});

test("HomeScreen exposes a visible labeled Sharingan entry", () => {
  renderWithApi(<HomeScreen projects={[]} />, { listSkills: async () => SKILLS });
  expect(screen.getByRole("button", { name: "Sharingan clone from URL" })).toBeVisible();
});

test("HomeScreen marks projects with an active generation", () => {
  renderWithApi(<HomeScreen projects={[{ ...project("p1", "Pricing page"), runStatus: "running" }]} />, {
    listSkills: async () => SKILLS,
  });
  expect(screen.getByText("Generating")).toHaveClass("shiny-text");
});

test("HomeScreen list view shows updated time until row actions are hovered", async () => {
  const user = userEvent.setup();
  renderWithApi(<HomeScreen projects={[project("p1", "Pricing page")]} />, {
    listSkills: async () => SKILLS,
  });

  await user.click(screen.getByRole("button", { name: "List" }));

  const list = screen.getByTestId("project-list-view");
  expect(list).toHaveAttribute("data-staggered", "true");
  const updated = screen.getByText(/Updated/);
  expect(updated).toHaveClass("group-hover:opacity-0");
  const actions = screen.getByTestId("project-list-actions-p1");
  expect(actions).toHaveClass("opacity-0", "group-hover:opacity-100");
});

test("HomeScreen project toolbar orders sort, layout, then search", () => {
  renderWithApi(<HomeScreen projects={[project("p1", "Pricing page")]} />, {
    listSkills: async () => SKILLS,
  });
  const sort = screen.getByRole("combobox", { name: "Sort projects" });
  const layout = screen.getByRole("group", { name: "Layout" });
  const search = screen.getByLabelText("Search projects");
  expect(sort.compareDocumentPosition(layout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(layout.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("HomeScreen imports a full project zip from beside the project tabs", async () => {
  const user = userEvent.setup();
  let projects = [] as ReturnType<typeof project>[];
  const imported = project("p2", "Imported project");
  const importProject = vi.fn(async () => {
    projects = [imported];
    return imported;
  });
  renderWithApi(<HomeScreen />, {
    listProjects: async () => projects,
    listSkills: async () => SKILLS,
    importProject,
  });

  const all = await screen.findByRole("tab", { name: /All/ });
  const importButton = screen.getByRole("button", { name: "Import full project ZIP" });
  expect(all.compareDocumentPosition(importButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(importButton.querySelector(".lucide-folder-input")).not.toBeNull();
  await user.hover(importButton);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Import full project ZIP");

  const input = screen.getByLabelText("Import project zip");
  const file = new File(["zip"], "dezin-full-project.zip", { type: "application/zip" });
  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() => expect(importProject).toHaveBeenCalledWith(file));
  expect(await screen.findByText("Imported project")).toBeInTheDocument();
});

test("HomeScreen Build passes the brief, skillId, and designSystemId", async () => {
  const user = userEvent.setup();
  const onNewProject = vi.fn();
  renderWithApi(<HomeScreen onNewProject={onNewProject} />, {
    listSkills: async () => SKILLS,
    listDesignSystems: async () => DSYS,
  });

  // Template selector offers the five high-level types
  await user.click(await screen.findByRole("button", { name: "Template" }));
  await user.click(await screen.findByRole("menuitem", { name: "Slides" }));
  // Design-system selector loads systems from the daemon
  await user.click(screen.getByRole("button", { name: "Design system" }));
  await user.click(await screen.findByText("Editorial"));

  const build = screen.getByLabelText("Design");
  expect(build).toHaveClass("rounded-lg");
  expect(build).not.toHaveClass("rounded-xl");
  expect(build).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Describe your design"), { target: { value: "a dashboard" } });
  expect(build).not.toBeDisabled();
  fireEvent.click(build);
  expect(onNewProject).toHaveBeenCalledWith("a dashboard", "deck", "editorial", "prototype");
});

test("HomeScreen remembers the selected input parameters after remount", async () => {
  const user = userEvent.setup();
  const overrides = {
    listSkills: async () => SKILLS,
    listDesignSystems: async () => DSYS,
  };

  const { unmount } = renderWithApi(<HomeScreen projects={[]} />, overrides);
  await user.click(await screen.findByRole("button", { name: "Template" }));
  await user.click(await screen.findByRole("menuitem", { name: "Slides" }));
  await user.click(screen.getByRole("button", { name: "Design system" }));
  await user.click(await screen.findByText("Editorial"));
  await user.click(screen.getByRole("button", { name: "Mode" }));
  await user.click(await screen.findByRole("menuitem", { name: /^Standard/ }));

  unmount();
  renderWithApi(<HomeScreen projects={[]} />, overrides);

  await waitFor(() => expect(screen.getByRole("button", { name: "Template" })).toHaveTextContent("Slides"));
  expect(screen.getByRole("button", { name: "Design system" })).toHaveTextContent("Editorial");
  expect(screen.getByRole("button", { name: "Mode" })).toHaveTextContent("Standard");
});

test("HomeScreen optimizes the prompt with the selected agent and lets the user reject or accept it", async () => {
  const user = userEvent.setup();
  const onNewProject = vi.fn();
  let resolveFirst!: (value: { prompt: string }) => void;
  const firstOptimization = new Promise<{ prompt: string }>((resolve) => {
    resolveFirst = resolve;
  });
  const optimizePrompt = vi
    .fn()
    .mockImplementationOnce(() => firstOptimization)
    .mockResolvedValueOnce({ prompt: "Accepted optimized shader brief" });

  const { container } = renderWithApiAndAgents(<HomeScreen projects={[]} onNewProject={onNewProject} />, {
    listAgents: async () => [{ id: "codebuddy", command: "codebuddy", available: true, models: ["hunyuan"] }],
    getSettings: async () => settingsFixture({ agentCommand: "codebuddy", model: "hunyuan" }),
    listSkills: async () => SKILLS,
    listDesignSystems: async () => DSYS,
    optimizePrompt,
  });

  const textarea = await screen.findByLabelText("Describe your design");
  expect(screen.queryByRole("button", { name: "Optimize prompt" })).toBeNull();

  fireEvent.change(textarea, { target: { value: "make a shader site" } });
  await user.click(await screen.findByRole("button", { name: "Optimize prompt" }));
  await waitFor(() =>
    expect(optimizePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "make a shader site",
        agentCommand: "codebuddy",
        model: "hunyuan",
        mode: "prototype",
        skillId: "frontend-design",
        designSystemId: "modern-minimal",
      }),
    ),
  );
  expect(textarea).toBeDisabled();
  const loadingGradient = container.querySelector(".prompt-loading-gradient");
  expect(loadingGradient).not.toBeNull();
  expect(loadingGradient).toHaveAttribute("data-testid", "prompt-loading-surface");
  expect(loadingGradient).toHaveClass("motion-safe:animate-prompt-loading-gradient", "inset-0", "opacity-100");
  const optimizingButton = screen.getByRole("button", { name: "Optimizing prompt" });
  expect(optimizingButton).toBeDisabled();
  expect(optimizingButton).toHaveAttribute("aria-busy", "true");
  expect(optimizingButton).toHaveClass("bg-transparent", "disabled:opacity-100");
  expect(optimizingButton.querySelector(".animate-spin")).toBeNull();
  expect(optimizingButton.querySelector(".lucide-sparkles")).not.toBeNull();

  await act(async () => {
    resolveFirst({ prompt: "Create a finished shader microsite with sourced assets." });
    await firstOptimization;
  });

  expect(textarea).toHaveValue("Create a finished shader microsite with sourced assets.");
  fireEvent.click(screen.getByLabelText("Design"));
  expect(onNewProject).toHaveBeenCalledWith("Create a finished shader microsite with sourced assets.", "frontend-design", "modern-minimal", "prototype");

  await user.click(screen.getByRole("button", { name: "Reject optimized prompt" }));
  expect(textarea).toHaveValue("make a shader site");
  expect(screen.getByRole("button", { name: "Optimize prompt" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Optimize prompt" }));
  expect(await screen.findByRole("button", { name: "Accept optimized prompt" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Accept optimized prompt" }));
  expect(textarea).toHaveValue("Accepted optimized shader brief");
  expect(screen.getByRole("button", { name: "Optimize prompt" })).toBeInTheDocument();
});

test("HomeScreen prompt presents dropped image references as rich context without mutating the brief", async () => {
  const onNewProject = vi.fn();
  renderWithApi(<HomeScreen projects={[]} onNewProject={onNewProject} />, {
    listSkills: async () => SKILLS,
    listDesignSystems: async () => DSYS,
  });

  const file = new File(["image"], "reference.png", { type: "image/png" });
  fireEvent.drop(screen.getByLabelText("Design prompt dropzone"), { dataTransfer: { types: ["Files"], files: [file] } });

  const rail = await screen.findByRole("list", { name: "Attached context" });
  expect(rail).toHaveAttribute("data-context-density", "hero");
  expect(within(rail).getByRole("img", { name: "reference.png" })).toBeInTheDocument();
  expect(within(rail).getByText("Image")).toBeInTheDocument();
  expect(screen.getByLabelText("Describe your design")).toHaveValue("");

  fireEvent.click(screen.getByLabelText("Design"));
  expect(onNewProject).toHaveBeenCalledWith(
    "Recreate the reference screenshot faithfully.",
    "frontend-design",
    "modern-minimal",
    "prototype",
  );
  expect(takePendingImages()).toEqual([{ name: "reference.png", base64: expect.any(String) }]);
});

test("HomeScreen keeps local paths and imported fig context structured until Design", async () => {
  const onNewProject = vi.fn();
  const parseFig = vi.fn(async (_file: Blob, name: string) => ({ name, summary: "Palette: #123456\nFonts: Geist" }));
  const { container } = renderWithApi(<HomeScreen projects={[]} onNewProject={onNewProject} />, {
    listSkills: async () => SKILLS,
    listDesignSystems: async () => DSYS,
    parseFig,
  });

  const folder = new File([], "source-app", { type: "" });
  Object.defineProperty(folder, "path", { value: "/Users/ben/Projects/source-app" });
  fireEvent.drop(screen.getByLabelText("Design prompt dropzone"), {
    dataTransfer: { types: ["Files"], files: [folder] },
  });

  const rail = await screen.findByRole("list", { name: "Attached context" });
  expect(rail).toHaveAttribute("data-context-density", "hero");
  expect(within(rail).getByText("source-app")).toBeInTheDocument();
  expect(within(rail).getByText("Folder")).toBeInTheDocument();
  expect(screen.getByLabelText("Describe your design")).toHaveValue("");

  const figInput = container.querySelector<HTMLInputElement>('input[accept=".fig"]');
  expect(figInput).not.toBeNull();
  const fig = new File(["fig"], "brand.fig", { type: "application/octet-stream" });
  fireEvent.change(figInput!, { target: { files: [fig] } });

  await waitFor(() => expect(parseFig).toHaveBeenCalledWith(fig, "brand.fig"));
  expect(await within(rail).findByText("Imported context")).toBeInTheDocument();
  expect(screen.getByLabelText("Describe your design")).not.toHaveValue(expect.stringContaining("Use these local paths"));
  expect(screen.getByLabelText("Design")).toBeEnabled();

  fireEvent.click(screen.getByLabelText("Design"));
  expect(onNewProject).toHaveBeenCalledWith(
    expect.stringContaining("Reference local paths: /Users/ben/Projects/source-app"),
    "frontend-design",
    "modern-minimal",
    "prototype",
  );
  expect(onNewProject.mock.calls[0]?.[0]).toContain("Use the attached context to design the artifact.");
  expect(onNewProject.mock.calls[0]?.[0]).toContain("Palette: #123456\nFonts: Geist");
});

test("MoodboardsScreen uses a Home-like prompt to start a board with initial direction", async () => {
  const onOpenBoard = vi.fn();
  const board = moodboard("b1", "Warm editorial references");
  const startMoodboard = vi.fn(async () => board);
  renderWithApiAndAgents(<MoodboardsScreen onOpenBoard={onOpenBoard} />, {
    listMoodboards: async () => [],
    listAgents: async () => [{ id: "claude", command: "claude", available: true, models: ["sonnet"] }],
    startMoodboard,
  });

  const prompt = await screen.findByLabelText("Describe moodboard direction");
  expect(screen.getByRole("group", { name: "Moodboard start mode" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Agent and model" })).toBeInTheDocument();
  fireEvent.change(prompt, { target: { value: "Warm editorial references for a boutique hotel" } });
  const start = screen.getByRole("button", { name: "Start board" });
  expect(start).toHaveClass("rounded-lg");
  expect(start).not.toHaveClass("rounded-xl");
  fireEvent.click(start);

  await waitFor(() =>
    expect(startMoodboard).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Warm editorial references",
        prompt: "Warm editorial references for a boutique hotel",
        mode: "agent",
        agentCommand: "claude",
      }),
    ),
  );
  expect(onOpenBoard).toHaveBeenCalledWith("b1");
  expect(screen.getByRole("button", { name: "New board" })).toBeInTheDocument();
});

test("MoodboardsScreen uses the atomic start endpoint and preserves inputs until it succeeds", async () => {
  const onOpenBoard = vi.fn();
  const board = moodboard("b-atomic", "Retryable board");
  const first = deferred<typeof board>();
  const startMoodboard = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValueOnce(board);
  renderWithApiAndAgents(<MoodboardsScreen onOpenBoard={onOpenBoard} />, {
    listMoodboards: async () => [],
    listAgents: async () => [{ id: "claude", command: "claude", available: true, models: ["sonnet"] }],
    startMoodboard,
  });

  const prompt = await screen.findByLabelText("Describe moodboard direction");
  fireEvent.change(prompt, { target: { value: "Retryable board direction" } });
  fireEvent.click(screen.getByRole("button", { name: "Start board" }));
  await waitFor(() => expect(startMoodboard).toHaveBeenCalledTimes(1));
  expect(prompt).toHaveValue("Retryable board direction");

  await act(async () => first.reject(new Error("generation failed")));
  await waitFor(() => expect(screen.getByRole("button", { name: "Start board" })).toBeEnabled());
  expect(prompt).toHaveValue("Retryable board direction");

  fireEvent.click(screen.getByRole("button", { name: "Start board" }));
  await waitFor(() => expect(onOpenBoard).toHaveBeenCalledWith("b-atomic"));
  expect(prompt).toHaveValue("");
});

test("MoodboardsScreen retains rows while a background refresh fails", async () => {
  const board = moodboard("b-retained", "Retained board");
  const listMoodboards = vi.fn().mockResolvedValueOnce([board]).mockRejectedValueOnce(new Error("offline"));
  renderWithApi(<MoodboardsScreen onOpenBoard={vi.fn()} />, { listMoodboards });
  expect(await screen.findByText("Retained board")).toBeInTheDocument();

  act(() => window.dispatchEvent(new Event("focus")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't refresh moodboards");
  expect(screen.getByText("Retained board")).toBeInTheDocument();
});

test("MoodboardsScreen homepage prompt textarea auto-sizes with a capped height", async () => {
  renderWithApiAndAgents(<MoodboardsScreen onOpenBoard={vi.fn()} />, {
    listMoodboards: async () => [],
    listAgents: async () => [{ id: "claude", command: "claude", available: true, models: ["sonnet"] }],
  });

  const prompt = await screen.findByLabelText("Describe moodboard direction");
  expect(prompt).toHaveClass("field-sizing-content", "max-h-64", "min-h-[92px]");
});

test("MoodboardsScreen board cards are keyboard reachable and activate on Space", async () => {
  const onOpenBoard = vi.fn();
  renderWithApi(<MoodboardsScreen onOpenBoard={onOpenBoard} />, {
    listMoodboards: async () => [moodboard("b-keyboard", "Keyboard board")],
  });
  const card = await screen.findByRole("link", { name: "Open Keyboard board" });
  expect(card).toHaveAttribute("tabindex", "0");
  expect(card.className).toContain("focus-visible:ring");
  expect(card).not.toContainElement(screen.getByRole("button", { name: "Rename Keyboard board" }));
  card.focus();
  fireEvent.keyDown(card, { key: " " });
  expect(onOpenBoard).toHaveBeenCalledWith("b-keyboard");
});

test("MoodboardsScreen generate mode starts a board with an image model instead of an agent message", async () => {
  const onOpenBoard = vi.fn();
  const board = moodboard("b1", "Brutalist campaign board");
  const startMoodboard = vi.fn(async () => board);
  renderWithApiAndAgents(<MoodboardsScreen onOpenBoard={onOpenBoard} />, {
    listMoodboards: async () => [],
    listAgents: async () => [{ id: "claude", command: "claude", available: true, models: ["sonnet"] }],
    getSettings: async () => ({
      agentCommand: "claude",
      model: "",
      apiBaseUrl: "",
      apiKey: "",
      defaultDesignSystemId: "modern-minimal",
      customInstructions: "",
      imageApiBaseUrl: "",
      imageApiKey: "",
      imageModel: "gpt-image-1",
      removeBackgroundModel: "",
      editRegionModel: "",
      extractLayerModel: "",
      videoApiBaseUrl: "",
      videoApiKey: "",
      videoModel: "",
      aiProviderId: "openai",
      aiProviderEnabled: true,
      aiProviderModels: "gpt-image-1",
      aiProviderOrganization: "",
      aiProviderProfiles: "",
      visualQaEnabled: false,
      autoFixLiveRuntimeErrors: false,
      sharinganAffirmed: false,
      researchEnabled: false, researchAgentCommand: "", researchModel: "",      visualQaAgentCommand: "",
      visualQaModel: "",
      autoImproveEnabled: true,
      autoImproveMaxRounds: 8,
    }),
    startMoodboard,
  });

  await userEvent.click(await screen.findByRole("button", { name: "Model" }));
  expect(screen.queryByRole("button", { name: "Agent and model" })).toBeNull();
  expect(screen.getByRole("button", { name: "Image generation model" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Describe moodboard direction"), { target: { value: "Brutalist campaign board with product images" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate board" }));

  await waitFor(() =>
    expect(startMoodboard).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Brutalist campaign board",
        prompt: "Brutalist campaign board with product images",
        mode: "generate",
        imageModel: "gpt-image-1",
      }),
    ),
  );
  expect(onOpenBoard).toHaveBeenCalledWith("b1");
});

test("MoodboardsScreen refreshes image models when provider settings change", async () => {
  renderWithApiAndAgents(<MoodboardsScreen onOpenBoard={vi.fn()} />, {
    listMoodboards: async () => [],
    listAgents: async () => [{ id: "claude", command: "claude", available: true, models: ["sonnet"] }],
    getSettings: async () =>
      settingsFixture({
        aiProviderId: "openai",
        aiProviderEnabled: true,
        aiProviderModels: JSON.stringify({ id: "openai-image-live", capabilities: ["Image"] }),
        imageModel: "openai-image-live",
        aiProviderProfiles: JSON.stringify({
          openai: {
            enabled: true,
            baseUrl: "https://api.openai.com/v1",
            models: JSON.stringify({ id: "openai-image-live", capabilities: ["Image"] }),
            organization: "",
          },
          "azure-openai": {
            enabled: false,
            baseUrl: "https://example.openai.azure.com/openai",
            models: JSON.stringify({ id: "azure-image-deployment", capabilities: ["Image"] }),
            organization: "preview",
          },
        }),
      }),
  });

  await userEvent.click(await screen.findByRole("button", { name: "Model" }));
  expect(await screen.findByText(/openai-image-live/)).toBeInTheDocument();

  act(() => {
    window.dispatchEvent(
      new CustomEvent<Settings>(SETTINGS_UPDATED_EVENT, {
        detail: settingsFixture({
          aiProviderId: "azure-openai",
          aiProviderEnabled: true,
          aiProviderModels: JSON.stringify({ id: "azure-image-deployment", capabilities: ["Image"] }),
          imageModel: "azure-image-deployment",
          aiProviderProfiles: JSON.stringify({
            openai: {
              enabled: true,
              baseUrl: "https://api.openai.com/v1",
              models: JSON.stringify({ id: "openai-image-live", capabilities: ["Image"] }),
              organization: "",
            },
            "azure-openai": {
              enabled: true,
              baseUrl: "https://example.openai.azure.com/openai",
              models: JSON.stringify({ id: "azure-image-deployment", capabilities: ["Image"] }),
              organization: "preview",
            },
          }),
        }),
      }),
    );
  });

  expect(await screen.findByText(/azure-image-deployment/)).toBeInTheDocument();
  expect(screen.queryByText(/openai-image-live/)).toBeNull();
});

test("MoodboardsScreen prompt creates image nodes from dropped references", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:reference");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const onOpenBoard = vi.fn();
  const board = moodboard("b1", "Gallery wall");
  const startMoodboard = vi.fn(async () => board);
  renderWithApi(<MoodboardsScreen onOpenBoard={onOpenBoard} />, {
    listMoodboards: async () => [],
    startMoodboard,
  });

  const file = new File(["image"], "material.png", { type: "image/png" });
  fireEvent.drop(await screen.findByLabelText("Moodboard prompt dropzone"), { dataTransfer: { files: [file] } });
  expect(await screen.findByAltText("material.png")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Start board" }));

  await waitFor(() =>
    expect(startMoodboard).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Visual references",
        mode: "agent",
        images: [expect.objectContaining({ name: "material.png", mimeType: "image/png", contentBase64: expect.any(String) })],
      }),
    ),
  );
  expect(onOpenBoard).toHaveBeenCalledWith("b1");
});

test("DesignSystemsScreen loads systems from the daemon", async () => {
  renderWithApi(<DesignSystemsScreen />, {
    listDesignSystems: async () => [
      { id: "modern-minimal", name: "Modern Minimal", category: "Modern & Minimal", summary: "neutral" },
      { id: "editorial", name: "Editorial", category: "Editorial & Print", summary: "print" },
    ],
  });
  const heading = screen.getByRole("heading", { name: "Design systems" });
  expect(heading).toHaveClass("text-2xl", "font-semibold", "tracking-tight", "text-foreground");
  const subtitle = screen.getByText(/The brand visual language each artifact is built from/i);
  expect(subtitle).toHaveClass("mt-1.5", "text-sm", "leading-relaxed", "text-muted-foreground");
  const action = screen.getByRole("button", { name: "New design system" });
  expect(action).toHaveAttribute("data-variant", "default");
  expect(action).toHaveAttribute("data-size", "default");
  expect(action).toHaveClass("gap-2", "bg-primary");
  expect(action).not.toHaveClass("border");
  expect(await screen.findByText("Modern Minimal")).toBeInTheDocument();
  expect(screen.getByText("Editorial")).toBeInTheDocument();
});

test("DesignSystemsScreen shows an error line when the load fails", async () => {
  renderWithApi(<DesignSystemsScreen />, {
    listDesignSystems: async () => {
      throw new Error("boom");
    },
  });
  expect(await screen.findByText(/Couldn't load design systems/i)).toBeInTheDocument();
});

test("DesignSystemsScreen lists systems and links to a detail page", async () => {
  renderWithApi(<DesignSystemsScreen />, {
    listDesignSystems: async () => [{ id: "modern-minimal", name: "Modern Minimal", category: "Modern & Minimal", summary: "neutral" }],
  });
  expect(await screen.findByText("Modern Minimal")).toBeInTheDocument();
});

test("EffectsScreen displays built-in effects and creates a custom effect from the modal", async () => {
  const user = userEvent.setup();
  const created = {
    id: "custom-1",
    name: "Glass ribbon",
    origin: "custom" as const,
    category: "Custom",
    summary: "Editable local effect.",
    parameters: [],
    presets: [{ id: "default", name: "Default", values: {} }],
    code: "function renderEffect(ctx) { ctx.clearRect(0, 0, 10, 10); }",
  };
  const createEffect = vi.fn(async () => created);
  renderWithApi(<EffectsScreen />, {
    listEffects: async () => [
      {
        id: "paper-texture",
        name: "paper texture",
        origin: "built-in",
        category: "@Paper",
        summary: "Paper grain",
        previewUrl: "/effects/previews/paper-texture.jpg",
      },
      {
        id: "mesh-gradient",
        name: "mesh gradient",
        origin: "built-in",
        category: "@Paper",
        summary: "Color mesh",
        previewUrl: "/effects/previews/mesh-gradient.jpg",
      },
    ],
    createEffect,
  });

  expect(await screen.findByRole("heading", { name: "Effects" })).toBeInTheDocument();
  expect(screen.getByText("paper texture")).toBeInTheDocument();
  expect(screen.getByText("mesh gradient")).toBeInTheDocument();
  expect(screen.getAllByText("@Paper")).toHaveLength(2);
  expect(screen.getByTestId("effect-card-preview-paper-texture")).toHaveClass("aspect-[4/3]");
  expect(screen.getByRole("img", { name: "paper texture preview" })).toHaveAttribute("src", "/effects/previews/paper-texture.jpg");
  expect(screen.queryByText("Preview")).toBeNull();
  expect(screen.queryByText("Image Filter")).toBeNull();
  expect(screen.queryByText("Paper grain")).toBeNull();
  await user.click(screen.getByRole("button", { name: "New Effect" }));
  fireEvent.change(screen.getByLabelText("Effect Name"), { target: { value: "Glass ribbon" } });
  await user.click(screen.getByRole("button", { name: "Create" }));

  await waitFor(() => expect(createEffect).toHaveBeenCalledWith({ name: "Glass ribbon" }));
  expect(window.location.pathname).toBe("/effects/custom-1");
});

test("EffectScreen renders the playground with agent, preview, parameters, presets, and export", async () => {
  const updateSettings = vi.fn(async (patch: Partial<Settings>) => settingsFixture({ ...patch }));
  renderWithApiAndAgents(<EffectScreen effectId="paper-texture" onBack={() => {}} />, {
    listAgents: async () => AGENTS,
    rescanAgents: async () => AGENTS,
    getSettings: async () => settingsFixture({ agentCommand: "claude", model: "claude-sonnet-4-6" }),
    updateSettings,
    getEffect: async () => ({
      id: "paper-texture",
      name: "paper texture",
      origin: "built-in" as const,
      category: "@Paper",
      summary: "Paper grain",
      parameters: [
        {
          id: "image",
          label: "Image",
          type: "image" as const,
          defaultValue: "/effects/demo-landscape.jpg",
          options: [{ label: "Landscape", value: "/effects/demo-landscape.jpg" }],
        },
        { id: "roughness", label: "Roughness", type: "number" as const, min: 0, max: 1, step: 0.01, defaultValue: 0.4 },
        { id: "colorBack", label: "Paper", type: "color" as const, defaultValue: "#f7f2e8" },
      ],
      presets: [{ id: "default", name: "Default", values: { image: "/effects/demo-landscape.jpg", roughness: 0.4, colorBack: "#f7f2e8" } }],
      code: "@paper-design/shaders-react:paper-texture",
    }),
  });

  expect(await screen.findByRole("button", { name: "Back to effects" })).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Effect Agent" })).toBeInTheDocument();
  expect(screen.getByRole("separator", { name: "Resize effect agent panel" })).toHaveAttribute("data-separator");
  await waitFor(() => expect(screen.getByRole("button", { name: "Agent and model" })).toHaveTextContent("Claude Code"));
  expect(screen.getByRole("button", { name: "Agent and model" })).toHaveTextContent("claude-sonnet-4-6");
  expect(screen.getByTestId("effect-agent-composer")).not.toHaveClass("border-t");
  expect(screen.getByText(/Describe the texture, motion, color, or image treatment/)).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Effect preview" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Effect parameters" })).toBeInTheDocument();
  expect(screen.getByRole("separator", { name: "Resize effect parameters panel" })).toHaveAttribute("data-separator");
  expect(screen.getByRole("combobox", { name: "Presets" })).toHaveTextContent("Default");
  expect(screen.getByRole("combobox", { name: "Image" })).toHaveTextContent("Landscape");
  expect(screen.getByLabelText("Roughness")).toHaveAttribute("type", "range");
  expect(screen.getByLabelText("Roughness value")).toHaveValue(0.4);
  expect(screen.getByLabelText("Paper")).toHaveValue("#f7f2e8");
  expect(screen.getByRole("button", { name: "Export image" })).toBeInTheDocument();
  expect(screen.queryByText("Live preview")).toBeNull();
  expect(screen.queryByText("Canvas")).toBeNull();
  expect(screen.queryByText("Image Filter")).toBeNull();
});

test("DesignSystemDetailScreen loads a system and sets it as default", async () => {
  const updateSettings = vi.fn(async () => ({
    agentCommand: "claude",
    model: "",
    apiBaseUrl: "",
    apiKey: "",
    defaultDesignSystemId: "modern-minimal",
    customInstructions: "",
  }));
  const getDesignSystem = vi.fn(async (id: string) => ({
    id,
    name: "Modern Minimal",
    category: "Modern & Minimal",
    summary: "neutral grayscale",
    swatch: { bg: "#fff", surface: "#eee", fg: "#111", accent: "#3656ff" },
    designMd: "# Modern Minimal\n## 1. Visual Theme\nClean and quiet.",
    tokensCss: ":root{--bg:#fff;--fg:#111;--accent:#3656ff;--font-display:Inter}",
  }));
  renderWithApi(<DesignSystemDetailScreen id="modern-minimal" />, { getDesignSystem, updateSettings });
  await screen.findByRole("heading", { name: "Modern Minimal" });
  expect(screen.getByRole("separator", { name: "Resize spec navigation" })).toHaveAttribute("data-separator");
  expect(getDesignSystem).toHaveBeenCalledWith("modern-minimal");
  fireEvent.click(await screen.findByRole("button", { name: /Set default/ }));
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ defaultDesignSystemId: "modern-minimal" }));
});

test("DesignSystemNewScreen uses the saved agent/model as a local default without saving changes globally", async () => {
  const user = userEvent.setup();
  const updateSettings = vi.fn(async (patch: Partial<Settings>) => settingsFixture(patch));
  const importBrand = vi.fn(async () => ({ id: "custom-brand", name: "Custom Brand", category: "Custom", summary: "Imported" }));

  renderWithApiToastAndAgents(<DesignSystemNewScreen />, {
    listAgents: async () => AGENTS,
    rescanAgents: async () => AGENTS,
    getSettings: async () => settingsFixture({ agentCommand: "codex", model: "gpt-5" }),
    updateSettings,
    importBrand,
  });

  const trigger = await screen.findByRole("button", { name: "Agent and model" });
  await waitFor(() => expect(trigger).toHaveTextContent("Codex"));
  expect(trigger).toHaveTextContent("gpt-5");

  await user.click(trigger);
  await user.click(await screen.findByRole("button", { name: /Claude/i }));
  await user.click(await screen.findByRole("button", { name: "claude-sonnet-4-6" }));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  fireEvent.change(screen.getByLabelText(/Company name and blurb/i), { target: { value: "Custom Brand: a focused component system" } });
  await user.click(screen.getByRole("button", { name: "Create design system" }));

  await waitFor(() =>
    expect(importBrand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Custom Brand", agentCommand: "claude", model: "claude-sonnet-4-6" }),
    ),
  );
  expect(updateSettings).not.toHaveBeenCalled();
});

test("DesignSystemNewScreen accepts dropped folders, fig files, and asset files", async () => {
  const parseFig = vi.fn(async (_file: Blob, name: string) => ({ name, summary: "Palette: #123456\nFonts: Geist" }));
  renderWithApiToastAndAgents(<DesignSystemNewScreen />, {
    listAgents: async () => AGENTS,
    parseFig,
  });

  const folder = new File([], "brand-kit", { type: "" });
  Object.defineProperty(folder, "path", { value: "/tmp/brand-kit" });
  fireEvent.drop(await screen.findByRole("button", { name: /Pick a folder/i }), {
    dataTransfer: { types: ["Files"], files: [folder] },
  });
  expect(await screen.findByText("/tmp/brand-kit")).toBeInTheDocument();

  const fig = new File(["fig"], "brand.fig", { type: "application/octet-stream" });
  fireEvent.drop(screen.getByRole("button", { name: /Choose a \.fig file/i }), {
    dataTransfer: { types: ["Files"], files: [fig] },
  });
  await waitFor(() => expect(parseFig).toHaveBeenCalledWith(fig, "brand.fig"));
  expect(await screen.findByText("brand.fig")).toBeInTheDocument();

  const logo = new File(["logo"], "logo.svg", { type: "image/svg+xml" });
  fireEvent.drop(screen.getByRole("button", { name: /Choose files/i }), {
    dataTransfer: { types: ["Files"], files: [logo] },
  });
  expect(await screen.findByText("logo.svg")).toBeInTheDocument();
});

test("DesignSystemNewScreen shows the fig parser error detail", async () => {
  renderWithApiToastAndAgents(<DesignSystemNewScreen />, {
    listAgents: async () => AGENTS,
    parseFig: async () => {
      throw new Error('Couldn\'t read brand.fig: not a fig-kiwi archive (prelude "SQLite f")');
    },
  });

  const fig = new File(["bad"], "brand.fig", { type: "application/octet-stream" });
  fireEvent.drop(await screen.findByRole("button", { name: /Choose a \.fig file/i }), {
    dataTransfer: { types: ["Files"], files: [fig] },
  });

  expect(await screen.findByRole("alert")).toHaveTextContent("not a fig-kiwi archive");
});

function project(id: string, name: string) {
  return { id, name, skillId: null, designSystemId: "modern-minimal", mode: "prototype" as const, createdAt: 1, updatedAt: 2 };
}

function moodboard(id: string, name: string) {
  return { id, name, createdAt: 1, updatedAt: 2, archivedAt: null, coverUrl: null };
}

test("HomeScreen loads projects from the daemon and archives one", async () => {
  let projects = [project("p1", "Pricing page"), project("p2", "Marketing site")];
  const patchProject = vi.fn(async (id: string, patch: { archived?: boolean }) => {
    projects = projects.map((p) => (p.id === id ? { ...p, archivedAt: patch.archived ? 1 : null } : p));
    return projects.find((p) => p.id === id)!;
  });
  render(
    <ApiProvider client={makeFakeApi({ listProjects: async () => projects, patchProject, listSkills: async () => SKILLS })}>
      <HomeScreen />
    </ApiProvider>,
  );
  expect(await screen.findByText("Pricing page")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Archive Pricing page"));
  expect(patchProject).toHaveBeenCalledWith("p1", { archived: true });
  expect(await screen.findByText("Marketing site")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText("Pricing page")).toBeNull());
});

test("HomeScreen renames a project via the dialog", async () => {
  const patchProject = vi.fn(async () => project("p1", "Pricing v2"));
  render(
    <ApiProvider client={makeFakeApi({ listProjects: async () => [project("p1", "Pricing page")], patchProject, listSkills: async () => SKILLS })}>
      <HomeScreen />
    </ApiProvider>,
  );
  fireEvent.click(await screen.findByLabelText("Rename Pricing page"));
  const input = await screen.findByLabelText("Project name");
  fireEvent.change(input, { target: { value: "Pricing v2" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(patchProject).toHaveBeenCalledWith("p1", { name: "Pricing v2" });
});

const AGENTS = [
  { id: "claude", command: "claude", available: true, version: "claude 1.2.3", models: ["claude-opus-4-8", "claude-sonnet-4-6"] },
  { id: "codex", command: "codex", available: true, version: "codex 1.0.0", models: ["gpt-5"] },
  { id: "gemini", command: "gemini", available: false, models: [] },
];
const DSYS = [
  { id: "modern-minimal", name: "Modern Minimal", category: "", summary: "" },
  { id: "editorial", name: "Editorial", category: "", summary: "" },
];

test("HomeScreen composer honors the saved agent + model, not the first available", async () => {
  const settings = {
    agentCommand: "codex", // NOT claude (the first available) — e.g. the agent chosen during onboarding
    model: "gpt-5",
    apiBaseUrl: "",
    apiKey: "",
    defaultDesignSystemId: "modern-minimal",
    customInstructions: "",
    imageApiBaseUrl: "",
    imageApiKey: "",
    imageModel: "",
    removeBackgroundModel: "",
    editRegionModel: "",
    extractLayerModel: "",
    videoApiBaseUrl: "",
    videoApiKey: "",
    videoModel: "",
    aiProviderId: "openai",
    aiProviderEnabled: false,
    aiProviderModels: "gpt-image-1",
    aiProviderOrganization: "",
    aiProviderProfiles: "",
    visualQaEnabled: false,
    autoFixLiveRuntimeErrors: false,
    sharinganAffirmed: false,
    researchEnabled: false, researchAgentCommand: "", researchModel: "",    visualQaAgentCommand: "",
    visualQaModel: "",
    autoImproveEnabled: true,
    autoImproveMaxRounds: 8,
  };
  render(
    <ApiProvider
      client={makeFakeApi({
        listAgents: async () => AGENTS,
        rescanAgents: async () => AGENTS,
        getSettings: async () => settings,
        listSkills: async () => SKILLS,
        listDesignSystems: async () => DSYS,
      })}
    >
      <AgentsProvider>
        <HomeScreen projects={[]} />
      </AgentsProvider>
    </ApiProvider>,
  );
  const trigger = await screen.findByRole("button", { name: "Agent and model" });
  await waitFor(() => expect(trigger).toHaveTextContent("Codex"));
  expect(trigger).toHaveTextContent("gpt-5");
});

function renderSettings(over = {}) {
  const onToggleDark = vi.fn();
  const updateSettings = vi.fn(async (p: Partial<Settings>) => settingsFixture(p));
  const api = makeFakeApi({ listAgents: async () => AGENTS, rescanAgents: async () => AGENTS, listDesignSystems: async () => DSYS, updateSettings, ...over });
  render(
    <ApiProvider client={api}>
      <AgentsProvider>
        <SettingsScreen dark={false} onToggleDark={onToggleDark} />
      </AgentsProvider>
    </ApiProvider>,
  );
  return { onToggleDark, updateSettings };
}

test("SettingsScreen sidebar lists sections; Agents + Defaults show daemon data", async () => {
  renderSettings();
  for (const name of ["Appearance", "Agents", "Providers", "Quality", "Defaults", "Custom instructions", "About"]) {
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
  }
  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  // the detected daemon agent shows as a card with its version
  expect(await screen.findByText(/claude 1\.2\.3/)).toBeInTheDocument();
  // an uninstalled agent is shown but disabled (not selectable)
  expect(screen.getByRole("button", { name: /Gemini/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Defaults" }));
  expect(await screen.findByRole("combobox", { name: "Default design system" })).toHaveTextContent("Modern Minimal");
});

test("SettingsScreen generates a pairing code and displays its expiration", async () => {
  const createExtensionPairingCode = vi.fn(async () => ({ code: "123456", expiresAt: Date.now() + 5 * 60_000 }));
  renderSettings({
    createExtensionPairingCode,
    listExtensionCredentials: async () => [],
  });

  fireEvent.click(screen.getByRole("button", { name: "Browser extension" }));
  fireEvent.click(await screen.findByRole("button", { name: "Generate pairing code" }));

  expect(await screen.findByText("123456")).toBeInTheDocument();
  expect(screen.getByText(/Expires/)).toBeInTheDocument();
  expect(createExtensionPairingCode).toHaveBeenCalledTimes(1);
});

test("SettingsScreen revokes a paired extension", async () => {
  const revokeExtensionCredential = vi.fn(async () => undefined);
  renderSettings({
    listExtensionCredentials: async () => [
      {
        id: "credential-1",
        extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        scopes: ["capture:write", "image:analyze"],
        createdAt: Date.now(),
        lastUsedAt: null,
        revokedAt: null,
      },
    ],
    revokeExtensionCredential,
  });

  fireEvent.click(screen.getByRole("button", { name: "Browser extension" }));
  fireEvent.click(await screen.findByRole("button", { name: "Revoke aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));

  await waitFor(() => expect(revokeExtensionCredential).toHaveBeenCalledWith("credential-1"));
  expect(screen.queryByRole("button", { name: "Revoke aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toBeNull();
});

test("SettingsScreen refreshes externally paired credentials on window focus without remounting", async () => {
  const newlyPaired = {
    id: "credential-new",
    extensionId: "cccccccccccccccccccccccccccccccc",
    scopes: ["capture:write", "image:analyze"] as const,
    createdAt: Date.now(),
    lastUsedAt: null,
    revokedAt: null,
  };
  let credentials: typeof newlyPaired[] = [];
  const listExtensionCredentials = vi.fn(async () => credentials);
  const revokeExtensionCredential = vi.fn(async () => undefined);
  renderSettings({ listExtensionCredentials, revokeExtensionCredential });

  fireEvent.click(screen.getByRole("button", { name: "Browser extension" }));
  await waitFor(() => expect(listExtensionCredentials).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: `Revoke ${newlyPaired.extensionId}` })).toBeNull();

  credentials = [newlyPaired];
  act(() => window.dispatchEvent(new Event("focus")));
  const revoke = await screen.findByRole("button", { name: `Revoke ${newlyPaired.extensionId}` });
  expect(listExtensionCredentials).toHaveBeenCalledTimes(2);

  fireEvent.click(revoke);
  await waitFor(() => expect(revokeExtensionCredential).toHaveBeenCalledWith(newlyPaired.id));
  expect(screen.queryByRole("button", { name: `Revoke ${newlyPaired.extensionId}` })).toBeNull();
});

test("SettingsScreen pairing errors are retryable", async () => {
  const createExtensionPairingCode = vi
    .fn()
    .mockRejectedValueOnce(new Error("daemon busy"))
    .mockResolvedValueOnce({ code: "654321", expiresAt: Date.now() + 5 * 60_000 });
  renderSettings({
    createExtensionPairingCode,
    listExtensionCredentials: async () => [],
  });

  fireEvent.click(screen.getByRole("button", { name: "Browser extension" }));
  const button = await screen.findByRole("button", { name: "Generate pairing code" });
  fireEvent.click(button);
  await waitFor(() => expect(createExtensionPairingCode).toHaveBeenCalledTimes(1));
  expect(button).toBeEnabled();

  fireEvent.click(button);
  expect(await screen.findByText("654321")).toBeInTheDocument();
  expect(createExtensionPairingCode).toHaveBeenCalledTimes(2);
});

test("SettingsScreen Defaults configures function-specific image models", async () => {
  const user = userEvent.setup();
  let current = settingsFixture({
    aiProviderEnabled: true,
    aiProviderModels: JSON.stringify({ id: "gpt-image-1", capabilities: ["Image"] }),
    imageModel: "gpt-image-1",
  });
  const updateSettings = vi.fn(async (patch: Partial<Settings>) => {
    current = { ...current, ...patch };
    return current;
  });
  renderSettings({ getSettings: async () => current, updateSettings });

  fireEvent.click(screen.getByRole("button", { name: "Defaults" }));

  expect(await screen.findByRole("combobox", { name: "Remove background model" })).toHaveTextContent("None");
  expect(screen.getByRole("combobox", { name: "Edit region model" })).toHaveTextContent("None");
  expect(screen.getByRole("combobox", { name: "Extract layer model" })).toHaveTextContent("None");

  await user.click(screen.getByRole("combobox", { name: "Remove background model" }));
  await user.click(await screen.findByRole("option", { name: "gpt-image-1" }));

  expect(updateSettings).toHaveBeenCalledWith({ removeBackgroundModel: "gpt-image-1" });
});

test("SettingsScreen initial Defaults focus targets a function model field", async () => {
  render(
    <ApiProvider client={makeFakeApi({ listAgents: async () => AGENTS, rescanAgents: async () => AGENTS, listDesignSystems: async () => DSYS })}>
      <AgentsProvider>
        <SettingsScreen dark={false} onToggleDark={() => {}} initialSection="defaults:editRegionModel" />
      </AgentsProvider>
    </ApiProvider>,
  );

  const target = await screen.findByRole("combobox", { name: "Edit region model" });
  await waitFor(() => expect(target).toHaveFocus());
});

test("SettingsScreen persists the chosen provider and custom instructions", async () => {
  const user = userEvent.setup();
  const { updateSettings } = renderSettings();
  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  await user.click(await screen.findByRole("button", { name: /Codex/ }));
  expect(updateSettings).toHaveBeenCalledWith({ agentCommand: "codex" });

  fireEvent.click(screen.getByRole("button", { name: "Custom instructions" }));
  const ci = await screen.findByLabelText("Custom instructions");
  fireEvent.change(ci, { target: { value: "be terse" } });
  fireEvent.blur(ci);
  expect(updateSettings).toHaveBeenCalledWith({ customInstructions: "be terse" });

  fireEvent.click(screen.getByRole("button", { name: "Quality" }));
  await user.click(await screen.findByRole("switch", { name: "Agent visual review" }));
  expect(updateSettings).toHaveBeenCalledWith({ visualQaEnabled: true });
  expect(screen.getByRole("combobox", { name: "Visual review agent" })).toHaveTextContent("Same as project agent");
  expect(screen.getByRole("combobox", { name: "Visual review model" })).toHaveTextContent("Same as project model");
  expect(screen.getByRole("spinbutton", { name: "Max auto-improve rounds" })).toHaveValue(8);

  await user.click(screen.getByRole("switch", { name: "Auto-improve after review" }));
  expect(updateSettings).toHaveBeenCalledWith({ autoImproveEnabled: false });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Max auto-improve rounds" }), { target: { value: "6" } });
  fireEvent.blur(screen.getByRole("spinbutton", { name: "Max auto-improve rounds" }));
  expect(updateSettings).toHaveBeenCalledWith({ autoImproveMaxRounds: 6 });

  await user.click(screen.getByRole("combobox", { name: "Visual review agent" }));
  await user.click(await screen.findByRole("option", { name: "Codex" }));
  expect(updateSettings).toHaveBeenCalledWith({ visualQaAgentCommand: "codex", visualQaModel: "" });
  await user.click(screen.getByRole("combobox", { name: "Visual review model" }));
  await user.click(await screen.findByRole("option", { name: "gpt-5" }));
  expect(updateSettings).toHaveBeenCalledWith({ visualQaModel: "gpt-5" });

  // Design research has its own Agent/model selection, independent of Visual review.
  expect(screen.getByRole("combobox", { name: "Research agent" })).toHaveTextContent("Same as project agent");
  expect(screen.getByRole("combobox", { name: "Research model" })).toHaveTextContent("Same as project model");
  await user.click(screen.getByRole("switch", { name: "Design research" }));
  expect(updateSettings).toHaveBeenCalledWith({ researchEnabled: true });
  await user.click(screen.getByRole("combobox", { name: "Research agent" }));
  await user.click(await screen.findByRole("option", { name: "Codex" }));
  expect(updateSettings).toHaveBeenCalledWith({ researchAgentCommand: "codex", researchModel: "" });
  await user.click(screen.getByRole("combobox", { name: "Research model" }));
  await user.click(await screen.findByRole("option", { name: "gpt-5" }));
  expect(updateSettings).toHaveBeenCalledWith({ researchModel: "gpt-5" });
});

test("SettingsScreen rolls back only the keys from a failed optimistic mutation", async () => {
  const visual = deferred<Settings>();
  const research = deferred<Settings>();
  const updateSettings = vi.fn((patch: Partial<Settings>) =>
    "visualQaEnabled" in patch ? visual.promise : "researchEnabled" in patch ? research.promise : Promise.resolve(settingsFixture(patch)),
  );
  renderSettings({ updateSettings });
  fireEvent.click(screen.getByRole("button", { name: "Quality" }));
  const visualSwitch = await screen.findByRole("switch", { name: "Agent visual review" });
  const researchSwitch = screen.getByRole("switch", { name: "Design research" });

  fireEvent.click(visualSwitch);
  fireEvent.click(researchSwitch);
  await act(async () => research.resolve(settingsFixture({ researchEnabled: true })));
  await act(async () => visual.reject(new Error("write failed")));

  await waitFor(() => expect(visualSwitch).not.toBeChecked());
  expect(researchSwitch).toBeChecked();
});

test("SettingsScreen ignores stale full responses that arrive after a newer edit", async () => {
  const researchAgent = deferred<Settings>();
  const visual = deferred<Settings>();
  const updateSettings = vi.fn((patch: Partial<Settings>) =>
    "researchAgentCommand" in patch ? researchAgent.promise : "visualQaEnabled" in patch ? visual.promise : Promise.resolve(settingsFixture(patch)),
  );
  renderSettings({ updateSettings });
  fireEvent.click(screen.getByRole("button", { name: "Quality" }));
  await userEvent.click(await screen.findByRole("combobox", { name: "Research agent" }));
  await userEvent.click(await screen.findByRole("option", { name: "Codex" }));
  const visualSwitch = screen.getByRole("switch", { name: "Agent visual review" });
  fireEvent.click(visualSwitch);

  await act(async () => visual.resolve(settingsFixture({ visualQaEnabled: true })));
  await act(async () => researchAgent.resolve(settingsFixture({ researchAgentCommand: "codex", visualQaEnabled: false })));

  await waitFor(() => expect(visualSwitch).toBeChecked());
});

test("SettingsScreen does not replace a newer unsaved draft with an older save response", async () => {
  const firstSave = deferred<Settings>();
  const updateSettings = vi.fn(() => firstSave.promise);
  renderSettings({ getSettings: async () => settingsFixture({ customInstructions: "initial" }), updateSettings });
  fireEvent.click(screen.getByRole("button", { name: "Custom instructions" }));
  const input = await screen.findByLabelText("Custom instructions");

  fireEvent.change(input, { target: { value: "first draft" } });
  fireEvent.blur(input);
  fireEvent.change(input, { target: { value: "newer unsaved draft" } });
  await act(async () => firstSave.resolve(settingsFixture({ customInstructions: "first draft" })));

  expect(input).toHaveValue("newer unsaved draft");
});

test("SettingsScreen serializes same-key saves and rolls a failed save back to the latest acknowledged value", async () => {
  const firstSave = deferred<Settings>();
  const secondSave = deferred<Settings>();
  const updateSettings = vi
    .fn<(patch: Partial<Settings>) => Promise<Settings>>()
    .mockImplementationOnce(() => firstSave.promise)
    .mockImplementationOnce(() => secondSave.promise);
  renderSettings({ getSettings: async () => settingsFixture({ customInstructions: "initial" }), updateSettings });
  fireEvent.click(screen.getByRole("button", { name: "Custom instructions" }));
  const input = await screen.findByLabelText("Custom instructions");

  fireEvent.change(input, { target: { value: "first saved" } });
  fireEvent.blur(input);
  fireEvent.change(input, { target: { value: "second failed" } });
  fireEvent.blur(input);
  expect(updateSettings).toHaveBeenCalledTimes(1);

  await act(async () => firstSave.resolve(settingsFixture({ customInstructions: "first saved" })));
  await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
  await act(async () => secondSave.reject(new Error("write failed")));

  await waitFor(() => expect(input).toHaveValue("first saved"));
});

test("SettingsScreen keeps model API key drafts after redacted settings saves", async () => {
  const user = userEvent.setup();
  const updateSettings = vi.fn(async (p: Partial<Settings>) => {
    const saved = settingsFixture(p);
    return { ...saved, apiKey: "", imageApiKey: "", videoApiKey: "" };
  });

  renderSettings({ updateSettings });
  fireEvent.click(screen.getByRole("button", { name: "Providers" }));

  const apiKey = await screen.findByLabelText("API Key");
  await user.type(apiKey, "sk-live-test");
  fireEvent.blur(apiKey);

  await waitFor(() => expect(updateSettings).toHaveBeenCalled());
  expect(apiKey).toHaveValue("sk-live-test");
});

test("SettingsScreen keeps provider status enabled after reopening with a redacted API key", async () => {
  renderSettings({
    getSettings: async () =>
      settingsFixture({
        aiProviderEnabled: true,
        apiKey: "",
        imageApiKey: "",
        apiKeyConfigured: true,
        imageApiKeyConfigured: true,
      } as Partial<Settings>),
  });

  fireEvent.click(screen.getByRole("button", { name: "Providers" }));

  expect(await screen.findByLabelText("OpenAI enabled")).toHaveClass("bg-[var(--success)]");
});

test("SettingsScreen shows provider status per provider and hides unsupported providers", async () => {
  const user = userEvent.setup();
  let current = settingsFixture({
    aiProviderId: "openai",
    aiProviderEnabled: true,
    aiProviderModels: "gpt-image-1",
    aiProviderProfiles: JSON.stringify({
      openai: {
        enabled: true,
        baseUrl: "https://api.openai.com/v1",
        models: "gpt-image-1",
        organization: "",
      },
      "azure-openai": {
        enabled: false,
        baseUrl: "https://{resource}.openai.azure.com",
        models: JSON.stringify({ id: "azure-image-deployment", capabilities: ["Image"] }),
        organization: "preview",
      },
    }),
  });
  const updateSettings = vi.fn(async (patch: Partial<Settings>) => {
    current = { ...current, ...patch };
    return current;
  });
  renderSettings({ getSettings: async () => current, updateSettings });

  fireEvent.click(screen.getByRole("button", { name: "Providers" }));

  expect(await screen.findByLabelText("OpenAI enabled")).toHaveClass("bg-[var(--success)]");
  expect(screen.getByLabelText("Azure OpenAI disabled")).toHaveClass("bg-border-strong");
  expect(screen.queryByText(/AI SDK|Native/)).toBeNull();
  expect(screen.getByText("Google AI Studio")).toBeInTheDocument();
  expect(screen.getByText("fal.ai")).toBeInTheDocument();
  expect(screen.getByText("Google Vertex AI")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Mock/ })).toBeNull();
  for (const removed of ["Midjourney", "WaveSpeed"]) {
    expect(screen.queryByRole("button", { name: new RegExp(removed) })).toBeNull();
  }

  const azure = screen.getByLabelText("Azure OpenAI disabled").closest("button")!;
  await user.click(azure);
  expect(updateSettings).not.toHaveBeenCalled();
  expect(await screen.findByLabelText("OpenAI enabled")).toHaveClass("bg-[var(--success)]");
  expect(screen.getByLabelText("Azure OpenAI disabled")).toHaveClass("bg-border-strong");

  await user.click(await screen.findByRole("switch", { name: "Enable Azure OpenAI" }));
  await waitFor(() =>
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        aiProviderId: "azure-openai",
        aiProviderEnabled: true,
        aiProviderModels: expect.stringContaining("azure-image-deployment"),
        imageModel: "azure-image-deployment",
        aiProviderProfiles: expect.stringContaining('"enabled":true'),
      }),
    ),
  );
});

test("SettingsScreen shows Azure OpenAI fields as resource endpoint plus deployment names", async () => {
  const user = userEvent.setup();
  renderSettings();

  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  const azure = await screen.findByLabelText("Azure OpenAI disabled");
  await user.click(azure.closest("button")!);

  expect(await screen.findByLabelText("Resource endpoint")).toHaveAttribute("placeholder", "https://{resource}.openai.azure.com");
  expect(screen.getByLabelText("API version")).toHaveAttribute("placeholder", "2025-04-01-preview");
  expect(screen.getByText(/Enter Azure deployment names/)).toBeInTheDocument();
});

test("SettingsScreen clears image runtime when enabling a text-only provider", async () => {
  const user = userEvent.setup();
  let current = settingsFixture({
    aiProviderId: "openai",
    aiProviderEnabled: true,
    imageApiBaseUrl: "https://api.openai.com/v1",
    imageModel: "gpt-image-1",
    aiProviderProfiles: JSON.stringify({
      openai: {
        enabled: true,
        baseUrl: "https://api.openai.com/v1",
        models: "gpt-image-1",
        organization: "",
      },
      anthropic: {
        enabled: false,
        baseUrl: "https://api.anthropic.com/v1",
        models: "claude-sonnet-4-6",
        organization: "",
      },
    }),
  });
  const updateSettings = vi.fn(async (patch: Partial<Settings>) => {
    current = { ...current, ...patch };
    return current;
  });
  renderSettings({ getSettings: async () => current, updateSettings });

  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  const anthropic = await screen.findByLabelText("Anthropic disabled");
  await user.click(anthropic.closest("button")!);
  await user.click(await screen.findByRole("switch", { name: "Enable Anthropic" }));

  await waitFor(() =>
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        aiProviderId: "anthropic",
        imageApiBaseUrl: "",
        videoApiBaseUrl: "",
        imageModel: "",
      }),
    ),
  );
});

test("SettingsScreen tests the selected model provider through the daemon", async () => {
  const user = userEvent.setup();
  const testModelProvider = vi.fn(async () => ({ ok: true, message: "Connected to OpenAI. Found 2 models." }));
  renderSettings({ testModelProvider });
  fireEvent.click(screen.getByRole("button", { name: "Providers" }));

  await user.click(await screen.findByRole("button", { name: "Test connection" }));

  expect(testModelProvider).toHaveBeenCalledWith("openai");
  expect(await screen.findByText("Connected to OpenAI. Found 2 models.")).toBeInTheDocument();
});

test("SettingsScreen loads live model provider models through the daemon", async () => {
  const user = userEvent.setup();
  const listModelProviderModels = vi.fn(async () => ({
    models: [{ id: "gpt-live-1", name: "GPT Live 1" }],
  }));
  const { updateSettings } = renderSettings({ listModelProviderModels });
  fireEvent.click(screen.getByRole("button", { name: "Providers" }));

  await user.click(await screen.findByRole("button", { name: "Get model list" }));

  expect(listModelProviderModels).toHaveBeenCalledWith("openai");
  await waitFor(() =>
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      aiProviderModels: JSON.stringify({ id: "gpt-live-1", name: "GPT Live 1" }),
      aiProviderProfiles: expect.stringContaining("gpt-live-1"),
    })),
  );
  expect(await screen.findByText("Loaded 1 live model.")).toBeInTheDocument();
});

test("SettingsScreen preserves edited provider endpoint and models when switching providers", async () => {
  const user = userEvent.setup();
  let current = settingsFixture({
    aiProviderEnabled: true,
    apiBaseUrl: "https://api.openai.com/v1",
    imageApiBaseUrl: "https://api.openai.com/v1",
    videoApiBaseUrl: "https://api.openai.com/v1",
    aiProviderModels: "gpt-image-1",
  });
  const updateSettings = vi.fn(async (patch: Partial<Settings>) => {
    current = { ...current, ...patch };
    return current;
  });
  const listModelProviderModels = vi.fn(async () => ({
    models: [{ id: "gpt-live-image", name: "GPT Live Image", capabilities: ["Image" as const] }],
  }));
  renderSettings({
    getSettings: async () => current,
    updateSettings,
    listModelProviderModels,
  });

  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  const providerButton = (name: string) => screen.getByLabelText(new RegExp(`^${name} (enabled|disabled)$`)).closest("button")!;
  const baseUrl = await screen.findByLabelText("Base URL");
  await user.clear(baseUrl);
  await user.type(baseUrl, "https://openai.local/v1");
  await user.click(await screen.findByRole("button", { name: "Get model list" }));
  expect(await screen.findByText("GPT Live Image")).toBeInTheDocument();

  await user.click(providerButton("Azure OpenAI"));
  expect(await screen.findByLabelText("Resource endpoint")).toHaveValue("https://{resource}.openai.azure.com");
  await user.click(providerButton("OpenAI"));

  expect(await screen.findByLabelText("Base URL")).toHaveValue("https://openai.local/v1");
  expect(await screen.findByText("GPT Live Image")).toBeInTheDocument();
});

test("SettingsScreen keeps a cleared provider endpoint empty instead of restoring the preset", async () => {
  const user = userEvent.setup();
  const { updateSettings } = renderSettings({
    getSettings: async () =>
      settingsFixture({
        apiBaseUrl: "https://api.openai.com/v1",
        imageApiBaseUrl: "https://api.openai.com/v1",
        videoApiBaseUrl: "https://api.openai.com/v1",
      }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Providers" }));

  const baseUrl = await screen.findByLabelText("Base URL");
  await user.clear(baseUrl);
  fireEvent.blur(baseUrl);

  expect(baseUrl).toHaveValue("");
  await waitFor(() =>
    expect(updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        apiBaseUrl: "",
        imageApiBaseUrl: "",
        videoApiBaseUrl: "",
      }),
    ),
  );
});

test("SettingsScreen theme toggle calls onToggleDark", async () => {
  const { onToggleDark } = renderSettings();
  fireEvent.click(await screen.findByText("Light"));
  expect(onToggleDark).toHaveBeenCalled();
});
