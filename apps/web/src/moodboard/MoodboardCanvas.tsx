import { ImagePlus, Plus } from "lucide-react";
import { Button } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { CanvasActionBar, CanvasZoomBar, GeneratorPromptToolbar, SelectionToolbar } from "./MoodboardCanvasToolbars.tsx";
import { MoodboardContextMenu } from "./MoodboardContextMenu.tsx";
import { MoodboardLayerPanel } from "./MoodboardLayerPanel.tsx";
import { MoodboardPropertiesPanel } from "./MoodboardPropertiesPanel.tsx";
import { generatorPrompt } from "./canvas-utils.ts";
import { useMoodboardCanvasController, type MoodboardCanvasProps } from "./useMoodboardCanvasController.ts";

export function MoodboardCanvas(props: MoodboardCanvasProps) {
  const { nodes, busy = false, onAddNote, onAddSection, onAddImageGenerator, onGenerateImage } = props;
  const canvas = useMoodboardCanvasController(props);
  const selectedGeneratorPrompt = canvas.selected ? generatorPrompt(canvas.selected) : "";

  return (
    <div className="relative min-h-0 flex-1 bg-surface">
      <input ref={canvas.inputRef} type="file" accept="image/*" multiple className="hidden" onChange={canvas.upload} />
      <div className="relative h-full min-w-0 overflow-hidden">
        {canvas.layersOpen ? (
          <MoodboardLayerPanel
            items={canvas.layerTree}
            selectedId={props.selectedId}
            collapsedIds={canvas.collapsedLayerIds}
            onToggleCollapsed={canvas.toggleLayerCollapsed}
            onSelect={canvas.selectLayer}
            onHover={canvas.hoverLayer}
            onRename={canvas.renameNode}
            onToggleVisible={canvas.toggleNodeVisible}
            onToggleLocked={canvas.toggleNodeLocked}
          />
        ) : null}

        <div
          ref={canvas.containerRef}
          data-testid="moodboard-leafer-canvas"
          className={cn(
            "h-full w-full overflow-hidden",
            canvas.tool === "hand" && "cursor-grab active:cursor-grabbing",
            (canvas.tool === "note" || canvas.tool === "section") && "cursor-crosshair",
          )}
        />

        {!canvas.runtimeReady ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-muted-foreground">Loading canvas...</div>
        ) : null}

        {nodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="pointer-events-auto flex flex-col items-center gap-3 text-center">
              <span className="grid size-14 place-items-center rounded-2xl border border-border bg-card text-muted-foreground">
                <ImagePlus size={24} strokeWidth={1.5} />
              </span>
              <div>
                <p className="text-sm font-medium text-foreground">Start collecting direction</p>
                <p className="mt-1 text-xs text-muted-foreground">Upload images, add notes, or double-click the canvas to add a generator.</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => canvas.inputRef.current?.click()}>
                <Plus size={14} strokeWidth={1.75} />
                Add images
              </Button>
            </div>
          </div>
        ) : null}

        {canvas.selected && canvas.selectionRect ? (
          <div
            className="pointer-events-none absolute z-30"
            style={{ left: canvas.selectionRect.left, top: canvas.selectionRect.top, transform: "translateX(-50%)" }}
          >
            <SelectionToolbar
              node={canvas.selected}
              onDuplicate={() => canvas.duplicateNode(canvas.selected!.id)}
              onBringToFront={() => canvas.bringToFront(canvas.selected!.id)}
              onSendToBack={() => canvas.sendToBack(canvas.selected!.id)}
              onToggleVisible={() => canvas.toggleNodeVisible(canvas.selected!.id)}
              onToggleLocked={() => canvas.toggleNodeLocked(canvas.selected!.id)}
              onDelete={() => canvas.deleteNode(canvas.selected!.id)}
            />
          </div>
        ) : null}

        {canvas.selected?.type === "image-generator" && canvas.selectionRect ? (
          <div
            className="pointer-events-none absolute z-30"
            style={{ left: canvas.selectionRect.left, top: canvas.selectionRect.bottom, transform: "translateX(-50%)" }}
          >
            <GeneratorPromptToolbar
              node={canvas.selected}
              busy={busy}
              onPromptChange={(prompt) => canvas.patchNodeData(canvas.selected!.id, { generatorPrompt: prompt, generatorStatus: prompt ? "ready" : "" })}
              onGenerate={(prompt) => onGenerateImage(canvas.selected!, prompt)}
            />
          </div>
        ) : null}

        <CanvasActionBar
          tool={canvas.tool}
          layersOpen={canvas.layersOpen}
          onToolChange={canvas.setTool}
          onUpload={() => canvas.inputRef.current?.click()}
          onAddImageGenerator={() => onAddImageGenerator()}
          onToggleLayers={() => canvas.setLayersOpen((value) => !value)}
        />
        <CanvasZoomBar zoom={canvas.zoom} onChangeZoom={canvas.changeZoom} onFitView={canvas.fitView} />

        {canvas.contextMenu ? (
          <MoodboardContextMenu
            menu={canvas.contextMenu}
            targetId={canvas.contextTargetId}
            onClose={() => canvas.setContextMenu(null)}
            onAddNote={() => {
              onAddNote({ x: canvas.contextMenu!.canvasX, y: canvas.contextMenu!.canvasY });
              canvas.setContextMenu(null);
            }}
            onAddSection={() => {
              onAddSection({ x: canvas.contextMenu!.canvasX, y: canvas.contextMenu!.canvasY });
              canvas.setContextMenu(null);
            }}
            onGenerate={() => {
              onAddImageGenerator({ x: canvas.contextMenu!.canvasX, y: canvas.contextMenu!.canvasY });
              canvas.setContextMenu(null);
            }}
            onDuplicate={canvas.contextTargetId ? () => canvas.duplicateNode(canvas.contextTargetId!) : undefined}
            onBringToFront={canvas.contextTargetId ? () => canvas.bringToFront(canvas.contextTargetId!) : undefined}
            onSendToBack={canvas.contextTargetId ? () => canvas.sendToBack(canvas.contextTargetId!) : undefined}
            onToggleVisible={canvas.contextTargetId ? () => canvas.toggleNodeVisible(canvas.contextTargetId!) : undefined}
            onToggleLocked={canvas.contextTargetId ? () => canvas.toggleNodeLocked(canvas.contextTargetId!) : undefined}
            onDelete={canvas.contextTargetId ? () => canvas.deleteNode(canvas.contextTargetId!) : undefined}
            onZoomIn={() => {
              canvas.changeZoom(canvas.zoom * 1.14);
              canvas.setContextMenu(null);
            }}
            onZoomOut={() => {
              canvas.changeZoom(canvas.zoom * 0.88);
              canvas.setContextMenu(null);
            }}
            onFitView={() => {
              canvas.fitView();
              canvas.setContextMenu(null);
            }}
            onResetZoom={() => {
              canvas.changeZoom(1);
              canvas.setContextMenu(null);
            }}
            targetNode={canvas.contextTargetId ? nodes.find((node) => node.id === canvas.contextTargetId) ?? null : null}
          />
        ) : null}

        {canvas.selected ? (
          <MoodboardPropertiesPanel
            node={canvas.selected}
            onPatch={(patch) => canvas.selected && canvas.patchNode(canvas.selected.id, patch)}
            onPatchData={canvas.patchSelectedData}
            onGenerate={() => canvas.selected?.type === "image-generator" && onGenerateImage(canvas.selected, selectedGeneratorPrompt)}
          />
        ) : null}
      </div>
    </div>
  );
}
