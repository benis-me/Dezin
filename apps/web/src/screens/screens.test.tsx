import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, afterEach, vi } from "vitest";
import { HomeScreen } from "./HomeScreen.tsx";
import { DesignSystemsScreen } from "./DesignSystemsScreen.tsx";
import { DesignSystemDetailScreen } from "./DesignSystemDetailScreen.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { Shell } from "../components/Shell.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import { AgentsProvider } from "../lib/agents-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";

afterEach(() => {
  localStorage.removeItem("dezin.shell.sidebar.width");
  cleanup();
});

const SKILLS = [
  { id: "frontend-design", name: "Frontend design", description: "d", mode: "prototype", triggers: [], designSystem: true },
  { id: "dashboard", name: "Dashboard", description: "d", mode: "prototype", triggers: [], designSystem: true },
];

function renderWithApi(ui: React.ReactElement, over = {}) {
  return render(<ApiProvider client={makeFakeApi(over)}>{ui}</ApiProvider>);
}

test("HomeScreen shows an empty state with no projects", () => {
  renderWithApi(<HomeScreen projects={[]} />, { listSkills: async () => SKILLS });
  expect(screen.getByText(/No projects yet/i)).toBeInTheDocument();
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
  expect(build).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Describe your design"), { target: { value: "a dashboard" } });
  expect(build).not.toBeDisabled();
  fireEvent.click(build);
  expect(onNewProject).toHaveBeenCalledWith("a dashboard", "deck", "editorial", "prototype");
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
    visualQaEnabled: false,
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
  const updateSettings = vi.fn(async (p: object) => ({
    agentCommand: "claude",
    model: "",
    apiBaseUrl: "",
    apiKey: "",
    defaultDesignSystemId: "modern-minimal",
    customInstructions: "",
    imageApiBaseUrl: "",
    imageApiKey: "",
    imageModel: "",
    visualQaEnabled: false,
    ...p,
  }));
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

test("SettingsScreen sidebar lists sections; Provider + Defaults show daemon data", async () => {
  renderSettings();
  for (const name of ["Appearance", "Provider", "Connection", "Quality", "Defaults", "Custom instructions", "About"]) {
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
  }
  fireEvent.click(screen.getByRole("button", { name: "Provider" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Provider" }));
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
});

test("SettingsScreen theme toggle calls onToggleDark", async () => {
  const { onToggleDark } = renderSettings();
  fireEvent.click(await screen.findByText("Light"));
  expect(onToggleDark).toHaveBeenCalled();
});
