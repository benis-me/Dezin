import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import {
  allMoodboardNodeIds,
  buildLayerTree,
  isNodeLocked,
  isNodeVisible,
  isEditableShortcutTarget,
  isTemporaryHandShortcut,
  localId,
  MOODBOARD_LAYERS_OPEN_KEY,
  moveContainedNodesWithSections,
  nudgeNodeInputs,
  readInitialLayersOpen,
  reorderLayerInputs,
  toInput,
  type ContextMenuState,
  type MoodboardAlignType,
  type MoodboardCanvasTool,
} from "./canvas-utils.ts";
import {
  cloneMoodboardSnapshot,
  createMoodboardHistorySnapshot,
  pushMoodboardUndo,
  redoMoodboardHistory,
  sameMoodboardNodeInputs,
  undoMoodboardHistory,
  uniqueExistingIds,
  type MoodboardHistoryState,
  type MoodboardHistorySnapshot,
} from "./canvas-history.ts";
import { useLeaferMoodboardRuntime } from "./useLeaferMoodboardRuntime.ts";

export interface MoodboardCanvasProps {
  nodes: MoodboardNode[];
  selectedIds: string[];
  busy?: boolean;
  imageModels?: string[];
  imageModel?: string;
  onImageModelChange?: (model: string) => void;
  onSelectIds: (ids: string[]) => void;
  onNodesChange: (nodes: SaveMoodboardNodeInput[]) => void;
  onAddNote: (point?: { x: number; y: number }) => void;
  onAddSection: (point?: { x: number; y: number; width?: number; height?: number }) => void;
  onAddImageGenerator: (point?: { x: number; y: number }) => void;
  onUploadFiles: (files: FileList | null) => void;
  onGenerateImage: (node: MoodboardNode, prompt: string) => Promise<void>;
}

