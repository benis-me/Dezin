import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, afterEach, vi } from "vitest";
import { HomeScreen } from "./HomeScreen.tsx";
import { MoodboardsScreen } from "./MoodboardsScreen.tsx";
import { DesignSystemsScreen } from "./DesignSystemsScreen.tsx";
import { DesignSystemDetailScreen } from "./DesignSystemDetailScreen.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { Shell } from "../components/Shell.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import { AgentsProvider } from "../lib/agents-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import type { Settings } from "../lib/api.ts";
import { SETTINGS_UPDATED_EVENT } from "../lib/settings-events.ts";

afterEach(() => {
  localStorage.removeItem("dezin.shell.sidebar.width");
  localStorage.removeItem("dezin.home.composer");
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
    videoApiBaseUrl: "",
    videoApiKey: "",
    videoModel: "",
    aiProviderId: "openai",
    aiProviderEnabled: false,
    aiProviderModels: "gpt-image-1",
    aiProviderOrganization: "",
    aiProviderProfiles: "",
    visualQaEnabled: false,
    visualQaAgentCommand: "",
    visualQaModel: "",
    autoImproveEnabled: true,
    autoImproveMaxRounds: 8,
    ...patch,
  };
}

test("HomeScreen shows an empty state with no projects", () => {
  renderWithApi(<HomeScreen projects={[]} />, { listSkills: async () => SKILLS });
  expect(screen.getByText(/No projects yet/i)).toBeInTheDocument();
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
  const moodboard = screen.getByRole("button", { name: "Moodboard" });
  expect(design.compareDocumentPosition(designSystems) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(designSystems.compareDocumentPosition(moodboard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Browser extension" })).toBeNull();
});

test("HomeScreen lists projects and opens them", () => {
  const onOpenProject = vi.fn();
  renderWithApi(<HomeScreen projects={[project("p1", "Pricing page")]} onOpenProject={onOpenProject} />, {
    listSkills: async () => SKILLS,
  });
  fireEvent.click(screen.getByText("Pricing page"));
  expect(onOpenProject).toHaveBeenCalledWith("p1");
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

  const build = screen.getByLabelText("Build");
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
  expect(loadingGradient).toHaveClass("motion-safe:animate-prompt-loading-gradient");

  await act(async () => {
    resolveFirst({ prompt: "Create a finished shader microsite with sourced assets." });
    await firstOptimization;
  });

  expect(textarea).toHaveValue("Create a finished shader microsite with sourced assets.");
  fireEvent.click(screen.getByLabelText("Build"));
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

test("HomeScreen prompt accepts dropped image references", async () => {
  renderWithApi(<HomeScreen projects={[]} />, {
    listSkills: async () => SKILLS,
    listDesignSystems: async () => DSYS,
  });

  const file = new File(["image"], "reference.png", { type: "image/png" });
  fireEvent.drop(screen.getByLabelText("Design prompt dropzone"), { dataTransfer: { files: [file] } });

  expect(await screen.findByAltText("reference.png")).toBeInTheDocument();
});

test("MoodboardsScreen uses a Home-like prompt to start a board with initial direction", async () => {
  const onOpenBoard = vi.fn();
  const board = moodboard("b1", "Warm editorial references");
  const createMoodboard = vi.fn(async () => board);
  const postMoodboardMessage = vi.fn(async () => ({ messages: [] }));
  renderWithApiAndAgents(<MoodboardsScreen onOpenBoard={onOpenBoard} />, {
    listMoodboards: async () => [],
    listAgents: async () => [{ id: "claude", command: "claude", available: true, models: ["sonnet"] }],
    createMoodboard,
    postMoodboardMessage,
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

  await waitFor(() => expect(createMoodboard).toHaveBeenCalledWith({ name: "Warm editorial references" }));
  expect(postMoodboardMessage).toHaveBeenCalledWith(
    "b1",
    "Warm editorial references for a boutique hotel",
    expect.objectContaining({ agentCommand: "claude" }),
  );
  expect(onOpenBoard).toHaveBeenCalledWith("b1");
  expect(screen.getByRole("button", { name: "New board" })).toBeInTheDocument();
});

test("MoodboardsScreen homepage prompt textarea auto-sizes with a capped height", async () => {
  renderWithApiAndAgents(<MoodboardsScreen onOpenBoard={vi.fn()} />, {
    listMoodboards: async () => [],
    listAgents: async () => [{ id: "claude", command: "claude", available: true, models: ["sonnet"] }],
  });

  const prompt = await screen.findByLabelText("Describe moodboard direction");
  expect(prompt).toHaveClass("field-sizing-content", "max-h-64", "min-h-[92px]");
});

test("MoodboardsScreen generate mode starts a board with an image model instead of an agent message", async () => {
  const onOpenBoard = vi.fn();
  const board = moodboard("b1", "Brutalist campaign board");
  const createMoodboard = vi.fn(async () => board);
  const postMoodboardMessage = vi.fn(async () => ({ messages: [] }));
  const generateMoodboardImage = vi.fn(async () => ({
    asset: {
      id: "asset-1",
      boardId: "b1",
      kind: "image" as const,
      fileName: "generated.png",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      source: "generated" as const,
      createdAt: 1,
      url: "/api/moodboards/b1/assets/asset-1",
    },
    nodes: [],
    messages: [],
  }));
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
      videoApiBaseUrl: "",
      videoApiKey: "",
      videoModel: "",
      aiProviderId: "openai",
      aiProviderEnabled: true,
      aiProviderModels: "gpt-image-1",
      aiProviderOrganization: "",
      aiProviderProfiles: "",
      visualQaEnabled: false,
      visualQaAgentCommand: "",
      visualQaModel: "",
      autoImproveEnabled: true,
      autoImproveMaxRounds: 8,
    }),
    createMoodboard,
    postMoodboardMessage,
    generateMoodboardImage,
  });

  await userEvent.click(await screen.findByRole("button", { name: "Model" }));
  expect(screen.queryByRole("button", { name: "Agent and model" })).toBeNull();
  expect(screen.getByRole("button", { name: "Image generation model" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Describe moodboard direction"), { target: { value: "Brutalist campaign board with product images" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate board" }));

  await waitFor(() =>
    expect(generateMoodboardImage).toHaveBeenCalledWith(
      "b1",
      "Brutalist campaign board with product images",
      expect.objectContaining({ model: "gpt-image-1" }),
    ),
  );
  expect(postMoodboardMessage).not.toHaveBeenCalled();
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
  const createMoodboard = vi.fn(async () => board);
  const uploadMoodboardAsset = vi.fn(async () => ({
    id: "asset-1",
    boardId: "b1",
    fileName: "material.png",
    mimeType: "image/png",
    width: undefined,
    height: undefined,
    createdAt: 1,
    url: "/api/moodboards/b1/assets/asset-1",
  }));
  const saveMoodboardNodes = vi.fn(async () => []);
  renderWithApi(<MoodboardsScreen onOpenBoard={onOpenBoard} />, {
    listMoodboards: async () => [],
    createMoodboard,
    uploadMoodboardAsset,
    saveMoodboardNodes,
  });

  const file = new File(["image"], "material.png", { type: "image/png" });
  fireEvent.drop(await screen.findByLabelText("Moodboard prompt dropzone"), { dataTransfer: { files: [file] } });
  expect(await screen.findByAltText("material.png")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Start board" }));

  await waitFor(() => expect(uploadMoodboardAsset).toHaveBeenCalledWith("b1", expect.objectContaining({ name: "material.png", mimeType: "image/png" })));
  await waitFor(() =>
    expect(saveMoodboardNodes).toHaveBeenCalledWith(
      "b1",
      expect.arrayContaining([expect.objectContaining({ type: "image", data: expect.objectContaining({ assetId: "asset-1", source: "upload" }) })]),
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
    videoApiBaseUrl: "",
    videoApiKey: "",
    videoModel: "",
    aiProviderId: "openai",
    aiProviderEnabled: false,
    aiProviderModels: "gpt-image-1",
    aiProviderOrganization: "",
    aiProviderProfiles: "",
    visualQaEnabled: false,
    visualQaAgentCommand: "",
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
