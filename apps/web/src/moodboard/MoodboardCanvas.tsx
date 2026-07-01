import { ImagePlus, Loader2, Plus } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Frame as LeaferFrame, Leafer } from "@dezin/leafer-react";
import type { Frame } from "leafer-editor";
import { Button } from "../components/ui/index.ts";
import type { MoodboardNode } from "../lib/api.ts";
import { cn } from "../lib/utils.ts";
import { MoodboardCanvasNode } from "./MoodboardCanvasNode.tsx";
import { CanvasActionBar, CanvasZoomBar, GeneratorPromptToolbar, MultiSelectionToolbar, SelectionToolbar } from "./MoodboardCanvasToolbars.tsx";
import { MoodboardContextMenu } from "./MoodboardContextMenu.tsx";
import { MoodboardLayerPanel } from "./MoodboardLayerPanel.tsx";
import { MoodboardPropertiesPanel } from "./MoodboardPropertiesPanel.tsx";
import { generatorModel, generatorPrompt, rectFromBounds, resolveFloatingChromeRect, type CanvasRect, type FloatingRect } from "./canvas-utils.ts";
import { useMoodboardCanvasController, type MoodboardCanvasProps } from "./useMoodboardCanvasController.ts";

export function MoodboardCanvas(props: MoodboardCanvasProps) {
  const {
    nodes,
    busy = false,
    imageModels = [],
    imageModel = "",
    onImageModelChange = () => {},
    onAddNote,
    onAddSection,
    onAddImageGenerator,
    onGenerateImage,
  } = props;
  const canvas = useMoodboardCanvasController(props);
  const selectedGeneratorPrompt = canvas.selected ? generatorPrompt(canvas.selected) : "";
  const selectedGeneratorModel = canvas.selected ? generatorModel(canvas.selected) : "";
  const cursor = canvas.tool === "hand" ? "grab" : canvas.tool === "note" || canvas.tool === "section" ? "crosshair" : "default";

  return (
    <div className="relative min-h-0 flex-1 bg-surface">
      <input ref={canvas.inputRef} type="file" accept="image/*" multiple className="hidden" onChange={canvas.upload} />
      <div className="relative h-full min-w-0 overflow-hidden">
        {canvas.layersOpen ? (
          <MoodboardLayerPanel
            items={canvas.layerTree}
            selectedIds={canvas.selectedIds}
            collapsedIds={canvas.collapsedLayerIds}
            onToggleCollapsed={canvas.toggleLayerCollapsed}
            onSelectIds={canvas.selectLayers}
            onHover={canvas.hoverLayer}
            onRename={canvas.renameNode}
            onToggleVisible={canvas.toggleNodeVisible}
            onToggleLocked={canvas.toggleNodeLocked}
            onReorder={canvas.reorderLayer}
          />
        ) : null}

        <div ref={canvas.hostRef} data-testid="moodboard-leafer-canvas" className="h-full w-full overflow-hidden">
          <Leafer
            fill="#f7f7f5"
            editor={{
              hideOnMove: true,
              skewable: false,
              flipable: false,
              bright: true,
              stroke: "#0d99ff",
              strokeWidth: 1,
              pointFill: "#ffffff",
              pointRadius: 2,
              pointSize: 8,
            }}
            wheel={{ preventDefault: true }}
            move={{ dragEmpty: false }}
            zoom={{ min: 0.1, max: 4 }}
            onAppReady={canvas.handleAppReady}
            className={cn("h-full w-full overflow-hidden", canvas.tool === "hand" && "active:cursor-grabbing")}
            style={{ cursor }}
          >
            <MoodboardNodeLayer nodes={nodes} onLayerCreated={canvas.handleLayerCreated} />
          </Leafer>
        </div>

        {!canvas.runtimeReady ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex items-center gap-2 rounded-md border border-border bg-card/90 px-2.5 py-1.5 text-xs text-muted-foreground">
              <Loader2 size={13} className="animate-spin" />
              Loading canvas
            </div>
          </div>
        ) : null}

        {canvas.sectionDraftRect ? (
          <div
            aria-hidden
            className="pointer-events-none absolute z-10 rounded-md border border-dashed border-foreground/35 bg-foreground/[0.03]"
            style={{
              left: canvas.sectionDraftRect.left,
              top: canvas.sectionDraftRect.top,
              width: canvas.sectionDraftRect.width,
              height: canvas.sectionDraftRect.height,
            }}
          />
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

        {!canvas.isTransforming && canvas.selected && canvas.selectionRect ? (
          <FloatingCanvasSurface anchor={canvas.selectionRect} placement="top">
            <SelectionToolbar
              node={canvas.selected}
              onDuplicate={() => canvas.duplicateNode(canvas.selected!.id)}
              onBringToFront={() => canvas.bringToFront(canvas.selected!.id)}
              onSendToBack={() => canvas.sendToBack(canvas.selected!.id)}
              onToggleVisible={() => canvas.toggleNodeVisible(canvas.selected!.id)}
              onToggleLocked={() => canvas.toggleNodeLocked(canvas.selected!.id)}
              onDelete={() => canvas.deleteNode(canvas.selected!.id)}
            />
          </FloatingCanvasSurface>
        ) : null}

        {!canvas.isTransforming && canvas.selectedNodes.length > 1 && canvas.selectionRect ? (
          <FloatingCanvasSurface anchor={canvas.selectionRect} placement="top">
            <MultiSelectionToolbar
              nodes={canvas.selectedNodes}
              onDuplicate={() => canvas.duplicateNodes(canvas.selectedIds)}
              onBringToFront={() => canvas.bringNodesToFront(canvas.selectedIds)}
              onSendToBack={() => canvas.sendNodesToBack(canvas.selectedIds)}
              onSetVisible={(visible) => canvas.setNodesVisible(canvas.selectedIds, visible)}
              onSetLocked={(locked) => canvas.setNodesLocked(canvas.selectedIds, locked)}
              onDelete={() => canvas.deleteNodes(canvas.selectedIds)}
            />
          </FloatingCanvasSurface>
        ) : null}

        {!canvas.isTransforming && canvas.selected?.type === "image-generator" && canvas.selectionRect ? (
          <FloatingCanvasSurface anchor={canvas.selectionRect} placement="bottom">
            <GeneratorPromptToolbar
              node={canvas.selected}
              busy={busy}
              models={imageModels}
              model={selectedGeneratorModel || imageModel}
              onModelChange={(model) => {
                canvas.patchNodeData(canvas.selected!.id, { generatorModel: model });
                onImageModelChange(model);
              }}
              onPromptChange={(prompt) => canvas.patchNodeData(canvas.selected!.id, { generatorPrompt: prompt, generatorStatus: prompt ? "ready" : "" })}
              onGenerate={(prompt) => onGenerateImage(canvas.selected!, prompt)}
            />
          </FloatingCanvasSurface>
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

function FloatingCanvasSurface({
  anchor,
  placement,
  children,
}: {
  anchor: FloatingRect;
  placement: "top" | "bottom";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState({ left: anchor.left, top: placement === "top" ? anchor.top : anchor.bottom });

  useLayoutEffect(() => {
    const element = ref.current;
    const container = element?.parentElement;
    if (!element || !container) return;

    const update = () => {
      const next = resolveFloatingChromeRect({
        anchor,
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
        surfaceWidth: element.offsetWidth,
        surfaceHeight: element.offsetHeight,
        placement,
        occluders: getFloatingOccluders(container, element),
      });
      setRect(next);
    };

    const observer = new ResizeObserver(update);
    const observeTargets = () => {
      observer.disconnect();
      observer.observe(element);
      observer.observe(container);
      for (const occluder of container.querySelectorAll<HTMLElement>("[data-moodboard-floating-occluder]")) {
        if (occluder !== element && !element.contains(occluder) && !occluder.contains(element)) observer.observe(occluder);
      }
      update();
    };
    const mutationObserver = typeof MutationObserver !== "undefined" ? new MutationObserver(observeTargets) : null;
    observeTargets();
    mutationObserver?.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-moodboard-floating-occluder", "style", "class"] });
    return () => {
      observer.disconnect();
      mutationObserver?.disconnect();
    };
  }, [anchor, placement]);

  return (
    <div ref={ref} className="pointer-events-none absolute z-30" style={{ left: rect.left, top: rect.top }}>
      {children}
    </div>
  );
}

function getFloatingOccluders(container: HTMLElement, current: HTMLElement): CanvasRect[] {
  const containerRect = container.getBoundingClientRect();
  return Array.from(container.querySelectorAll<HTMLElement>("[data-moodboard-floating-occluder]"))
    .filter((element) => element !== current && !current.contains(element) && !element.contains(current))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return rectFromBounds(rect.left - containerRect.left, rect.top - containerRect.top, rect.right - containerRect.left, rect.bottom - containerRect.top);
    });
}

const MoodboardNodeLayer = memo(function MoodboardNodeLayer({
  nodes,
  onLayerCreated,
}: {
  nodes: MoodboardNode[];
  onLayerCreated: (frame: Frame) => void;
}) {
  return (
    <LeaferFrame id="moodboard-node-layer" name="nodes" fill="transparent" hitSelf={false} isSnap={false} onCreated={onLayerCreated}>
      {[...nodes]
        .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
        .map((node) => (
          <MoodboardCanvasNode key={node.id} node={node} />
        ))}
    </LeaferFrame>
  );
});
