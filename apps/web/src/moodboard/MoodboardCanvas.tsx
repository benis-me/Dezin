import { ImagePlus, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode, type RefObject } from "react";
import { Frame as LeaferFrame, Leafer } from "@dezin/leafer-react";
import type { Frame } from "leafer-editor";
import { useToast } from "../components/Toast.tsx";
import type { MoodboardNode } from "../lib/api.ts";
import { cn } from "../lib/utils.ts";
import { MoodboardCanvasNode } from "./MoodboardCanvasNode.tsx";
import { CanvasActionBar, CanvasViewBar, CanvasZoomBar, GeneratorPromptToolbar, MultiSelectionToolbar, QuickEditPromptToolbar, SelectionToolbar } from "./MoodboardCanvasToolbars.tsx";
import { MoodboardContextMenu } from "./MoodboardContextMenu.tsx";
import { MoodboardLayerPanel } from "./MoodboardLayerPanel.tsx";
import { MoodboardMultiPropertiesPanel, MoodboardPropertiesPanel } from "./MoodboardPropertiesPanel.tsx";
import { generatorModel, generatorPrompt, isEditableShortcutTarget, rectFromBounds, resolveFloatingChromeRect, resolveFloatingRect, type CanvasRect, type FloatingRect } from "./canvas-utils.ts";
import { MOODBOARD_LEAFER_EDITOR_CONFIG } from "./moodboard-canvas-config.ts";
import { useMoodboardCanvasController, type MoodboardCanvasProps } from "./useMoodboardCanvasController.ts";

