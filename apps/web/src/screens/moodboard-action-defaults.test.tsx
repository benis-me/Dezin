import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ToastProvider } from "../components/Toast.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { MoodboardScreen } from "./MoodboardScreen.tsx";

const mockState = vi.hoisted(() => ({
  configureAction: null as null | ((action: string) => void),
}));

vi.mock("../moodboard/MoodboardCanvas.tsx", () => ({
  MoodboardCanvas: (props: { onConfigureImageActionModel?: (action: string) => void }) => {
    mockState.configureAction = props.onConfigureImageActionModel ?? null;
    return (
      <button type="button" onClick={() => mockState.configureAction?.("Remove background")}>
        Remove background
      </button>
    );
  },
}));

vi.mock("../moodboard/useMoodboardBoard.ts", () => ({
  useMoodboardBoard: () => ({
    detail: { id: "b1", name: "Board", createdAt: 1, updatedAt: 1, archivedAt: null, coverAssetId: null },
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
    imageModels: ["gpt-image-1"],
    imageModel: "gpt-image-1",
    imageProviderId: "openai",
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
    sendMessage: vi.fn(),
    rescanAgents: vi.fn(),
  }),
}));

test("MoodboardScreen opens Defaults focused to the missing Remove background model", async () => {
  const onOpenSettings = vi.fn();

  render(
    <ApiProvider client={makeFakeApi()}>
      <ToastProvider>
        <MoodboardScreen boardId="b1" onBack={() => {}} onOpenSettings={onOpenSettings} />
      </ToastProvider>
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Remove background" }));

  expect(onOpenSettings).toHaveBeenCalledWith("defaults:removeBackgroundModel");
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Choose a Remove background model in Defaults first."));
});
