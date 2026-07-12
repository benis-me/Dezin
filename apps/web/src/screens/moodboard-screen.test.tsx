import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ToastProvider } from "../components/Toast.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import { MoodboardCanvasTopbar } from "../moodboard/MoodboardCanvasTopbar.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { MoodboardScreen } from "./MoodboardScreen.tsx";

const mockMoodboardState = vi.hoisted(() => ({
  current: { loading: true, detail: null } as Record<string, unknown>,
}));

vi.mock("../moodboard/useMoodboardBoard.ts", () => ({
  useMoodboardBoard: () => mockMoodboardState.current,
}));

vi.mock("../moodboard/MoodboardCanvas.tsx", () => ({
  MoodboardCanvas: ({ onSendToAgent }: { onSendToAgent?: (nodes: Array<Record<string, unknown>>) => void }) => (
    <button
      type="button"
      onClick={() =>
        onSendToAgent?.([
          {
            id: "note-1",
            boardId: "board-1",
            type: "note",
            x: 10,
            y: 20,
            width: 180,
            height: 80,
            data: { text: "Material tone" },
          },
        ])
      }
    >
      Send mock node to agent
    </button>
  ),
}));

function loadedMoodboardState(): Record<string, unknown> {
  return {
    detail: { id: "board-1", name: "Board", createdAt: 1, updatedAt: 1, archivedAt: null, coverAssetId: null },
    nodes: [],
    assets: [],
    conversations: [],
    conversationId: "",
    messages: [],
    selectedId: null,
    selectedIds: [],
    agents: [],
    runAgent: "",
    runModel: "",
    imageModels: [],
    imageModel: "",
    imageProviderId: "",
    imageActionModels: { removeBackgroundModel: "", editRegionModel: "", extractLayerModel: "" },
    loading: false,
    agentBusy: false,
    imageBusy: false,
    busy: false,
    setSelectedId: vi.fn(),
    setSelectedIds: vi.fn(),
    setRunAgent: vi.fn(),
    setRunModel: vi.fn(),
    setImageModel: vi.fn(),
    switchConversation: vi.fn(),
    createConversation: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
    updateNodes: vi.fn(),
    addNote: vi.fn(),
    addSection: vi.fn(),
    addImageGenerator: vi.fn(),
    uploadFiles: vi.fn(),
    uploadReferenceFiles: vi.fn(),
    generateImage: vi.fn(),
    setCoverImage: vi.fn(),
    flushPendingNodes: vi.fn(),
    sendMessage: vi.fn(),
    rescanAgents: vi.fn(),
  };
}

