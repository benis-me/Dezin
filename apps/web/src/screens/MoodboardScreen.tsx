import { useCallback, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Button, Spinner } from "../components/ui/index.ts";
import { useToast } from "../components/Toast.tsx";
import type { AgentComposerContextItem } from "../components/AgentComposerContext.tsx";
import type { MoodboardNode } from "../lib/api.ts";
import { imageActionDefaultForField, imageActionModelField, imageActionSettingsTarget } from "../lib/image-action-defaults.ts";
import { panelPercentFromPixels, readStoredPanelPercent, RESIZE_SEPARATOR_CLASS, savePanelFraction, twoPanelLayout } from "../lib/panel-layout.ts";
import { MoodboardAgentPanel, type MoodboardComposerInsertion } from "../moodboard/MoodboardAgentPanel.tsx";
import { MoodboardCanvas } from "../moodboard/MoodboardCanvas.tsx";
import { MoodboardCanvasTopbar, type MoodboardCanvasTopbarControls } from "../moodboard/MoodboardCanvasTopbar.tsx";
import { layerLabel } from "../moodboard/canvas-utils.ts";
import { useMoodboardBoard } from "../moodboard/useMoodboardBoard.ts";

const MOODBOARD_AGENT_PANEL = "agent";
const MOODBOARD_CANVAS_PANEL = "canvas";
const MOODBOARD_AGENT_WIDTH_KEY = "dezin.moodboard.agent.width";

export function MoodboardScreen({
  boardId,
  onBack,
  onOpenSettings,
}: {
  boardId: string;
  onBack: () => void;
  onOpenSettings: (section?: string) => void;
}) {
  const agentPercent =
    readStoredPanelPercent(MOODBOARD_AGENT_WIDTH_KEY, 20, 44) ??
    panelPercentFromPixels(400, typeof window === "undefined" ? 0 : window.innerWidth, 28, 20, 44);
  const { toast } = useToast();
  const board = useMoodboardBoard(boardId);
  const [canvasTopbarControls, setCanvasTopbarControls] = useState<MoodboardCanvasTopbarControls | null>(null);
  const composerInsertionSeq = useRef(0);
  const [composerInsertion, setComposerInsertion] = useState<MoodboardComposerInsertion | null>(null);
  const sendNodesToAgent = useCallback((nodes: MoodboardNode[]) => {
    if (nodes.length === 0) return;
    composerInsertionSeq.current += 1;
    setComposerInsertion({
      id: composerInsertionSeq.current,
      items: nodes.map(formatMoodboardNodeAgentCard),
    });
  }, []);
  const configureImageActionModel = useCallback(
    (action: string) => {
      const field = imageActionModelField(action);
      if (!field) {
        onOpenSettings("defaults");
        return;
      }
      const item = imageActionDefaultForField(field);
      onOpenSettings(imageActionSettingsTarget(field));
      toast(`Choose a ${item.action} model in Defaults first.`);
    },
    [onOpenSettings, toast],
  );

  if (board.loading) {
    return (
      <div className="flex h-full w-full min-w-0 bg-background">
        <Group
          id="dezin-moodboard-layout-loading"
          className="min-h-0 flex-1"
          defaultLayout={twoPanelLayout(MOODBOARD_AGENT_PANEL, agentPercent, MOODBOARD_CANVAS_PANEL)}
          onLayoutChanged={(layout) => savePanelFraction(MOODBOARD_AGENT_WIDTH_KEY, layout, MOODBOARD_AGENT_PANEL)}
          resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
        >
          <Panel id={MOODBOARD_AGENT_PANEL} minSize="280px" maxSize="520px" defaultSize={agentPercent} groupResizeBehavior="preserve-pixel-size">
            <MoodboardAgentPanel
              loading
              boardName="Moodboard"
              messages={[]}
              busy
              agents={[]}
              agent=""
              model=""
              onBack={onBack}
              onAgentChange={() => {}}
              onModelChange={() => {}}
              onRescanAgents={async () => {}}
              onSend={async () => {}}
            />
          </Panel>
          <Separator aria-label="Resize moodboard agent panel" className={RESIZE_SEPARATOR_CLASS} />
          <Panel id={MOODBOARD_CANVAS_PANEL} minSize="480px">
            <section aria-label="Moodboard canvas" className="flex h-full min-w-0 flex-col">
              <MoodboardCanvasTopbar loading />
              <div className="relative min-h-0 flex-1 overflow-hidden bg-surface">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(0,0,0,0.025)_1px,transparent_1px)] bg-[length:24px_24px] opacity-70" />
                <LoadingCanvasChrome />
              </div>
            </section>
          </Panel>
        </Group>
      </div>
    );
  }
  if (!board.detail) {
    return (
      <div className="grid h-full place-items-center">
        <div className="text-center">
          <p className="text-sm font-medium">Moodboard not found</p>
          <Button className="mt-3" variant="outline" onClick={onBack}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <Group
        id="dezin-moodboard-layout"
        className="min-h-0 flex-1"
        defaultLayout={twoPanelLayout(MOODBOARD_AGENT_PANEL, agentPercent, MOODBOARD_CANVAS_PANEL)}
        onLayoutChanged={(layout) => savePanelFraction(MOODBOARD_AGENT_WIDTH_KEY, layout, MOODBOARD_AGENT_PANEL)}
        resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
      >
        <Panel id={MOODBOARD_AGENT_PANEL} minSize="280px" maxSize="520px" defaultSize={agentPercent} groupResizeBehavior="preserve-pixel-size">
          <MoodboardAgentPanel
            boardName={board.detail.name}
            messages={board.messages}
            conversations={board.conversations}
            activeConversationId={board.conversationId}
            busy={board.agentBusy}
            agents={board.agents}
            agent={board.runAgent}
            model={board.runModel}
            onBack={onBack}
            onConversationChange={(value) => void board.switchConversation(value)}
            onCreateConversation={() => void board.createConversation()}
            onRenameConversation={(id, title) => void board.renameConversation(id, title)}
            onDeleteConversation={(id) => void board.deleteConversation(id)}
            onAgentChange={(value) => {
              board.setRunAgent(value);
              board.setRunModel("");
            }}
            onModelChange={board.setRunModel}
            onRescanAgents={board.rescanAgents}
            onUploadFiles={(files) => void board.uploadFiles(files)}
            onSend={board.sendMessage}
            composerInsertion={composerInsertion}
          />
        </Panel>
        <Separator aria-label="Resize moodboard agent panel" className={RESIZE_SEPARATOR_CLASS} />
        <Panel id={MOODBOARD_CANVAS_PANEL} minSize="480px">
          <section aria-label="Moodboard canvas" className="flex h-full min-w-0 flex-col">
            <MoodboardCanvasTopbar
              controls={canvasTopbarControls}
              onOpenModelSettings={() => onOpenSettings("models")}
            />
            <MoodboardCanvas
              viewKey={boardId}
              nodes={board.nodes}
              busy={board.imageBusy}
              selectedIds={board.selectedIds}
              moodboardAssets={board.assets}
              imageModels={board.imageModels}
              imageModel={board.imageModel}
              imageProviderId={board.imageProviderId}
              imageActionModels={board.imageActionModels}
              onImageModelChange={board.setImageModel}
              onConfigureImageActionModel={configureImageActionModel}
              onSelectIds={board.setSelectedIds}
              onNodesChange={board.updateNodes}
              onAddNote={board.addNote}
              onAddSection={board.addSection}
              onAddImageGenerator={board.addImageGenerator}
              onUploadFiles={(files, point) => void board.uploadFiles(files, point)}
              onUploadReferenceFiles={board.uploadReferenceFiles}
              onGenerateImage={board.generateImage}
              onSendToAgent={sendNodesToAgent}
              onTopbarControlsChange={setCanvasTopbarControls}
            />
          </section>
        </Panel>
      </Group>
    </div>
  );
}