export function MoodboardCanvas(props: MoodboardCanvasProps) {
  const {
    nodes,
    busy = false,
    imageModels = [],
    imageModel = "",
    onImageModelChange = () => {},
    onGenerateImage,
  } = props;
  const { toast } = useToast();
  const canvas = useMoodboardCanvasController(props);
  const selectedGeneratorPrompt = canvas.selected ? generatorPrompt(canvas.selected) : "";
  const selectedGeneratorModel = canvas.selected ? generatorModel(canvas.selected) : "";
  const cursor = canvas.tool === "hand" ? "grab" : canvas.tool === "note" || canvas.tool === "section" ? "crosshair" : "default";
  const [dragDepth, setDragDepth] = useState(0);
  const [presentationMode, setPresentationMode] = useState(false);
  const [quickEditOpen, setQuickEditOpen] = useState(false);
  const dragActive = dragDepth > 0;
  const quickEditNode = canvas.selectedNodes.find((node) => node.type === "image") ?? null;
  const quickEditModel = quickEditNode ? generatorModel(quickEditNode) || imageModel : imageModel;

  useEffect(() => {
    if (!quickEditNode) setQuickEditOpen(false);
  }, [quickEditNode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey || presentationMode || !quickEditNode || !canvas.runtimeReady) return;
      if (isEditableShortcutTarget(event.target)) return;
      event.preventDefault();
      setQuickEditOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvas.runtimeReady, presentationMode, quickEditNode]);

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
    canvas.uploadFiles(event.dataTransfer.files);
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
          {canvas.layersOpen && !presentationMode ? (
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
              onDuplicateSelected={canvas.duplicateNodes}
              onDeleteSelected={canvas.deleteNodes}
            />
          ) : null}
        </AnimatePresence>

        <div ref={canvas.hostRef} data-testid="moodboard-leafer-canvas" className="h-full w-full overflow-hidden">
          <Leafer
            fill="#f7f7f5"
            editor={MOODBOARD_LEAFER_EDITOR_CONFIG}
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
          {canvas.selected && canvas.selectedIds.length === 1 && canvas.runtimeReady && !presentationMode ? (
            <FloatingCanvasSurface
              appRef={canvas.appRef}
              hostRef={canvas.hostRef}
              selectedIds={canvas.selectedIds}
              anchor={canvas.selectionRect}
              placement="top"
              avoidOccluders={false}
            >
              <SelectionToolbar
                node={canvas.selected}
                onDuplicate={() => canvas.duplicateNode(canvas.selected!.id)}
                onDelete={() => canvas.deleteNode(canvas.selected!.id)}
                onImageAction={unavailableImageAction}
                onQuickEdit={() => setQuickEditOpen(true)}
              />
            </FloatingCanvasSurface>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {canvas.selectedNodes.length > 1 && canvas.runtimeReady && !presentationMode ? (
            <FloatingCanvasSurface
              appRef={canvas.appRef}
              hostRef={canvas.hostRef}
              selectedIds={canvas.selectedIds}
              anchor={canvas.selectionRect}
              placement="top"
              avoidOccluders={false}
            >
              <MultiSelectionToolbar
                nodes={canvas.selectedNodes}
                onDuplicate={() => canvas.duplicateNodes(canvas.selectedIds)}
                onAlign={(type) => canvas.alignNodes(canvas.selectedIds, type)}
                onArrange={() => canvas.arrangeNodes(canvas.selectedIds)}
                onDelete={() => canvas.deleteNodes(canvas.selectedIds)}
                onImageAction={unavailableImageAction}
                onQuickEdit={() => setQuickEditOpen(true)}
              />
            </FloatingCanvasSurface>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {canvas.selected?.type === "image-generator" && canvas.runtimeReady && !presentationMode ? (
            <FloatingCanvasSurface
              appRef={canvas.appRef}
              hostRef={canvas.hostRef}
              selectedIds={canvas.selectedIds}
              anchor={canvas.selectionRect}
              placement="bottom"
            >
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
                onGenerate={(prompt) => {
                  canvas.recordHistory();
                  return onGenerateImage(canvas.selected!, prompt);
                }}
              />
            </FloatingCanvasSurface>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {quickEditOpen && quickEditNode && canvas.runtimeReady && !presentationMode ? (
            <FloatingCanvasSurface
              appRef={canvas.appRef}
              hostRef={canvas.hostRef}
              selectedIds={canvas.selectedIds}
              anchor={canvas.selectionRect}
              placement="bottom"
            >
              <QuickEditPromptToolbar
                busy={busy}
                models={imageModels}
                model={quickEditModel}
                onModelChange={(model) => {
                  canvas.patchNodeData(quickEditNode.id, { generatorModel: model });
                  onImageModelChange(model);
                }}
                onGenerate={async (prompt) => {
                  canvas.recordHistory();
                  await onGenerateImage(quickEditNode, prompt);
                  setQuickEditOpen(false);
                }}
              />
            </FloatingCanvasSurface>
          ) : null}
        </AnimatePresence>

        {!presentationMode ? (
          <CanvasActionBar tool={canvas.tool} onToolChange={canvas.setTool} onAddImageGenerator={() => canvas.addImageGeneratorAt()} />
        ) : null}
        <CanvasViewBar
          layersOpen={canvas.layersOpen && !presentationMode}
          presentationMode={presentationMode}
          onToggleLayers={() => {
            if (presentationMode) {
              setPresentationMode(false);
              canvas.setLayersOpen(true);
              return;
            }
            canvas.setLayersOpen((value) => !value);
          }}
          onTogglePresentation={() => {
            setQuickEditOpen(false);
            setPresentationMode((value) => !value);
          }}
        />
        <CanvasZoomBar zoom={canvas.zoom} onChangeZoom={canvas.changeZoom} onFitView={canvas.fitView} />

        {canvas.contextMenu && !presentationMode ? (
          <MoodboardContextMenu
            menu={canvas.contextMenu}
            targetId={canvas.contextTargetId}
            onClose={() => canvas.setContextMenu(null)}
            onAddNote={() => {
              canvas.addNoteAt({ x: canvas.contextMenu!.canvasX, y: canvas.contextMenu!.canvasY });
            }}
            onAddSection={() => {
              canvas.addSectionAt({ x: canvas.contextMenu!.canvasX, y: canvas.contextMenu!.canvasY });
            }}
            onGenerate={() => {
              canvas.addImageGeneratorAt({ x: canvas.contextMenu!.canvasX, y: canvas.contextMenu!.canvasY });
            }}
            onCopy={
              canvas.contextTargetId
                ? () => {
                    const targetIds = canvas.selectedIds.includes(canvas.contextTargetId!) ? canvas.selectedIds : [canvas.contextTargetId!];
                    canvas.copyNodes(targetIds);
                    canvas.setContextMenu(null);
                  }
                : undefined
            }
            onPaste={() => {
              canvas.pasteCopiedNodes({ x: canvas.contextMenu!.canvasX, y: canvas.contextMenu!.canvasY });
              canvas.setContextMenu(null);
            }}
            onDuplicate={canvas.contextTargetId ? () => canvas.duplicateNodes(contextActionIds(canvas.contextTargetId, canvas.selectedIds)) : undefined}
            onMoveForward={canvas.contextTargetId ? () => canvas.moveNodesLayerStep(contextActionIds(canvas.contextTargetId, canvas.selectedIds), "up") : undefined}
            onMoveBackward={canvas.contextTargetId ? () => canvas.moveNodesLayerStep(contextActionIds(canvas.contextTargetId, canvas.selectedIds), "down") : undefined}
            onBringToFront={canvas.contextTargetId ? () => canvas.bringNodesToFront(contextActionIds(canvas.contextTargetId, canvas.selectedIds)) : undefined}
            onSendToBack={canvas.contextTargetId ? () => canvas.sendNodesToBack(contextActionIds(canvas.contextTargetId, canvas.selectedIds)) : undefined}
            onToggleVisible={canvas.contextTargetId ? () => canvas.toggleNodeVisible(canvas.contextTargetId!) : undefined}
            onToggleLocked={canvas.contextTargetId ? () => canvas.toggleNodeLocked(canvas.contextTargetId!) : undefined}
            onDelete={canvas.contextTargetId ? () => canvas.deleteNodes(contextActionIds(canvas.contextTargetId, canvas.selectedIds)) : undefined}
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
            boundaryElement={canvas.hostRef.current}
          />
        ) : null}

        <AnimatePresence initial={false}>
          {canvas.selected && !presentationMode ? (
            <MoodboardPropertiesPanel
              node={canvas.selected}
              onPatch={(patch) => canvas.selected && canvas.patchNode(canvas.selected.id, patch)}
              onPatchData={canvas.patchSelectedData}
              onGenerate={() => {
                if (canvas.selected?.type !== "image-generator") return;
                canvas.recordHistory();
                void onGenerateImage(canvas.selected, selectedGeneratorPrompt);
              }}
            />
          ) : canvas.selectedNodes.length > 1 && !presentationMode ? (
            <MoodboardMultiPropertiesPanel
              nodes={canvas.selectedNodes}
              onSetVisible={(visible) => canvas.setNodesVisible(canvas.selectedIds, visible)}
              onSetLocked={(locked) => canvas.setNodesLocked(canvas.selectedIds, locked)}
              onArrange={() => canvas.arrangeNodes(canvas.selectedIds)}
            />
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

function FloatingCanvasSurface({
  appRef,
  hostRef,
  selectedIds,
  anchor,
  placement,
  avoidOccluders = true,
  children,
}: {
  appRef: RefObject<any>;
  hostRef: RefObject<HTMLDivElement | null>;
  selectedIds: string[];
  anchor?: FloatingRect | null;
  placement: "top" | "bottom";
  avoidOccluders?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selectedIdsRef = useRef(selectedIds);
  const anchorRef = useRef(anchor);
  const layoutRef = useRef<FloatingLayoutSnapshot | null>(null);
  const updateRef = useRef<((reason?: FloatingPositionReason) => void) | null>(null);
  const selectedKey = [...selectedIds].sort().join("\u0000");
  const anchorKey = floatingRectKey(anchor);
  selectedIdsRef.current = selectedIds;
  anchorRef.current = anchor;

  useLayoutEffect(() => {
    const element = ref.current;
    const container = hostRef.current;
    const app = appRef.current;
    if (!element || !container || !app) return;
    const hasPosition = element.style.transform.length > 0;
    layoutRef.current = null;
    if (!hasPosition) element.style.visibility = "hidden";
    element.style.display = "";

    const readLayout = (reason: FloatingPositionReason): FloatingLayoutSnapshot => {
      if (reason === "layout" || layoutRef.current == null) {
        layoutRef.current = {
          containerWidth: container.clientWidth,
          containerHeight: container.clientHeight,
          surfaceWidth: element.offsetWidth,
          surfaceHeight: element.offsetHeight,
          occluders: avoidOccluders ? getFloatingOccluders(container, element) : [],
        };
      }
      return layoutRef.current;
    };

    const update = (reason: FloatingPositionReason = "viewport") => {
      const nextAnchor = resolveSelectedFloatingAnchor(app, container, selectedIdsRef.current) ?? anchorRef.current;
      if (!nextAnchor) {
        element.style.display = "none";
        element.style.visibility = "hidden";
        return;
      }
      element.style.display = "";
      const layout = readLayout(reason);
      const next = resolveFloatingChromeRect({
        anchor: nextAnchor,
        containerWidth: layout.containerWidth,
        containerHeight: layout.containerHeight,
        surfaceWidth: layout.surfaceWidth,
        surfaceHeight: layout.surfaceHeight,
        placement,
        occluders: layout.occluders,
      });
      const transform = `translate3d(${Math.round(next.left)}px, ${Math.round(next.top)}px, 0)`;
      if (element.style.transform !== transform) element.style.transform = transform;
      element.style.visibility = "visible";
    };
    updateRef.current = update;

    const cleanup = bindFloatingCanvasSurfaceEvents(app, update, { container, toolbar: element, observeOccluders: avoidOccluders });
    update("layout");
    return () => {
      updateRef.current = null;
      cleanup();
    };
  }, [appRef, avoidOccluders, hostRef, placement, selectedKey]);

  useLayoutEffect(() => {
    updateRef.current?.("viewport");
  }, [anchorKey]);

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute left-0 top-0 z-30 will-change-transform"
      style={{ visibility: "hidden" }}
    >
      {children}
    </div>
  );
}

function floatingRectKey(rect: FloatingRect | null | undefined): string {
  if (!rect) return "";
  return [rect.left, rect.top, rect.bottom, rect.targetLeft ?? rect.left, rect.targetRight ?? rect.left]
    .map((value) => Math.round(value * 10) / 10)
    .join(":");
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

type FloatingEventTarget = {
  on?: (event: string, handler: () => void) => void;
  off?: (event: string, handler: () => void) => void;
};

type FloatingEventApp = FloatingEventTarget & {
  tree?: FloatingEventTarget;
  editor?: FloatingEventTarget;
};

type FloatingPositionReason = "viewport" | "layout";

type FloatingLayoutSnapshot = {
  containerWidth: number;
  containerHeight: number;
  surfaceWidth: number;
  surfaceHeight: number;
  occluders: CanvasRect[];
};

type FloatingFrame = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  boxBounds?: { x?: number; y?: number; width?: number; height?: number };
  worldBoxBounds?: { x?: number; y?: number; width?: number; height?: number };
};

const FLOATING_TREE_VIEWPORT_EVENTS = ["move", "property.leafer_change", "zoom", "transform"] as const;
const FLOATING_VIEWPORT_END_EVENTS = ["move.end", "zoom.end"] as const;
const FLOATING_EDITOR_EVENTS = ["editor.select", "editor.move", "editor.scale", "editor.rotate"] as const;

function bindFloatingCanvasSurfaceEvents(
  app: FloatingEventApp,
  updatePosition: (reason: FloatingPositionReason) => void,
  options: { container: HTMLElement; toolbar: HTMLElement; observeOccluders: boolean },
): () => void {
  let frame: number | null = null;
  let trackingFrame: number | null = null;
  let trackingUntil = 0;
  let pendingReason: FloatingPositionReason = "viewport";
  const schedule = (reason: FloatingPositionReason = "viewport") => {
    pendingReason = reason === "layout" || pendingReason === "layout" ? "layout" : "viewport";
    if (frame != null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      const nextReason = pendingReason;
      pendingReason = "viewport";
      updatePosition(nextReason);
    });
  };
  const trackViewport = () => {
    schedule("viewport");
    trackingUntil = Math.max(trackingUntil, nowMs() + 180);
    if (trackingFrame != null) return;
    const tick = (time: number) => {
      trackingFrame = null;
      if (time > trackingUntil) return;
      schedule("viewport");
      trackingFrame = window.requestAnimationFrame(tick);
    };
    trackingFrame = window.requestAnimationFrame(tick);
  };
  const scheduleLayout = () => schedule("layout");
  const cleanups = [
    bindFloatingEvents(app, FLOATING_TREE_VIEWPORT_EVENTS, trackViewport),
    bindFloatingEvents(app.tree, FLOATING_TREE_VIEWPORT_EVENTS, trackViewport),
    bindFloatingEvents(app.tree, FLOATING_VIEWPORT_END_EVENTS, trackViewport),
    bindFloatingEvents(app, FLOATING_VIEWPORT_END_EVENTS, trackViewport),
    bindFloatingEvents(app.editor, FLOATING_EDITOR_EVENTS, trackViewport),
    bindFloatingDomEvents(options.container, options.toolbar, scheduleLayout, trackViewport, options.observeOccluders),
  ];
  return () => {
    cleanups.forEach((cleanup) => cleanup());
    if (frame != null) window.cancelAnimationFrame(frame);
    if (trackingFrame != null) window.cancelAnimationFrame(trackingFrame);
  };
}

function bindFloatingEvents(target: FloatingEventTarget | undefined, events: readonly string[], handler: () => void): () => void {
  if (!target?.on || !target.off) return () => {};
  events.forEach((event) => target.on?.(event, handler));
  return () => events.forEach((event) => target.off?.(event, handler));
}

function bindFloatingDomEvents(container: HTMLElement, toolbar: HTMLElement, schedule: () => void, trackViewport: () => void, observeOccluders: boolean): () => void {
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  const attributeObserver = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
  const mutationObserver =
    typeof MutationObserver === "function"
      ? new MutationObserver((mutations) => {
          if (!observeOccluders) return;
          for (const mutation of mutations) {
            if (containsFloatingOccluder(mutation.addedNodes) || containsFloatingOccluder(mutation.removedNodes)) {
              refreshTargets();
              schedule();
              return;
            }
          }
        })
      : null;

  const refreshTargets = () => {
    resizeObserver?.disconnect();
    attributeObserver?.disconnect();
    resizeObserver?.observe(container);
    resizeObserver?.observe(toolbar);
    if (!observeOccluders) return;
    container.querySelectorAll<HTMLElement>("[data-moodboard-floating-occluder]").forEach((element) => {
      resizeObserver?.observe(element);
      attributeObserver?.observe(element, { attributes: true, attributeFilter: ["class", "style", "data-moodboard-floating-occluder"] });
    });
  };
  const handleTransitionEnd = (event: Event) => {
    if (observeOccluders && event.target instanceof HTMLElement && event.target.matches("[data-moodboard-floating-occluder]")) schedule();
  };
  const handleViewportInput = () => trackViewport();
  refreshTargets();
  mutationObserver?.observe(container, { childList: true, subtree: true });
  container.addEventListener("transitionend", handleTransitionEnd, true);
  container.addEventListener("animationend", handleTransitionEnd, true);
  container.addEventListener("wheel", handleViewportInput, true);
  container.addEventListener("pointermove", handleViewportInput, true);
  return () => {
    resizeObserver?.disconnect();
    attributeObserver?.disconnect();
    mutationObserver?.disconnect();
    container.removeEventListener("transitionend", handleTransitionEnd, true);
    container.removeEventListener("animationend", handleTransitionEnd, true);
    container.removeEventListener("wheel", handleViewportInput, true);
    container.removeEventListener("pointermove", handleViewportInput, true);
  };
}

function nowMs(): number {
  return window.performance?.now?.() ?? Date.now();
}

function containsFloatingOccluder(nodes: NodeList): boolean {
  return Array.from(nodes).some((node) => node instanceof HTMLElement && (node.matches("[data-moodboard-floating-occluder]") || Boolean(node.querySelector("[data-moodboard-floating-occluder]"))));
}

function resolveSelectedFloatingAnchor(app: any, container: HTMLElement, selectedIds: string[]): FloatingRect | null {
  const frames = selectedIds.map((id) => findMoodboardFrame(app, id)).filter((frame): frame is FloatingFrame => Boolean(frame));
  if (frames.length === 0) return null;
  const liveRect = resolveLiveFloatingTargetRect(app?.tree, frames);
  if (liveRect) {
    return {
      left: liveRect.left + liveRect.width / 2,
      top: liveRect.top - 8,
      bottom: liveRect.bottom + 12,
      targetLeft: liveRect.left,
      targetRight: liveRect.right,
    };
  }
  const local = unionFloatingFrameBounds(frames, "boxBounds");
  const world = unionFloatingFrameBounds(frames, "worldBoxBounds");
  const frame = frames.length === 1 ? frames[0] : local;
  const containerRect = container.getBoundingClientRect();
  return resolveFloatingRect({
    containerWidth: container.clientWidth,
    containerHeight: container.clientHeight,
    containerLeft: containerRect.left,
    containerTop: containerRect.top,
    frame,
    tree: app?.tree,
    world,
  });
}

function findMoodboardFrame(app: any, id: string): FloatingFrame | null {
  return app?.findId?.(id) ?? app?.tree?.findOne?.(`#${id}`) ?? null;
}

function resolveLiveFloatingTargetRect(
  tree: { x?: number; y?: number; scale?: number; scaleX?: number; scaleY?: number } | undefined,
  frames: FloatingFrame[],
): CanvasRect | null {
  const hasLiveTreeTransform = tree != null && (tree.x != null || tree.y != null || tree.scale != null || tree.scaleX != null || tree.scaleY != null);
  if (!hasLiveTreeTransform) return null;
  const scaleX = Number(tree?.scaleX ?? tree?.scale ?? 1) || 1;
  const scaleY = Number(tree?.scaleY ?? tree?.scale ?? 1) || 1;
  const treeX = Number(tree?.x ?? 0) || 0;
  const treeY = Number(tree?.y ?? 0) || 0;
  const rects = frames.map((frame) => {
    const rawBounds = frame.boxBounds ?? frame;
    if (!hasUsableFloatingFrameBounds(rawBounds)) return null;
    const bounds = normalizeFloatingFrameBounds(rawBounds);
    const left = treeX + bounds.x * scaleX;
    const top = treeY + bounds.y * scaleY;
    const right = treeX + (bounds.x + bounds.width) * scaleX;
    const bottom = treeY + (bounds.y + bounds.height) * scaleY;
    return rectFromBounds(Math.min(left, right), Math.min(top, bottom), Math.max(left, right), Math.max(top, bottom));
  }).filter((rect): rect is CanvasRect => Boolean(rect));
  if (rects.length !== frames.length) return null;
  return unionCanvasRects(rects);
}

function unionCanvasRects(rects: CanvasRect[]): CanvasRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return rectFromBounds(left, top, right, bottom);
}

function unionFloatingFrameBounds(frames: FloatingFrame[], key: "boxBounds" | "worldBoxBounds"): { x: number; y: number; width: number; height: number } {
  const bounds = frames.map((frame) => normalizeFloatingFrameBounds(frame[key] ?? frame));
  const left = Math.min(...bounds.map((bound) => bound.x));
  const top = Math.min(...bounds.map((bound) => bound.y));
  const right = Math.max(...bounds.map((bound) => bound.x + bound.width));
  const bottom = Math.max(...bounds.map((bound) => bound.y + bound.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalizeFloatingFrameBounds(bounds: FloatingFrame): { x: number; y: number; width: number; height: number } {
  return {
    x: Number(bounds.x ?? 0),
    y: Number(bounds.y ?? 0),
    width: Math.max(1, Number(bounds.width ?? 0) || 1),
    height: Math.max(1, Number(bounds.height ?? 0) || 1),
  };
}

function hasUsableFloatingFrameBounds(bounds: FloatingFrame): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every((value) => Number.isFinite(Number(value)));
}

function hasDraggedFiles(event: ReactDragEvent<HTMLDivElement>): boolean {
  return Array.from(event.dataTransfer.types ?? []).includes("Files");
}

function contextActionIds(targetId: string | null, selectedIds: string[]): string[] {
  if (!targetId) return [];
  return selectedIds.includes(targetId) ? selectedIds : [targetId];
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
