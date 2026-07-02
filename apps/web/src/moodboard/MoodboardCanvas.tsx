import { ImagePlus, Loader2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode, type RefObject } from "react";
import { Frame as LeaferFrame, Leafer } from "@dezin/leafer-react";
import type { Frame } from "leafer-editor";
import { useToast } from "../components/Toast.tsx";
import type { MoodboardNode } from "../lib/api.ts";
import { cn } from "../lib/utils.ts";
import { MoodboardCanvasNode } from "./MoodboardCanvasNode.tsx";
import {
  CanvasActionBar,
  GeneratorPromptToolbar,
  MultiSelectionToolbar,
  QuickEditPromptToolbar,
  SelectionToolbar,
  type ReferenceImageItem,
} from "./MoodboardCanvasToolbars.tsx";
import { MoodboardContextMenu } from "./MoodboardContextMenu.tsx";
import { MoodboardLayerPanel } from "./MoodboardLayerPanel.tsx";
import { MoodboardMultiPropertiesPanel, MoodboardPropertiesPanel } from "./MoodboardPropertiesPanel.tsx";
import { MoodboardSectionLabels } from "./MoodboardSectionLabels.tsx";
import {
  clientPointToCanvasPoint,
  collectFloatingOccluderRects,
  generatorModel,
  generatorPrompt,
  isEditableShortcutTarget,
  referenceAssetIds,
  rectFromBounds,
  resolveFloatingChromeRect,
  resolveFloatingRect,
  type CanvasRect,
  type FloatingRect,
} from "./canvas-utils.ts";
import { imageGenerationParamsFromNode, hasReusableImagePrompt } from "./image-generation-params.ts";
import type { MoodboardCanvasTopbarControls } from "./MoodboardCanvasTopbar.tsx";
import { MOODBOARD_LEAFER_EDITOR_CONFIG } from "./moodboard-canvas-config.ts";
import { useMoodboardCanvasController, type MoodboardCanvasProps } from "./useMoodboardCanvasController.ts";

type ReferencePickTarget = { kind: "node" | "quick-edit"; id: string };

function moodboardAssetPreviewUrl(boardId: string, assetId: string): string {
  return `/api/moodboards/${encodeURIComponent(boardId)}/assets/${encodeURIComponent(assetId)}`;
}