export function formatMoodboardNodeAgentContext(nodes: MoodboardNode[]): string {
  const title = nodes.length === 1 ? "Selected moodboard node:" : `Selected moodboard nodes (${nodes.length}):`;
  const lines = nodes.map((node, index) => {
    const label = layerLabel(node).replace(/\s+/g, " ").trim() || node.type;
    const type = node.type.replace(/-/g, " ");
    return `${index + 1}. ${label} [${type}, id:${node.id}] at x:${Math.round(node.x)}, y:${Math.round(node.y)}, ${Math.round(node.width)}x${Math.round(node.height)}`;
  });
  return [title, ...lines].join("\n");
}

function formatMoodboardNodeAgentCard(node: MoodboardNode): AgentComposerContextItem {
  const label = layerLabel(node).replace(/\s+/g, " ").trim() || node.type;
  const type = node.type.replace(/-/g, " ");
  return {
    id: `canvas-node:${node.id}`,
    type: "canvas-node",
    title: label,
    subtitle: type,
    nodeId: node.id,
    nodeType: node.type,
    body: `${label} [${type}, id:${node.id}] at x:${Math.round(node.x)}, y:${Math.round(node.y)}, ${Math.round(node.width)}x${Math.round(node.height)}`,
  };
}

function LoadingCanvasChrome() {
  return (
    <>
      <div aria-hidden className="absolute left-[12%] top-[14%] h-36 w-56 rounded-lg border border-border bg-card/70 backdrop-blur-xl" />
      <div aria-hidden className="absolute left-[38%] top-[20%] h-44 w-72 rounded-lg border border-border bg-card/60 backdrop-blur-xl" />
      <div aria-hidden className="absolute right-[14%] top-[16%] h-32 w-48 rounded-lg border border-border bg-card/70 backdrop-blur-xl" />
      <div aria-hidden className="absolute left-[30%] top-[52%] h-24 w-64 rounded-lg border border-border bg-card/60 backdrop-blur-xl" />
      <div
        aria-hidden
        className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border bg-card/85 p-1 backdrop-blur-xl"
      >
        <div className="h-8 w-8 rounded-md bg-surface-2/80" />
        <div className="h-8 w-8 rounded-md bg-surface-2/80" />
        <div className="mx-1 h-5 w-px bg-border" />
        <div className="h-8 w-8 rounded-md bg-surface-2/80" />
        <div className="h-8 w-8 rounded-md bg-surface-2/80" />
        <div className="mx-1 h-5 w-px bg-border" />
        <div className="h-8 w-8 rounded-md bg-surface-2/80" />
      </div>
      <div className="absolute inset-0 z-20 grid place-items-center">
        <div role="status" className="flex items-center gap-2 rounded-lg border border-border bg-card/90 px-3 py-2 text-sm text-muted-foreground backdrop-blur-xl">
          <Spinner size={14} />
          Loading moodboard
        </div>
      </div>
    </>
  );
}
