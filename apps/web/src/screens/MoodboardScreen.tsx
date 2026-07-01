import { Loader2, Settings } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Button, IconButton } from "../components/ui/index.ts";
import { panelPercentFromPixels, readStoredPanelPercent, RESIZE_SEPARATOR_CLASS, savePanelFraction, twoPanelLayout } from "../lib/panel-layout.ts";
import { MoodboardAgentPanel } from "../moodboard/MoodboardAgentPanel.tsx";
import { MoodboardCanvas } from "../moodboard/MoodboardCanvas.tsx";
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
  const board = useMoodboardBoard(boardId);

  if (board.loading) {
    return (
      <div className="flex h-full w-full flex-col bg-background">
        <Group
          id="dezin-moodboard-layout-loading"
          className="min-h-0 flex-1"
          defaultLayout={twoPanelLayout(MOODBOARD_AGENT_PANEL, agentPercent, MOODBOARD_CANVAS_PANEL)}
          onLayoutChanged={(layout) => savePanelFraction(MOODBOARD_AGENT_WIDTH_KEY, layout, MOODBOARD_AGENT_PANEL)}
          resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
        >
          <Panel id={MOODBOARD_AGENT_PANEL} minSize="280px" maxSize="520px" defaultSize={agentPercent} groupResizeBehavior="preserve-pixel-size">
            <aside className="relative flex h-full min-w-0 flex-col bg-background">
              <div className="app-drag titlebar-pad-left flex h-10 shrink-0 items-center border-b border-border px-2.5">
                <div className="h-4 w-36 rounded bg-surface-2" />
              </div>
              <div className="min-h-0 flex-1 space-y-3 px-4 pt-5">
                <div className="h-16 w-4/5 rounded-2xl rounded-bl-md bg-surface-2" />
                <div className="ml-auto h-10 w-2/3 rounded-2xl rounded-br-md bg-surface-2" />
                <div className="h-24 w-[88%] rounded-xl bg-surface-2" />
              </div>
              <div className="pointer-events-none absolute inset-x-0 bottom-0">
                <div aria-hidden className="h-12 bg-gradient-to-t from-background via-background/90 to-transparent" />
                <div className="bg-background px-3 pb-3">
                  <div className="rounded-2xl border border-input bg-card px-2.5 pb-2 pt-2.5">
                    <div className="h-10 rounded-md bg-surface-2" />
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <div className="h-8 w-28 rounded-md bg-surface-2" />
                      <div className="h-8 w-8 rounded-lg bg-surface-2" />
                    </div>
                  </div>
                </div>
              </div>
            </aside>
          </Panel>
          <Separator aria-label="Resize moodboard agent panel" className={RESIZE_SEPARATOR_CLASS} />
          <Panel id={MOODBOARD_CANVAS_PANEL} minSize="480px">
            <section aria-label="Moodboard canvas" className="flex h-full min-w-0 flex-col">
              <div className="app-drag flex h-10 shrink-0 items-center justify-end gap-2 border-b border-border px-1">
                <div className="h-8 w-8 rounded-lg bg-surface-2" />
              </div>
              <div className="relative min-h-0 flex-1 overflow-hidden bg-surface">
                <div className="absolute left-3 top-3 h-80 w-60 rounded-md border border-border bg-card/90" />
                <div className="absolute bottom-3 left-1/2 h-10 w-72 -translate-x-1/2 rounded-lg border border-border bg-card/90" />
                <div className="absolute bottom-3 right-3 h-10 w-36 rounded-lg border border-border bg-card/90" />
                <div className="grid h-full place-items-center">
                  <div className="flex items-center gap-2 rounded-md border border-border bg-card/90 px-2.5 py-1.5 text-xs text-muted-foreground">
                    <Loader2 size={13} className="animate-spin" />
                    Loading moodboard
                  </div>
                </div>
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
            busy={board.busy}
            agents={board.agents}
            agent={board.runAgent}
            model={board.runModel}
            onBack={onBack}
            onAgentChange={(value) => {
              board.setRunAgent(value);
              board.setRunModel("");
            }}
            onModelChange={board.setRunModel}
            onRescanAgents={board.rescanAgents}
            onUploadFiles={(files) => void board.uploadFiles(files)}
            onSend={board.sendMessage}
          />
        </Panel>
        <Separator aria-label="Resize moodboard agent panel" className={RESIZE_SEPARATOR_CLASS} />
        <Panel id={MOODBOARD_CANVAS_PANEL} minSize="480px">
          <section aria-label="Moodboard canvas" className="flex h-full min-w-0 flex-col">
            <div className="app-drag flex h-10 shrink-0 items-center justify-end gap-2 border-b border-border px-1">
              <div className="app-no-drag flex items-center gap-1">
                <IconButton aria-label="Open model settings" onClick={() => onOpenSettings("models")}>
                  <Settings size={15} strokeWidth={1.75} />
                </IconButton>
              </div>
            </div>
            <MoodboardCanvas
              nodes={board.nodes}
              selectedIds={board.selectedIds}
              imageModels={board.imageModels}
              imageModel={board.imageModel}
              onImageModelChange={board.setImageModel}
              onSelectIds={board.setSelectedIds}
              onNodesChange={board.updateNodes}
              onAddNote={board.addNote}
              onAddSection={board.addSection}
              onAddImageGenerator={board.addImageGenerator}
              onUploadFiles={(files) => void board.uploadFiles(files)}
              onGenerateImage={board.generateImage}
            />
          </section>
        </Panel>
      </Group>
    </div>
  );
}