export function MoodboardCanvas(props: MoodboardCanvasProps) {
  const {
    nodes,
    busy = false,
    imageModels = [],
    imageModel = "",
    imageProviderId = "",
    moodboardAssets = [],
    onImageModelChange = () => {},
    onGenerateImage,
    onSendToAgent,
    onUploadReferenceFiles,
    onTopbarControlsChange,
  } = props;
  const { toast } = useToast();
  const [referencePickTarget, setReferencePickTarget] = useState<ReferencePickTarget | null>(null);
  const referencePickActive = Boolean(referencePickTarget);
  const referenceNodePickRef = useRef<((node: MoodboardNode) => void) | null>(null);
  const canvas = useMoodboardCanvasController({
    ...props,
    referencePickActive,
    onReferenceNodePick: (node) => referenceNodePickRef.current?.(node),
  });
  const selectedGeneratorPrompt = canvas.selected ? generatorPrompt(canvas.selected) : "";
  const selectedGeneratorModel = canvas.selected ? generatorModel(canvas.selected) : "";
  const cursor = canvas.tool === "hand" ? "grab" : canvas.tool === "note" || canvas.tool === "section" ? "crosshair" : "default";
  const [presentationMode, setPresentationMode] = useState(false);
  const [quickEditOpen, setQuickEditOpen] = useState(false);
  const [quickEditReferenceAssetIds, setQuickEditReferenceAssetIds] = useState<string[]>([]);
  const quickEditNode = canvas.selectedIds.length === 1 && canvas.selected?.type === "image" ? canvas.selected : null;
  const quickEditModel = quickEditNode ? generatorModel(quickEditNode) || imageModel : imageModel;
  const quickEditSourceAssetId =
    quickEditNode && typeof quickEditNode.data.assetId === "string" && quickEditNode.data.assetId.trim()
      ? quickEditNode.data.assetId.trim()
      : undefined;

  const referenceImagesById = useMemo(() => {
    const byId = new Map<string, ReferenceImageItem>();
    for (const asset of moodboardAssets) {
      byId.set(asset.id, { assetId: asset.id, url: asset.url || moodboardAssetPreviewUrl(asset.boardId, asset.id), name: asset.fileName });
    }
    for (const node of nodes) {
      const assetId = typeof node.data.assetId === "string" && node.data.assetId.trim() ? node.data.assetId.trim() : "";
      if (!assetId || byId.has(assetId)) continue;
      const url = typeof node.data.url === "string" ? node.data.url : moodboardAssetPreviewUrl(node.boardId, assetId);
      const name = typeof node.data.fileName === "string" ? node.data.fileName : undefined;
      byId.set(assetId, { assetId, url, name });
    }
    return byId;
  }, [moodboardAssets, nodes]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const referenceImagesForIds = useCallback(
    (assetIds: string[]) => assetIds.map((assetId) => referenceImagesById.get(assetId) ?? { assetId }),
    [referenceImagesById],
  );

  const mergeReferenceIds = useCallback((current: string[], additions: string[]) => {
    const next = new Set(current);
    for (const id of additions) {
      if (id.trim()) next.add(id.trim());
    }
    return [...next];
  }, []);

  const patchReferenceIdsForTarget = useCallback(
    (target: ReferencePickTarget, assetIds: string[]) => {
      if (assetIds.length === 0) return;
      if (target.kind === "quick-edit") {
        setQuickEditReferenceAssetIds((current) => mergeReferenceIds(current, assetIds));
        return;
      }
      const node = nodes.find((item) => item.id === target.id);
      if (!node) return;
      canvas.patchNodeData(node.id, { referenceAssetIds: mergeReferenceIds(referenceAssetIds(node), assetIds) });
    },
    [canvas, mergeReferenceIds, nodes],
  );

  const uploadReferenceFilesForTarget = useCallback(
    async (files: FileList, target: ReferencePickTarget) => {
      if (!onUploadReferenceFiles) return;
      const assets = await onUploadReferenceFiles(files);
      patchReferenceIdsForTarget(target, assets.map((asset) => asset.id));
    },
    [onUploadReferenceFiles, patchReferenceIdsForTarget],
  );

  const beginReferencePick = useCallback((target: ReferencePickTarget) => {
    setReferencePickTarget(target);
  }, []);

  const handleReferenceNodePick = useCallback(
    (picked: MoodboardNode) => {
      const target = referencePickTarget;
      if (!target) return;
      const assetId = typeof picked.data.assetId === "string" ? picked.data.assetId.trim() : "";
      if (!assetId) {
        toast("That image is missing an asset reference.", { variant: "error" });
        setReferencePickTarget(null);
        return;
      }
      patchReferenceIdsForTarget(target, [assetId]);
      setReferencePickTarget(null);
    },
    [patchReferenceIdsForTarget, referencePickTarget, toast],
  );

  referenceNodePickRef.current = handleReferenceNodePick;

  const openQuickEdit = useCallback(() => {
    if (!quickEditNode) return;
    canvas.fitNodes([quickEditNode.id], { padding: 140, maxScale: 2.2 });
    window.requestAnimationFrame(() => setQuickEditOpen(true));
  }, [canvas.fitNodes, quickEditNode]);

  const sendNodesToAgent = useCallback(
    (targetNodes: MoodboardNode[]) => {
      if (targetNodes.length === 0) return;
      onSendToAgent?.(targetNodes);
    },
    [onSendToAgent],
  );

  const handleTopbarZoomOut = useCallback(() => {
    canvas.changeZoom(canvas.zoom * 0.88);
  }, [canvas.changeZoom, canvas.zoom]);

  const handleTopbarZoomIn = useCallback(() => {
    canvas.changeZoom(canvas.zoom * 1.14);
  }, [canvas.changeZoom, canvas.zoom]);

  const handleToggleLayers = useCallback(() => {
    if (presentationMode) {
      setPresentationMode(false);
      canvas.setLayersOpen(true);
      return;
    }
    canvas.setLayersOpen((value) => !value);
  }, [canvas.setLayersOpen, presentationMode]);

  const handleTogglePresentation = useCallback(() => {
    setQuickEditOpen(false);
    setPresentationMode((value) => !value);
  }, []);

  const topbarControls = useMemo<MoodboardCanvasTopbarControls>(
    () => ({
      zoom: canvas.zoom,
      layersOpen: canvas.layersOpen && !presentationMode,
      presentationMode,
      onZoomOut: handleTopbarZoomOut,
      onZoomIn: handleTopbarZoomIn,
      onFitView: canvas.fitView,
      onSetZoom: canvas.changeZoom,
      onToggleLayers: handleToggleLayers,
      onTogglePresentation: handleTogglePresentation,
    }),
    [
      canvas.changeZoom,
      canvas.fitView,
      canvas.layersOpen,
      canvas.zoom,
      handleToggleLayers,
      handleTogglePresentation,
      handleTopbarZoomIn,
      handleTopbarZoomOut,
      presentationMode,
    ],
  );

  useEffect(() => {
    onTopbarControlsChange?.(topbarControls);
  }, [onTopbarControlsChange, topbarControls]);

  useEffect(() => {
    return () => onTopbarControlsChange?.(null);
  }, [onTopbarControlsChange]);

  useEffect(() => {
    if (!quickEditNode) setQuickEditOpen(false);
  }, [quickEditNode]);

  useEffect(() => {
    if (!quickEditOpen) setQuickEditReferenceAssetIds([]);
  }, [quickEditOpen]);

  useEffect(() => {
    if (!referencePickTarget) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setReferencePickTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [referencePickTarget]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey || presentationMode || !quickEditNode || !canvas.runtimeReady) return;
      if (isEditableShortcutTarget(event.target)) return;
      event.preventDefault();
      openQuickEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvas.runtimeReady, openQuickEdit, presentationMode, quickEditNode]);

  useEffect(() => {
    if (!onSendToAgent) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (presentationMode || quickEditOpen || referencePickActive || !canvas.runtimeReady || canvas.selectedNodes.length === 0) return;
      if (isEditableShortcutTarget(event.target) || isInteractiveSendShortcutTarget(event.target)) return;
      event.preventDefault();
      sendNodesToAgent(canvas.selectedNodes);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvas.runtimeReady, canvas.selectedNodes, onSendToAgent, presentationMode, quickEditOpen, referencePickActive, sendNodesToAgent]);

  const handleExternalDragEnter = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
  };

  const handleExternalDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleExternalDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
  };

  const handleExternalDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    const containerRect = canvas.hostRef.current?.getBoundingClientRect();
    const point = containerRect
      ? clientPointToCanvasPoint({
          clientX: event.clientX,
          clientY: event.clientY,
          containerLeft: containerRect.left,
          containerTop: containerRect.top,
          tree: (canvas.appRef.current as any)?.tree,
        })
      : canvas.getLastCanvasPoint() ?? undefined;
    canvas.uploadFiles(event.dataTransfer.files, point);
  };

  const unavailableImageAction = (action: string): void => {
    toast(`${action} needs image-edit provider support.`, { variant: "error" });
  };

  const uploadFilesNearNode = useCallback(
    (files: FileList, node: MoodboardNode) => {
      canvas.uploadFiles(files, { x: node.x + node.width + 32, y: node.y });
    },
    [canvas.uploadFiles],
  );

  const usePromptFromImage = useCallback(
    (node: MoodboardNode) => {
      if (!hasReusableImagePrompt(node)) return;
      canvas.recordHistory();
      canvas.addImageGeneratorAt(
        { x: node.x + node.width + 24, y: node.y },
        {
          generatorPrompt: String(node.data.prompt ?? ""),
          generatorModel: generatorModel(node) || imageModel,
          generatorStatus: "ready",
          generationParams: imageGenerationParamsFromNode(node),
          referenceAssetIds: referenceAssetIds(node),
        },
      );
    },
    [canvas.addImageGeneratorAt, canvas.recordHistory, imageModel],
  );

  const contextActionNodes = useMemo(() => {
    if (!canvas.contextTargetId) return [];
    return contextActionIds(canvas.contextTargetId, canvas.selectedIds)
      .map((id) => nodesById.get(id))
      .filter((node): node is MoodboardNode => Boolean(node));
  }, [canvas.contextTargetId, canvas.selectedIds, nodesById]);
  const contextSingleNode = contextActionNodes.length === 1 ? contextActionNodes[0] : null;
  const sendContextNodesToAgent = useCallback(() => {
    sendNodesToAgent(contextActionNodes);
    canvas.setContextMenu(null);
  }, [canvas.setContextMenu, contextActionNodes, sendNodesToAgent]);
  const openContextQuickEdit = useCallback(() => {
    if (contextSingleNode?.type !== "image") return;
    canvas.selectLayers([contextSingleNode.id]);
    canvas.fitNodes([contextSingleNode.id], { padding: 140, maxScale: 2.2 });
    canvas.setContextMenu(null);
    window.requestAnimationFrame(() => setQuickEditOpen(true));
  }, [canvas.fitNodes, canvas.selectLayers, canvas.setContextMenu, contextSingleNode]);

  return (
    <div className="relative min-h-0 flex-1 bg-surface">
      <div
        data-moodboard-canvas-root
        className="relative h-full min-w-0 overflow-hidden"
        onDragEnter={handleExternalDragEnter}
        onDragOver={handleExternalDragOver}
        onDragLeave={handleExternalDragLeave}
        onDrop={handleExternalDrop}
      >
        <AnimatePresence initial={false}>
          {canvas.layersOpen && !presentationMode && !referencePickActive ? (
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

        <MoodboardSectionLabels nodes={nodes} appRef={canvas.appRef} onSelect={canvas.selectLayer} onRename={canvas.renameNode} />

        <AnimatePresence initial={false}>
          {referencePickTarget ? <ReferencePickBanner onCancel={() => setReferencePickTarget(null)} /> : null}
        </AnimatePresence>

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
          {canvas.selected && canvas.selectedIds.length === 1 && canvas.runtimeReady && !presentationMode && !quickEditOpen && !referencePickActive ? (
            <FloatingCanvasSurface
              appRef={canvas.appRef}
              hostRef={canvas.hostRef}
              selectedIds={canvas.selectedIds}
              anchor={canvas.selectionRect}
              placement="top"
              avoidOccluders={false}
              allowSidePlacement={false}
            >
              <SelectionToolbar
                node={canvas.selected}
                onDuplicate={() => canvas.duplicateNode(canvas.selected!.id)}
                onDelete={() => canvas.deleteNode(canvas.selected!.id)}
                onImageAction={unavailableImageAction}
                onQuickEdit={openQuickEdit}
                onSendToAgent={onSendToAgent ? () => sendNodesToAgent([canvas.selected!]) : undefined}
              />
            </FloatingCanvasSurface>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {canvas.selectedNodes.length > 1 && canvas.runtimeReady && !presentationMode && !quickEditOpen && !referencePickActive ? (
            <FloatingCanvasSurface
              appRef={canvas.appRef}
              hostRef={canvas.hostRef}
              selectedIds={canvas.selectedIds}
              anchor={canvas.selectionRect}
              placement="top"
              avoidOccluders={false}
              allowSidePlacement={false}
            >
              <MultiSelectionToolbar
                nodes={canvas.selectedNodes}
                onDuplicate={() => canvas.duplicateNodes(canvas.selectedIds)}
                onAlign={(type) => canvas.alignNodes(canvas.selectedIds, type)}
                onArrange={() => canvas.arrangeNodes(canvas.selectedIds)}
                onDelete={() => canvas.deleteNodes(canvas.selectedIds)}
                onImageAction={unavailableImageAction}
                onSendToAgent={onSendToAgent ? () => sendNodesToAgent(canvas.selectedNodes) : undefined}
              />
            </FloatingCanvasSurface>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {canvas.selected?.type === "image-generator" && canvas.runtimeReady && !presentationMode && !referencePickActive ? (
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
                imageProviderId={imageProviderId}
                referenceImages={referenceImagesForIds(referenceAssetIds(canvas.selected))}
                referencePickActive={referencePickTarget?.kind === "node" && referencePickTarget.id === canvas.selected.id}
                onModelChange={(model) => {
                  canvas.patchNodeData(canvas.selected!.id, { generatorModel: model });
                  onImageModelChange(model);
                }}
                onParamsChange={(params) => {
                  canvas.patchNodeData(canvas.selected!.id, { generationParams: params });
                }}
                onPromptChange={(prompt) => canvas.patchNodeData(canvas.selected!.id, { generatorPrompt: prompt, generatorStatus: prompt ? "ready" : "" })}
                onReferenceAssetIdsChange={(assetIds) => canvas.patchNodeData(canvas.selected!.id, { referenceAssetIds: assetIds })}
                onGenerate={(prompt, params, options) => {
                  canvas.recordHistory();
                  return onGenerateImage(canvas.selected!, prompt, { params, referenceAssetIds: options.referenceAssetIds });
                }}
                onUploadFiles={(files) => uploadFilesNearNode(files, canvas.selected!)}
                onUploadReferenceFiles={(files) => void uploadReferenceFilesForTarget(files, { kind: "node", id: canvas.selected!.id })}
                onSelectCanvasReference={() => beginReferencePick({ kind: "node", id: canvas.selected!.id })}
              />
            </FloatingCanvasSurface>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {quickEditOpen && quickEditNode && canvas.runtimeReady && !presentationMode && !referencePickActive ? (
            <FloatingCanvasSurface
              appRef={canvas.appRef}
              hostRef={canvas.hostRef}
              selectedIds={canvas.selectedIds}
              anchor={canvas.selectionRect}
              placement="bottom"
            >
              <QuickEditPromptToolbar
                node={quickEditNode}
                busy={busy}
                models={imageModels}
                model={quickEditModel}
                imageProviderId={imageProviderId}
                onModelChange={(model) => {
                  canvas.patchNodeData(quickEditNode.id, { generatorModel: model });
                  onImageModelChange(model);
                }}
                referenceAssetIds={quickEditReferenceAssetIds}
                referenceImages={referenceImagesForIds(quickEditReferenceAssetIds)}
                referencePickActive={referencePickTarget?.kind === "quick-edit" && referencePickTarget.id === quickEditNode.id}
                onReferenceAssetIdsChange={setQuickEditReferenceAssetIds}
                onGenerate={async (prompt, options) => {
                  canvas.recordHistory();
                  await onGenerateImage(quickEditNode, prompt, { sourceAssetId: quickEditSourceAssetId, referenceAssetIds: options.referenceAssetIds, params: options.params });
                  setQuickEditOpen(false);
                }}
                onUploadFiles={(files) => uploadFilesNearNode(files, quickEditNode)}
                onUploadReferenceFiles={(files) => void uploadReferenceFilesForTarget(files, { kind: "quick-edit", id: quickEditNode.id })}
                onSelectCanvasReference={() => beginReferencePick({ kind: "quick-edit", id: quickEditNode.id })}
              />
            </FloatingCanvasSurface>
          ) : null}
        </AnimatePresence>

        {!presentationMode && !referencePickActive ? (
          <CanvasActionBar tool={canvas.tool} onToolChange={canvas.setTool} onAddImageGenerator={() => canvas.addImageGeneratorAt()} />
        ) : null}

        {canvas.contextMenu && !presentationMode && !referencePickActive ? (
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
            onQuickEdit={contextSingleNode?.type === "image" ? openContextQuickEdit : undefined}
            onSendToAgent={contextActionNodes.length > 0 && onSendToAgent ? sendContextNodesToAgent : undefined}
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
            targetNode={contextSingleNode ?? (canvas.contextTargetId ? nodesById.get(canvas.contextTargetId) ?? null : null)}
            boundaryElement={canvas.hostRef.current}
          />
        ) : null}

        <AnimatePresence initial={false}>
          {canvas.selected && !presentationMode && !referencePickActive ? (
            <MoodboardPropertiesPanel
              node={canvas.selected}
              onPatch={(patch) => canvas.selected && canvas.patchNode(canvas.selected.id, patch)}
              onPatchData={canvas.patchSelectedData}
              onGenerate={() => {
                if (canvas.selected?.type !== "image-generator") return;
                canvas.recordHistory();
                void onGenerateImage(canvas.selected, selectedGeneratorPrompt, {
                  params: imageGenerationParamsFromNode(canvas.selected),
                  referenceAssetIds: referenceAssetIds(canvas.selected),
                });
              }}
              onEditImage={openQuickEdit}
              onUsePrompt={usePromptFromImage}
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

function isInteractiveSendShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, [role='menu'], [data-moodboard-toolbar]"));
}

function ReferencePickBanner({ onCancel }: { onCancel: () => void }) {
  return (
    <motion.div
      role="status"
      aria-label="Canvas reference picking"
      data-moodboard-floating-occluder
      className="pointer-events-auto app-no-drag absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-md border border-border bg-card/95 px-2.5 py-1.5 text-xs text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur-xl"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <span className="size-2 rounded-full bg-primary" />
      <span className="font-medium">Select an image on the canvas to use as reference.</span>
      <button
        type="button"
        aria-label="Exit canvas reference picking"
        className="ml-1 grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
        onClick={onCancel}
      >
        <X size={13} strokeWidth={1.85} />
      </button>
    </motion.div>
  );
}

function FloatingCanvasSurface({
  appRef,
  hostRef,
  selectedIds,
  anchor,
  placement,
  avoidOccluders = true,
  allowSidePlacement = false,
  children,
}: {
  appRef: RefObject<any>;
  hostRef: RefObject<HTMLDivElement | null>;
  selectedIds: string[];
  anchor?: FloatingRect | null;
  placement: "top" | "bottom";
  avoidOccluders?: boolean;
  allowSidePlacement?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selectedIdsRef = useRef(selectedIds);
  const anchorRef = useRef(anchor);
  const layoutRef = useRef<FloatingLayoutSnapshot | null>(null);
  const updateRef = useRef<((reason?: FloatingPositionReason) => void) | null>(null);
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
      if (!isFloatingAnchorVisible(nextAnchor, layout.containerWidth, layout.containerHeight)) {
        element.style.display = "none";
        element.style.visibility = "hidden";
        return;
      }
      const next = resolveFloatingChromeRect({
        anchor: nextAnchor,
        containerWidth: layout.containerWidth,
        containerHeight: layout.containerHeight,
        surfaceWidth: layout.surfaceWidth,
        surfaceHeight: layout.surfaceHeight,
        placement,
        occluders: layout.occluders,
        allowSidePlacement,
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
  }, [allowSidePlacement, appRef, avoidOccluders, hostRef, placement]);

  useLayoutEffect(() => {
    updateRef.current?.("viewport");
  }, [anchorKey]);

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute left-0 top-0 z-10 will-change-transform"
      style={{ visibility: "hidden" }}
    >
      {children}
    </div>
  );
}

function isFloatingAnchorVisible(anchor: FloatingRect, containerWidth: number, containerHeight: number): boolean {
  const targetLeft = anchor.targetLeft ?? anchor.left;
  const targetRight = anchor.targetRight ?? anchor.left;
  const left = Math.min(targetLeft, targetRight);
  const right = Math.max(targetLeft, targetRight);
  return right > 0 && left < containerWidth && anchor.bottom > 0 && anchor.top < containerHeight;
}

function floatingRectKey(rect: FloatingRect | null | undefined): string {
  if (!rect) return "";
  return [rect.left, rect.top, rect.bottom, rect.targetLeft ?? rect.left, rect.targetRight ?? rect.left]
    .map((value) => Math.round(value * 10) / 10)
    .join(":");
}

function getFloatingOccluders(container: HTMLElement, current: HTMLElement): CanvasRect[] {
  return collectFloatingOccluderRects(container, container.closest("[data-moodboard-canvas-root]") ?? container, current);
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
    const rawBounds = hasUsableFloatingFrameBounds(frame) ? frame : frame.boxBounds ?? frame;
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
        .sort((a, b) => renderZIndex(a) - renderZIndex(b))
        .map((node) => (
          <MoodboardCanvasNode key={node.id} node={node} />
        ))}
    </LeaferFrame>
  );
});

function renderZIndex(node: MoodboardNode): number {
  return node.type === "section" ? Math.min(node.zIndex ?? -1, -1) : (node.zIndex ?? 0);
}
