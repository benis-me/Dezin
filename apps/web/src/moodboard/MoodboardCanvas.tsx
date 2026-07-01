import { ImagePlus, Loader2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { Frame as LeaferFrame, Leafer } from "@dezin/leafer-react";
import type { Frame } from "leafer-editor";
import { useToast } from "../components/Toast.tsx";
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
  const { toast } = useToast();
  const canvas = useMoodboardCanvasController(props);
  const selectedGeneratorPrompt = canvas.selected ? generatorPrompt(canvas.selected) : "";
  const selectedGeneratorModel = canvas.selected ? generatorModel(canvas.selected) : "";
  const cursor = canvas.tool === "hand" ? "grab" : canvas.tool === "note" || canvas.tool === "section" ? "crosshair" : "default";
  const [dragDepth, setDragDepth] = useState(0);
  const dragActive = dragDepth > 0;

  const handleExternalDragEnter = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDragDepth((current) => current + 1);
  };

  const handleExternalDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleExternalDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDragDepth((current) => Math.max(0, current - 1));
  };

  const handleExternalDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDragDepth(0);
    props.onUploadFiles(event.dataTransfer.files);
  };

  const unavailableImageAction = (action: string): void => {
    toast(`${action} needs image-edit provider support.`, { variant: "error" });
  };

  return (
    <div className="relative min-h-0 flex-1 bg-surface">
      <div
        className={cn("relative h-full min-w-0 overflow-hidden", dragActive && "ring-1 ring-inset ring-primary/35")}
        onDragEnter={handleExternalDragEnter}
        onDragOver={handleExternalDragOver}
        onDragLeave={handleExternalDragLeave}
        onDrop={handleExternalDrop}
      >
        <AnimatePresence initial={false}>
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
        </AnimatePresence>

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

        <AnimatePresence initial={false}>
          {!canvas.runtimeReady ? (
            <motion.div
              className="pointer-events-none absolute inset-0 grid place-items-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
            >
              <div className="flex items-center gap-2 rounded-md border border-border bg-card/90 px-2.5 py-1.5 text-xs text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                Loading canvas
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

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
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="grid size-14 place-items-center rounded-2xl border border-border bg-card text-muted-foreground">
                <ImagePlus size={24} strokeWidth={1.5} />
              </span>
              <div>
                <p className="text-sm font-medium text-foreground">Start collecting direction</p>
                <p className="mt-1 text-xs text-muted-foreground">Drop images here, add notes, or double-click the canvas to add a generator.</p>
              </div>
            </div>
          </div>
        ) : null}

        <AnimatePresence initial={false}>
          {dragActive ? (
            <motion.div
              className="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-background/20 backdrop-blur-[1px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
            >
              <div className="rounded-lg border border-primary/30 bg-card/95 px-3 py-2 text-xs font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
                Drop images to add them to the board
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {canvas.selected && canvas.selectionRect ? (
            <FloatingCanvasSurface anchor={canvas.selectionRect} placement="top">
              <SelectionToolbar
                node={canvas.selected}
                onDuplicate={() => canvas.duplicateNode(canvas.selected!.id)}
                onDelete={() => canvas.deleteNode(canvas.selected!.id)}
                onImageAction={unavailableImageAction}
              />
            </FloatingCanvasSurface>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {canvas.selectedNodes.length > 1 && canvas.selectionRect ? (
            <FloatingCanvasSurface anchor={canvas.selectionRect} placement="top">
              <MultiSelectionToolbar
                nodes={canvas.selectedNodes}
                onDuplicate={() => canvas.duplicateNodes(canvas.selectedIds)}
                onAlign={(type) => canvas.alignNodes(canvas.selectedIds, type)}
                onArrange={() => canvas.arrangeNodes(canvas.selectedIds)}
                onDelete={() => canvas.deleteNodes(canvas.selectedIds)}
                onImageAction={unavailableImageAction}
              />
            </FloatingCanvasSurface>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {canvas.selected?.type === "image-generator" && canvas.selectionRect ? (
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
        </AnimatePresence>

        <CanvasActionBar
          tool={canvas.tool}
          layersOpen={canvas.layersOpen}
          onToolChange={canvas.setTool}
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

        <AnimatePresence initial={false}>
          {canvas.selected ? (
            <MoodboardPropertiesPanel
              node={canvas.selected}
              onPatch={(patch) => canvas.selected && canvas.patchNode(canvas.selected.id, patch)}
              onPatchData={canvas.patchSelectedData}
              onGenerate={() => canvas.selected?.type === "image-generator" && onGenerateImage(canvas.selected, selectedGeneratorPrompt)}
            />
          ) : null}
        </AnimatePresence>
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
  const contentRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const reducedMotion = useReducedMotion();

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
      const transform = `translate3d(${Math.round(next.left)}px, ${Math.round(next.top)}px, 0)`;
      if (element.style.transform !== transform) element.style.transform = transform;
      if (!readyRef.current) {
        readyRef.current = true;
        setReady(true);
      }
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
    mutationObserver?.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutationObserver?.disconnect();
    };
  }, [anchor, placement]);

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute left-0 top-0 z-30 will-change-transform"
      style={{ opacity: ready ? 1 : 0 }}
    >
      <motion.div
        ref={contentRef}
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: placement === "top" ? 2 : -2 }}
        animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
        exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: placement === "top" ? 2 : -2 }}
        transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
      >
        {children}
      </motion.div>
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

function hasDraggedFiles(event: ReactDragEvent<HTMLDivElement>): boolean {
  return Array.from(event.dataTransfer.types ?? []).includes("Files");
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