function installMutableMoodboardViewport(initialMatches = false) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() {
      return matches;
    },
    media: "(max-width: 639px)",
    onchange: null,
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    dispatchEvent: () => true,
  } as MediaQueryList;
  const spy = vi.spyOn(window, "matchMedia").mockReturnValue(media);
  return {
    setMatches(next: boolean) {
      matches = next;
      const event = { matches, media: media.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
    restore: () => spy.mockRestore(),
  };
}

test("MoodboardCanvasTopbar mirrors the project artifact bar shape", () => {
  const onOpenModelSettings = vi.fn();
  const controls = {
    zoom: 1,
    layersOpen: false,
    presentationMode: false,
    onZoomOut: vi.fn(),
    onZoomIn: vi.fn(),
    onFitView: vi.fn(),
    onSetZoom: vi.fn(),
    onToggleLayers: vi.fn(),
    onTogglePresentation: vi.fn(),
  };

  render(<MoodboardCanvasTopbar controls={controls} onOpenModelSettings={onOpenModelSettings} />);

  expect(screen.queryByRole("tab", { name: "Canvas" })).toBeNull();
  expect(screen.queryByText(/items/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  fireEvent.click(screen.getByRole("button", { name: "Layers" }));
  fireEvent.click(screen.getByRole("button", { name: "Presentation mode" }));
  fireEvent.click(screen.getByRole("button", { name: "Open model settings" }));
  expect(controls.onZoomOut).toHaveBeenCalledOnce();
  expect(controls.onToggleLayers).toHaveBeenCalledOnce();
  expect(controls.onTogglePresentation).toHaveBeenCalledOnce();
  expect(onOpenModelSettings).toHaveBeenCalledOnce();
});

test("MoodboardCanvasTopbar uses the project toolbar active style", () => {
  const controls = {
    zoom: 1,
    layersOpen: true,
    presentationMode: false,
    onZoomOut: vi.fn(),
    onZoomIn: vi.fn(),
    onFitView: vi.fn(),
    onSetZoom: vi.fn(),
    onToggleLayers: vi.fn(),
    onTogglePresentation: vi.fn(),
  };

  render(<MoodboardCanvasTopbar controls={controls} />);

  const layers = screen.getByRole("button", { name: "Layers" });
  expect(layers).toHaveClass("!bg-primary");
  expect(layers).toHaveClass("!text-primary-foreground");
  expect(layers).toHaveClass("hover:!bg-primary");
});

test("MoodboardCanvasTopbar separates zoom controls from canvas toggles", () => {
  const controls = {
    zoom: 1,
    layersOpen: false,
    presentationMode: false,
    onZoomOut: vi.fn(),
    onZoomIn: vi.fn(),
    onFitView: vi.fn(),
    onSetZoom: vi.fn(),
    onToggleLayers: vi.fn(),
    onTogglePresentation: vi.fn(),
  };

  const { container } = render(<MoodboardCanvasTopbar controls={controls} />);

  expect(container.querySelectorAll(".h-5.w-px.bg-border").length).toBe(2);
});

test("MoodboardScreen loading state keeps the project-style board shell", () => {
  render(<MoodboardScreen boardId="board-1" onBack={() => {}} onOpenSettings={() => {}} />);

  expect(screen.getByLabelText("Back to moodboards")).toBeInTheDocument();
  expect(screen.getAllByRole("status").some((status) => status.textContent === "Loading moodboard")).toBe(true);
  expect(
    screen
      .getAllByRole("status")
      .some((status) => status.textContent === "Loading moodboard" && status.className.includes("rounded-lg")),
  ).toBe(true);
  expect(screen.getByLabelText("Moodboard canvas")).toBeInTheDocument();
  expect(screen.queryByText("Loading canvas")).toBeNull();
});

test("MoodboardScreen stacks its panels vertically at narrow viewports", async () => {
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches: query === "(max-width: 639px)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as MediaQueryList,
  );
  try {
    render(<MoodboardScreen boardId="board-1" onBack={() => {}} onOpenSettings={() => {}} />);

    await waitFor(() =>
      expect(screen.getByRole("separator", { name: "Resize moodboard agent panel" })).toHaveAttribute("aria-orientation", "horizontal"),
    );
  } finally {
    matchMedia.mockRestore();
  }
});

test("MoodboardScreen preserves loaded composer identity and draft across the narrow breakpoint", async () => {
  const viewport = installMutableMoodboardViewport();
  mockMoodboardState.current = loadedMoodboardState();
  localStorage.setItem("dezin.moodboard.agent.width", "0.37");
  try {
    render(
      <ApiProvider client={makeFakeApi()}>
        <ToastProvider>
          <MoodboardScreen boardId="board-1" onBack={() => {}} onOpenSettings={() => {}} />
        </ToastProvider>
      </ApiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send mock node to agent" }));
    await screen.findByRole("list", { name: "Attached context" });
    const message = screen.getByLabelText("Message");
    fireEvent.change(message, { target: { value: "Unsent moodboard draft" } });
    message.focus();
    message.setSelectionRange(6, 6);

    act(() => viewport.setMatches(true));
    await waitFor(() =>
      expect(screen.getByRole("separator", { name: "Resize moodboard agent panel" })).toHaveAttribute("aria-orientation", "horizontal"),
    );
    expect(screen.getByLabelText("Message")).toBe(message);
    expect(message).toHaveValue("Unsent moodboard draft");
    expect(message).toHaveFocus();
    expect(message.selectionStart).toBe(6);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(localStorage.getItem("dezin.moodboard.agent.width")).toBe("0.37");

    act(() => viewport.setMatches(false));
    await waitFor(() =>
      expect(screen.getByRole("separator", { name: "Resize moodboard agent panel" })).toHaveAttribute("aria-orientation", "vertical"),
    );
    expect(screen.getByLabelText("Message")).toBe(message);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(localStorage.getItem("dezin.moodboard.agent.width")).toBe("0.37");
  } finally {
    mockMoodboardState.current = { loading: true, detail: null };
    localStorage.removeItem("dezin.moodboard.agent.width");
    viewport.restore();
  }
});