export function useMoodboardCanvasController({
  nodes,
  selectedIds,
  onSelectIds,
  onNodesChange,
  onAddNote,
  onAddSection,
  onAddImageGenerator,
  onUploadFiles,
}: MoodboardCanvasProps) {
  const [tool, setTool] = useState<MoodboardCanvasTool>("select");
  const [layersOpen, setLayersOpen] = useState(() => readInitialLayersOpen());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [collapsedLayerIds, setCollapsedLayerIds] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const nodesRef = useRef(nodes);
  const currentInputsRef = useRef(nodes.map(toInput));
  const selectedIdsRef = useRef(selectedIds);
  const toolRef = useRef(tool);
  const onSelectIdsRef = useRef(onSelectIds);
  const onNodesChangeRef = useRef(onNodesChange);
  const onAddNoteRef = useRef(onAddNote);
  const onAddSectionRef = useRef(onAddSection);
  const onAddImageGeneratorRef = useRef(onAddImageGenerator);
  const onUploadFilesRef = useRef(onUploadFiles);
  const clipboardRef = useRef<SaveMoodboardNodeInput[]>([]);
  const historyRef = useRef<MoodboardHistoryState>({ undoStack: [], redoStack: [] });
  const temporaryHandToolRef = useRef<MoodboardCanvasTool | null>(null);
  const syncNodeInputsInRuntimeRef = useRef<(inputs: SaveMoodboardNodeInput[], idsToReselect?: string[]) => void>(() => {});
  const refreshSelectionInRuntimeRef = useRef<(ids?: string[]) => void>(() => {});

  useEffect(() => {
    nodesRef.current = nodes;
    currentInputsRef.current = nodes.map(toInput);
  }, [nodes]);

  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    localStorage.setItem(MOODBOARD_LAYERS_OPEN_KEY, layersOpen ? "1" : "0");
  }, [layersOpen]);

  useEffect(() => {
    onSelectIdsRef.current = onSelectIds;
    onNodesChangeRef.current = onNodesChange;
    onAddNoteRef.current = onAddNote;
    onAddSectionRef.current = onAddSection;
    onAddImageGeneratorRef.current = onAddImageGenerator;
    onUploadFilesRef.current = onUploadFiles;
  }, [onAddImageGenerator, onAddNote, onAddSection, onNodesChange, onSelectIds, onUploadFiles]);

  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const selected = useMemo(() => (selectedId ? nodes.find((node) => node.id === selectedId) ?? null : null), [nodes, selectedId]);
  const selectedNodes = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return selectedIds.map((id) => byId.get(id)).filter((node): node is MoodboardNode => Boolean(node));
  }, [nodes, selectedIds]);
  const layerTree = useMemo(() => buildLayerTree(nodes), [nodes]);

  const currentSnapshot = useCallback(
    (): MoodboardHistorySnapshot => createMoodboardHistorySnapshot(currentInputsRef.current, selectedIdsRef.current),
    [],
  );

  const recordHistory = useCallback(() => {
    historyRef.current = pushMoodboardUndo(historyRef.current, currentSnapshot());
  }, [currentSnapshot]);

  const commitSelectionIds = useCallback((ids: string[], existingIds?: Array<string | undefined>) => {
    const nextIds = uniqueExistingIds(ids, existingIds ?? nodesRef.current.map((node) => node.id));
    setContextMenu(null);
    selectedIdsRef.current = nextIds;
    onSelectIdsRef.current(nextIds);
    return nextIds;
  }, []);

  const restoreHistorySnapshot = useCallback((snapshot: MoodboardHistorySnapshot) => {
    const nextSnapshot = cloneMoodboardSnapshot(snapshot);
    const nextSelectedIds = commitSelectionIds(
      nextSnapshot.selectedIds,
      nextSnapshot.nodes.map((node) => node.id),
    );
    currentInputsRef.current = nextSnapshot.nodes;
    onNodesChangeRef.current(nextSnapshot.nodes);
    syncNodeInputsInRuntimeRef.current(nextSnapshot.nodes, nextSelectedIds);
    window.requestAnimationFrame(() => syncNodeInputsInRuntimeRef.current(nextSnapshot.nodes, nextSelectedIds));
  }, [commitSelectionIds]);

  const undoCanvas = useCallback(() => {
    const result = undoMoodboardHistory(historyRef.current, currentSnapshot());
    if (!result.snapshot) return false;
    historyRef.current = result.state;
    restoreHistorySnapshot(result.snapshot);
    return true;
  }, [currentSnapshot, restoreHistorySnapshot]);

  const redoCanvas = useCallback(() => {
    const result = redoMoodboardHistory(historyRef.current, currentSnapshot());
    if (!result.snapshot) return false;
    historyRef.current = result.state;
    restoreHistorySnapshot(result.snapshot);
    return true;
  }, [currentSnapshot, restoreHistorySnapshot]);

  const saveInputs = useCallback((next: SaveMoodboardNodeInput[], options: { recordHistory?: boolean } = {}) => {
    const current = currentInputsRef.current;
    if (options.recordHistory !== false && !sameMoodboardNodeInputs(current, next)) {
      historyRef.current = pushMoodboardUndo(historyRef.current, createMoodboardHistorySnapshot(current, selectedIdsRef.current));
    }
    currentInputsRef.current = next.map((node) => ({ ...node, data: { ...node.data } }));
    onNodesChangeRef.current(next);
  }, []);

  const syncInputsAndSelectionInRuntime = useCallback((inputs: SaveMoodboardNodeInput[], idsToReselect: string[]) => {
    syncNodeInputsInRuntimeRef.current(inputs, idsToReselect);
    window.requestAnimationFrame(() => {
      syncNodeInputsInRuntimeRef.current(inputs, idsToReselect);
      refreshSelectionInRuntimeRef.current(idsToReselect);
    });
  }, []);

  const patchNode = useCallback(
    (id: string, patch: Partial<SaveMoodboardNodeInput>) => {
      const next = nodesRef.current.map((node) => (node.id === id ? { ...toInput(node), ...patch, data: patch.data ?? node.data } : toInput(node)));
      saveInputs(next);
      if (affectsRuntimeGeometry(patch)) syncInputsAndSelectionInRuntime(next, selectedIdsRef.current);
    },
    [saveInputs, syncInputsAndSelectionInRuntime],
  );

  const patchNodeData = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      const node = nodesRef.current.find((item) => item.id === id);
      if (!node) return;
      patchNode(id, { data: { ...node.data, ...patch } });
    },
    [patchNode],
  );

  const patchSelectedData = useCallback(
    (patch: Record<string, unknown>) => {
      const selectedId = selectedIdsRef.current.length === 1 ? selectedIdsRef.current[0] : null;
      const node = selectedId ? nodesRef.current.find((item) => item.id === selectedId) : null;
      if (!node) return;
      patchNode(node.id, { data: { ...node.data, ...patch } });
    },
    [patchNode],
  );

  const handleSelectIds = useCallback((ids: string[]) => {
    commitSelectionIds(ids);
  }, [commitSelectionIds]);

  const handleSelect = useCallback(
    (id: string | null) => {
      handleSelectIds(id ? [id] : []);
    },
    [handleSelectIds],
  );

  const deleteNodes = useCallback(
    (ids: string[]) => {
      const targetIds = new Set(ids);
      if (targetIds.size === 0) return;
      saveInputs(nodesRef.current.filter((node) => !targetIds.has(node.id)).map(toInput));
      handleSelectIds([]);
      setContextMenu(null);
    },
    [handleSelectIds, saveInputs],
  );

  const deleteNode = useCallback(
    (id: string) => {
      deleteNodes([id]);
    },
    [deleteNodes],
  );

  const duplicateNodes = useCallback(
    (ids: string[]) => {
      const current = nodesRef.current;
      const byId = new Map(current.map((node) => [node.id, node]));
      const targetIds = ids.filter((id, index) => byId.has(id) && ids.indexOf(id) === index);
      if (targetIds.length === 0) return;

      let nextZIndex = Math.max(0, ...current.map((item) => item.zIndex ?? 0)) + 1;
      const copies: Array<SaveMoodboardNodeInput & { id: string }> = targetIds.map((id) => {
        const node = byId.get(id)!;
        return {
          ...toInput(node),
          id: localId(),
          x: node.x + 28,
          y: node.y + 28,
          zIndex: nextZIndex++,
          data: { ...node.data },
        };
      });

      saveInputs([...current.map(toInput), ...copies]);
      handleSelectIds(copies.map((node) => node.id));
      setContextMenu(null);
    },
    [handleSelectIds, saveInputs],
  );

  const duplicateNode = useCallback(
    (id: string) => {
      duplicateNodes([id]);
    },
    [duplicateNodes],
  );

  const nudgeNodes = useCallback(
    (ids: string[], delta: { x: number; y: number }) => {
      const current = nodesRef.current;
      const targetIds = new Set(ids);
      if (targetIds.size === 0) return;
      const targets = current.filter((node) => targetIds.has(node.id));
      if (targets.length === 0) return;

      const moved = nudgeNodeInputs(current, ids, delta);
      syncInputsAndSelectionInRuntime(moved, targets.map((node) => node.id));
      saveInputs(moved);
      setContextMenu(null);
    },
    [saveInputs, syncInputsAndSelectionInRuntime],
  );

  const bringNodesToFront = useCallback(
    (ids: string[]) => {
      const current = nodesRef.current;
      const byId = new Set(current.map((node) => node.id));
      const targetIds = ids.filter((id, index) => byId.has(id) && ids.indexOf(id) === index);
      if (targetIds.length === 0) return;

      let nextZIndex = Math.max(0, ...current.map((item) => item.zIndex ?? 0)) + 1;
      const zIndexById = new Map(targetIds.map((id) => [id, nextZIndex++]));
      const next = current.map((node) => (zIndexById.has(node.id) ? { ...toInput(node), zIndex: zIndexById.get(node.id) } : toInput(node)));
      saveInputs(next);
      syncInputsAndSelectionInRuntime(next, selectedIdsRef.current);
      setContextMenu(null);
    },
    [saveInputs, syncInputsAndSelectionInRuntime],
  );

  const sendNodesToBack = useCallback(
    (ids: string[]) => {
      const current = nodesRef.current;
      const byId = new Set(current.map((node) => node.id));
      const targetIds = ids.filter((id, index) => byId.has(id) && ids.indexOf(id) === index);
      if (targetIds.length === 0) return;

      let nextZIndex = Math.min(0, ...current.map((item) => item.zIndex ?? 0)) - targetIds.length;
      const zIndexById = new Map(targetIds.map((id) => [id, nextZIndex++]));
      const next = current.map((node) => (zIndexById.has(node.id) ? { ...toInput(node), zIndex: zIndexById.get(node.id) } : toInput(node)));
      saveInputs(next);
      syncInputsAndSelectionInRuntime(next, selectedIdsRef.current);
      setContextMenu(null);
    },
    [saveInputs, syncInputsAndSelectionInRuntime],
  );

  const moveNodesLayerStep = useCallback(
    (ids: string[], direction: "up" | "down") => {
      const targetIds = new Set(ids);
      if (targetIds.size === 0) return;
      const ordered = [...nodesRef.current].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0) || a.createdAt - b.createdAt);
      if (direction === "up") {
        for (let index = ordered.length - 2; index >= 0; index--) {
          if (!targetIds.has(ordered[index]!.id) || targetIds.has(ordered[index + 1]!.id)) continue;
          [ordered[index], ordered[index + 1]] = [ordered[index + 1]!, ordered[index]!];
        }
      } else {
        for (let index = 1; index < ordered.length; index++) {
          if (!targetIds.has(ordered[index]!.id) || targetIds.has(ordered[index - 1]!.id)) continue;
          [ordered[index - 1], ordered[index]] = [ordered[index]!, ordered[index - 1]!];
        }
      }
      const zIndexById = new Map(ordered.map((node, index) => [node.id, index + 1]));
      const next = nodesRef.current.map((node) => ({ ...toInput(node), zIndex: zIndexById.get(node.id) ?? node.zIndex }));
      saveInputs(next);
      syncInputsAndSelectionInRuntime(next, selectedIdsRef.current);
      setContextMenu(null);
    },
    [saveInputs, syncInputsAndSelectionInRuntime],
  );

  const copyNodes = useCallback((ids: string[]) => {
    const targetIds = new Set(ids);
    clipboardRef.current = nodesRef.current.filter((node) => targetIds.has(node.id)).map(toInput);
  }, []);

  const copySelectedNodes = useCallback(() => {
    copyNodes(selectedIdsRef.current);
  }, [copyNodes]);

  const pasteCopiedNodes = useCallback((point?: { x: number; y: number }) => {
    if (clipboardRef.current.length === 0) return;
    const current = nodesRef.current;
    let nextZIndex = Math.max(0, ...current.map((node) => node.zIndex ?? 0)) + 1;
    const minX = Math.min(...clipboardRef.current.map((node) => node.x));
    const minY = Math.min(...clipboardRef.current.map((node) => node.y));
    const dx = point ? point.x - minX : 32;
    const dy = point ? point.y - minY : 32;
    const copies: Array<SaveMoodboardNodeInput & { id: string }> = clipboardRef.current.map((node) => ({
      ...node,
      id: localId(),
      x: Math.round(node.x + dx),
      y: Math.round(node.y + dy),
      zIndex: nextZIndex++,
      data: { ...node.data },
    }));
    saveInputs([...current.map(toInput), ...copies]);
    handleSelectIds(copies.map((node) => node.id));
    setContextMenu(null);
  }, [handleSelectIds, saveInputs]);

  const patchNodesData = useCallback(
    (ids: string[], patch: Record<string, unknown>) => {
      const targetIds = new Set(ids);
      if (targetIds.size === 0) return;
      saveInputs(nodesRef.current.map((node) => (targetIds.has(node.id) ? { ...toInput(node), data: { ...node.data, ...patch } } : toInput(node))));
      setContextMenu(null);
    },
    [saveInputs],
  );

  const setNodesVisible = useCallback(
    (ids: string[], visible: boolean) => {
      patchNodesData(ids, { visible });
    },
    [patchNodesData],
  );

  const setNodesLocked = useCallback(
    (ids: string[], locked: boolean) => {
      patchNodesData(ids, { locked });
    },
    [patchNodesData],
  );

  const alignNodes = useCallback(
    (ids: string[], type: MoodboardAlignType) => {
      const current = nodesRef.current;
      const byId = new Map(current.map((node) => [node.id, node]));
      const targets = ids.map((id) => byId.get(id)).filter((node): node is MoodboardNode => Boolean(node));
      if (targets.length < 2) return;

      const bounds = targets.map((node) => ({
        id: node.id,
        left: node.x,
        right: node.x + node.width,
        top: node.y,
        bottom: node.y + node.height,
        centerX: node.x + node.width / 2,
        centerY: node.y + node.height / 2,
        width: node.width,
        height: node.height,
      }));
      const target =
        type === "left"
          ? Math.min(...bounds.map((bound) => bound.left))
          : type === "center-v"
            ? bounds.reduce((sum, bound) => sum + bound.centerX, 0) / bounds.length
            : type === "right"
              ? Math.max(...bounds.map((bound) => bound.right))
              : type === "top"
                ? Math.min(...bounds.map((bound) => bound.top))
                : type === "center-h"
                  ? bounds.reduce((sum, bound) => sum + bound.centerY, 0) / bounds.length
                  : Math.max(...bounds.map((bound) => bound.bottom));
      const positionById = new Map(
        targets.map((node, index) => {
          const bound = bounds[index];
          const x = type === "left" ? target : type === "center-v" ? target - bound.width / 2 : type === "right" ? target - bound.width : node.x;
          const y = type === "top" ? target : type === "center-h" ? target - bound.height / 2 : type === "bottom" ? target - bound.height : node.y;
          return [node.id, { x, y }];
        }),
      );
      const next = current.map((node) => {
        const position = positionById.get(node.id);
        return position ? { ...toInput(node), x: Math.round(position.x), y: Math.round(position.y) } : toInput(node);
      });
      const moved = moveContainedNodesWithSections(current, next);
      saveInputs(moved);
      syncInputsAndSelectionInRuntime(moved, targets.map((node) => node.id));
      setContextMenu(null);
    },
    [saveInputs, syncInputsAndSelectionInRuntime],
  );

  const arrangeNodes = useCallback(
    (ids: string[]) => {
      const current = nodesRef.current;
      const byId = new Map(current.map((node) => [node.id, node]));
      const targets = ids.map((id) => byId.get(id)).filter((node): node is MoodboardNode => Boolean(node));
      if (targets.length < 2) return;

      const sorted = [...targets].sort((a, b) => a.y - b.y || a.x - b.x || a.createdAt - b.createdAt);
      const minX = Math.min(...sorted.map((node) => node.x));
      const minY = Math.min(...sorted.map((node) => node.y));
      const columnCount = Math.max(2, Math.ceil(Math.sqrt(sorted.length)));
      const gap = 24;
      let x = minX;
      let y = minY;
      let rowHeight = 0;
      const positionById = new Map<string, { x: number; y: number }>();

      sorted.forEach((node, index) => {
        if (index > 0 && index % columnCount === 0) {
          x = minX;
          y += rowHeight + gap;
          rowHeight = 0;
        }
        positionById.set(node.id, { x, y });
        x += node.width + gap;
        rowHeight = Math.max(rowHeight, node.height);
      });

      const next = current.map((node) => {
        const position = positionById.get(node.id);
        return position ? { ...toInput(node), x: Math.round(position.x), y: Math.round(position.y) } : toInput(node);
      });
      const moved = moveContainedNodesWithSections(current, next);
      saveInputs(moved);
      syncInputsAndSelectionInRuntime(moved, targets.map((node) => node.id));
      setContextMenu(null);
    },
    [saveInputs, syncInputsAndSelectionInRuntime],
  );

  const bringToFront = useCallback(
    (id: string) => {
      bringNodesToFront([id]);
    },
    [bringNodesToFront],
  );

  const sendToBack = useCallback(
    (id: string) => {
      sendNodesToBack([id]);
    },
    [sendNodesToBack],
  );

  const renameNode = useCallback(
    (id: string, name: string) => {
      patchNodeData(id, { name });
    },
    [patchNodeData],
  );

  const toggleNodeVisible = useCallback(
    (id: string) => {
      const node = nodesRef.current.find((item) => item.id === id);
      if (!node) return;
      setNodesVisible([id], !isNodeVisible(node));
    },
    [setNodesVisible],
  );

  const toggleNodeLocked = useCallback(
    (id: string) => {
      const node = nodesRef.current.find((item) => item.id === id);
      if (!node) return;
      setNodesLocked([id], !isNodeLocked(node));
    },
    [setNodesLocked],
  );

  const toggleLayerCollapsed = useCallback((id: string) => {
    setCollapsedLayerIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const addNoteAt = useCallback(
    (point?: { x: number; y: number }) => {
      recordHistory();
      onAddNoteRef.current(point);
      setContextMenu(null);
    },
    [recordHistory],
  );

  const addSectionAt = useCallback(
    (point?: { x: number; y: number; width?: number; height?: number }) => {
      recordHistory();
      onAddSectionRef.current(point);
      setContextMenu(null);
    },
    [recordHistory],
  );

  const addImageGeneratorAt = useCallback(
    (point?: { x: number; y: number }) => {
      recordHistory();
      onAddImageGeneratorRef.current(point);
      setContextMenu(null);
    },
    [recordHistory],
  );

  const uploadFiles = useCallback(
    (files: FileList | null) => {
      if (files?.length) recordHistory();
      onUploadFilesRef.current(files);
    },
    [recordHistory],
  );

  const handleBlankTap = useCallback((point: { x: number; y: number }) => {
    setContextMenu(null);
    if (toolRef.current === "note") {
      addNoteAt(point);
      setTool("select");
      return;
    }
    if (toolRef.current === "section") {
      addSectionAt(point);
      setTool("select");
      return;
    }
    handleSelectIds([]);
  }, [addNoteAt, addSectionAt, handleSelectIds]);

  const runtime = useLeaferMoodboardRuntime({
    nodes,
    selectedIds,
    tool,
    onSelectIds: handleSelectIds,
    onBlankTap: handleBlankTap,
    onSectionDraw: (rect) => {
      addSectionAt(rect);
      setTool("select");
    },
    onDoubleTap: (point) => addImageGeneratorAt(point),
    onContextMenu: setContextMenu,
    onFrameStateChange: saveInputs,
  });
  syncNodeInputsInRuntimeRef.current = runtime.syncNodeInputsInRuntime;
  refreshSelectionInRuntimeRef.current = runtime.refreshSelectionInRuntime;
  const { changeZoom, fitView, hoverInRuntime, selectIdsInRuntime, selectInRuntime, zoom } = runtime;

  const upload = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    uploadFiles(event.target.files);
    event.currentTarget.value = "";
  }, [uploadFiles]);

  const selectLayer = useCallback(
    (id: string) => {
      handleSelect(id);
      selectInRuntime(id);
    },
    [handleSelect, selectInRuntime],
  );

  const selectLayers = useCallback(
    (ids: string[]) => {
      handleSelectIds(ids);
      selectIdsInRuntime(ids);
    },
    [handleSelectIds, selectIdsInRuntime],
  );

  const reorderLayer = useCallback(
    (sourceId: string, targetId: string) => {
      saveInputs(reorderLayerInputs(nodesRef.current, sourceId, targetId));
      setContextMenu(null);
    },
    [saveInputs],
  );

  const hoverLayer = useCallback(
    (id: string | null) => {
      hoverInRuntime(id);
    },
    [hoverInRuntime],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditableShortcutTarget(event.target)) return;

      if (isTemporaryHandShortcut(event)) {
        event.preventDefault();
        if (!event.repeat && temporaryHandToolRef.current == null) {
          temporaryHandToolRef.current = toolRef.current;
          if (toolRef.current !== "hand") setTool("hand");
        }
        return;
      }

      if (event.shiftKey && event.key === "1") {
        event.preventDefault();
        fitView();
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();
        if (key === "z") {
          event.preventDefault();
          if (event.shiftKey) redoCanvas();
          else undoCanvas();
          return;
        }
        if (key === "y") {
          event.preventDefault();
          redoCanvas();
          return;
        }
        if (key === "a") {
          event.preventDefault();
          selectLayers(allMoodboardNodeIds(nodesRef.current));
          return;
        }
        if (key === "c") {
          if (selectedIdsRef.current.length === 0) return;
          event.preventDefault();
          copySelectedNodes();
          return;
        }
        if (key === "v") {
          if (clipboardRef.current.length === 0) return;
          event.preventDefault();
          pasteCopiedNodes();
          return;
        }
        if (key === "d") {
          if (selectedIdsRef.current.length === 0) return;
          event.preventDefault();
          duplicateNodes(selectedIdsRef.current);
          return;
        }
        if (event.key === "0") {
          event.preventDefault();
          changeZoom(1);
          return;
        }
        if (event.key === "=" || event.key === "+") {
          event.preventDefault();
          changeZoom(zoom * 1.14);
          return;
        }
        if (event.key === "-") {
          event.preventDefault();
          changeZoom(zoom * 0.88);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          moveNodesLayerStep(selectedIdsRef.current, "up");
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveNodesLayerStep(selectedIdsRef.current, "down");
          return;
        }
      }

      if (event.key === "Escape") {
        if (contextMenu) {
          setContextMenu(null);
        } else if (toolRef.current !== "select") {
          setTool("select");
        } else {
          selectLayers([]);
        }
      }
      if ((event.key === "Backspace" || event.key === "Delete") && selectedIdsRef.current.length > 0) {
        event.preventDefault();
        deleteNodes(selectedIdsRef.current);
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.startsWith("Arrow") && selectedIdsRef.current.length > 0) {
        const step = event.shiftKey ? 10 : 1;
        const delta =
          event.key === "ArrowLeft"
            ? { x: -step, y: 0 }
            : event.key === "ArrowRight"
              ? { x: step, y: 0 }
              : event.key === "ArrowUp"
                ? { x: 0, y: -step }
                : { x: 0, y: step };
        event.preventDefault();
        nudgeNodes(selectedIdsRef.current, delta);
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "v") setTool("select");
        if (key === "h") setTool("hand");
        if (key === "n" || key === "s") setTool("note");
        if (key === "f") setTool("section");
        if (key === "l") setLayersOpen((value) => !value);
        if (key === "]") bringNodesToFront(selectedIdsRef.current);
        if (key === "[") sendNodesToBack(selectedIdsRef.current);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isTemporaryHandShortcut(event) || temporaryHandToolRef.current == null) return;
      event.preventDefault();
      const restoreTool = temporaryHandToolRef.current;
      temporaryHandToolRef.current = null;
      if (toolRef.current === "hand") setTool(restoreTool);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [bringNodesToFront, changeZoom, contextMenu, copySelectedNodes, deleteNodes, duplicateNodes, fitView, moveNodesLayerStep, nudgeNodes, pasteCopiedNodes, redoCanvas, selectLayers, sendNodesToBack, undoCanvas, zoom]);

  const contextTargetId = contextMenu?.targetId ?? null;

  return {
    ...runtime,
    tool,
    layersOpen,
    contextMenu,
    contextTargetId,
    selectedIds,
    selected,
    selectedNodes,
    layerTree,
    inputRef,
    collapsedLayerIds,
    setTool,
    hoverLayer,
    setContextMenu,
    setLayersOpen,
    upload,
    patchNode,
    patchNodeData,
    patchSelectedData,
    deleteNode,
    deleteNodes,
    duplicateNode,
    duplicateNodes,
    nudgeNodes,
    copyNodes,
    copySelectedNodes,
    pasteCopiedNodes,
    bringToFront,
    bringNodesToFront,
    moveNodesLayerStep,
    sendToBack,
    sendNodesToBack,
    setNodesVisible,
    setNodesLocked,
    alignNodes,
    arrangeNodes,
    renameNode,
    toggleNodeVisible,
    toggleNodeLocked,
    toggleLayerCollapsed,
    recordHistory,
    addNoteAt,
    addSectionAt,
    addImageGeneratorAt,
    uploadFiles,
    selectLayer,
    selectLayers,
    reorderLayer,
  };
}

function affectsRuntimeGeometry(patch: Partial<SaveMoodboardNodeInput>): boolean {
  return "x" in patch || "y" in patch || "width" in patch || "height" in patch || "rotation" in patch || "zIndex" in patch;
}
