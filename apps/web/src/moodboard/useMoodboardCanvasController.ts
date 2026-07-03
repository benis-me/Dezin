import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { ImageGenerationParams, MoodboardAsset, MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import type { ImageActionModelField } from "../lib/image-action-defaults.ts";
import {
  allMoodboardNodeIds,
  buildLayerTree,
  isNodeLocked,
  isNodeVisible,
  isEditableShortcutTarget,
  isResetZoomShortcut,
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
import type { MoodboardCanvasTopbarControls } from "./MoodboardCanvasTopbar.tsx";
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
import { buildPastedNodeInputs, classifyClipboardPaste } from "./moodboard-clipboard.ts";
import { readMoodboardClipboardContent, writeMoodboardNodesToClipboard } from "./moodboard-clipboard-io.ts";

export interface MoodboardCanvasProps {
  viewKey?: string;
  nodes: MoodboardNode[];
  selectedIds: string[];
  busy?: boolean;
  imageModels?: string[];
  imageModel?: string;
  imageProviderId?: string;
  imageActionModels?: Partial<Record<ImageActionModelField, string>>;
  moodboardAssets?: MoodboardAsset[];
  onImageModelChange?: (model: string) => void;
  onConfigureImageActionModel?: (action: string) => void;
  onSelectIds: (ids: string[]) => void;
  onNodesChange: (nodes: SaveMoodboardNodeInput[]) => void;
  onAddNote: (point?: { x: number; y: number }) => void;
  onAddSection: (point?: { x: number; y: number; width?: number; height?: number }) => void;
  onAddImageGenerator: (point?: { x: number; y: number }, data?: Record<string, unknown>) => string | void;
  onUploadFiles: (files: FileList | File[] | null, point?: { x: number; y: number }) => void;
  onUploadReferenceFiles?: (files: FileList | File[] | null) => Promise<MoodboardAsset[]>;
  referencePickActive?: boolean;
  onReferenceNodePick?: (node: MoodboardNode) => void;
  onGenerateImage: (
    node: MoodboardNode,
    prompt: string,
    options?: { sourceAssetId?: string; referenceAssetIds?: string[]; params?: ImageGenerationParams },
  ) => Promise<void>;
  onSendToAgent?: (nodes: MoodboardNode[]) => void;
  onSetCoverImage?: (node: MoodboardNode) => void | Promise<void>;
  onTopbarControlsChange?: (controls: MoodboardCanvasTopbarControls | null) => void;
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
  referencePickActive = false,
  onReferenceNodePick,
  viewKey,
}: MoodboardCanvasProps) {
  const [tool, setTool] = useState<MoodboardCanvasTool>("select");
  const [layersOpen, setLayersOpen] = useState(() => readInitialLayersOpen());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [collapsedLayerIds, setCollapsedLayerIds] = useState<Set<string>>(() => new Set());
  const [draftInputs, setDraftInputs] = useState<SaveMoodboardNodeInput[] | null>(null);
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
  const referencePickActiveRef = useRef(referencePickActive);
  const onReferenceNodePickRef = useRef(onReferenceNodePick);
  const clipboardRef = useRef<SaveMoodboardNodeInput[]>([]);
  const historyRef = useRef<MoodboardHistoryState>({ undoStack: [], redoStack: [] });
  const temporaryHandToolRef = useRef<MoodboardCanvasTool | null>(null);
  const initialFitViewKeyRef = useRef<string | null>(null);
  const syncNodeInputsInRuntimeRef = useRef<(inputs: SaveMoodboardNodeInput[], idsToReselect?: string[]) => void>(() => {});
  const refreshSelectionInRuntimeRef = useRef<(ids?: string[]) => void>(() => {});
  const selectIdsInRuntimeRef = useRef<(ids: string[]) => void>(() => {});

  useEffect(() => {
    nodesRef.current = nodes;
    currentInputsRef.current = cloneMoodboardNodeInputs(nodes.map(toInput));
    setDraftInputs(null);
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
    referencePickActiveRef.current = referencePickActive;
    onReferenceNodePickRef.current = onReferenceNodePick;
  }, [onAddImageGenerator, onAddNote, onAddSection, onNodesChange, onReferenceNodePick, onSelectIds, onUploadFiles, referencePickActive]);

  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const displayNodes = useMemo(() => mergeDraftMoodboardNodes(nodes, draftInputs), [draftInputs, nodes]);
  const selected = useMemo(() => (selectedId ? displayNodes.find((node) => node.id === selectedId) ?? null : null), [displayNodes, selectedId]);
  const selectedNodes = useMemo(() => {
    const byId = new Map(displayNodes.map((node) => [node.id, node]));
    return selectedIds.map((id) => byId.get(id)).filter((node): node is MoodboardNode => Boolean(node));
  }, [displayNodes, selectedIds]);
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
    const nextInputs = cloneMoodboardNodeInputs(nextSnapshot.nodes);
    const nextSelectedIds = commitSelectionIds(
      nextSnapshot.selectedIds,
      nextInputs.map((node) => node.id),
    );
    currentInputsRef.current = nextInputs;
    nodesRef.current = moodboardNodesFromInputs(nodesRef.current, nextInputs);
    onNodesChangeRef.current(nextInputs);
    syncNodeInputsInRuntimeRef.current(nextInputs, nextSelectedIds);
    window.requestAnimationFrame(() => syncNodeInputsInRuntimeRef.current(nextInputs, nextSelectedIds));
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
    const nextInputs = cloneMoodboardNodeInputs(next);
    currentInputsRef.current = nextInputs;
    nodesRef.current = moodboardNodesFromInputs(nodesRef.current, nextInputs);
    onNodesChangeRef.current(nextInputs);
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
    if (referencePickActiveRef.current) {
      setContextMenu(null);
      const candidateId = ids.length === 1 ? ids[0] : null;
      const candidate = candidateId ? nodesRef.current.find((node) => node.id === candidateId) : null;
      if (candidate?.type === "image") onReferenceNodePickRef.current?.(candidate);
      window.requestAnimationFrame(() => refreshSelectionInRuntimeRef.current(selectedIdsRef.current));
      return selectedIdsRef.current;
    }
    return commitSelectionIds(ids);
  }, [commitSelectionIds]);

  const handleSelect = useCallback(
    (id: string | null) => {
      return handleSelectIds(id ? [id] : []);
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
    const matched = nodesRef.current.filter((node) => targetIds.has(node.id));
    clipboardRef.current = matched.map(toInput);
    void writeMoodboardNodesToClipboard(matched[0]?.boardId ?? "", clipboardRef.current);
  }, []);

  const copySelectedNodes = useCallback(() => {
    copyNodes(selectedIdsRef.current);
  }, [copyNodes]);

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
    (point?: { x: number; y: number }, data?: Record<string, unknown>) => {
      recordHistory();
      const createdId = onAddImageGeneratorRef.current(point, data);
      if (typeof createdId === "string" && createdId.trim()) {
        const nextIds = commitSelectionIds([createdId], [...nodesRef.current.map((node) => node.id), createdId]);
        selectIdsInRuntimeRef.current(nextIds);
        window.requestAnimationFrame(() => refreshSelectionInRuntimeRef.current(nextIds));
      }
      setContextMenu(null);
    },
    [commitSelectionIds, recordHistory],
  );

  const uploadFiles = useCallback(
    (files: FileList | File[] | null, point?: { x: number; y: number }) => {
      if (files?.length) recordHistory();
      onUploadFilesRef.current(files, point);
    },
    [recordHistory],
  );

  const pasteNodeInputs = useCallback(
    (inputs: SaveMoodboardNodeInput[], point?: { x: number; y: number }) => {
      if (inputs.length === 0) return false;
      const current = nodesRef.current;
      const startZIndex = Math.max(0, ...current.map((node) => node.zIndex ?? 0)) + 1;
      const copies = buildPastedNodeInputs(inputs, { point, startZIndex, createId: localId });
      saveInputs([...current.map(toInput), ...copies]);
      handleSelectIds(copies.map((node) => node.id));
      setContextMenu(null);
      return true;
    },
    [handleSelectIds, saveInputs],
  );

  const pasteCopiedNodes = useCallback(
    (point?: { x: number; y: number }) => pasteNodeInputs(clipboardRef.current, point),
    [pasteNodeInputs],
  );

  const applyClipboardPaste = useCallback(
    (content: { text?: string | null; files?: File[] | null }, point?: { x: number; y: number }) => {
      const result = classifyClipboardPaste(content);
      if (result.kind === "nodes") return pasteNodeInputs(result.nodes, point);
      if (result.kind === "images") {
        uploadFiles(result.files, point);
        setContextMenu(null);
        return true;
      }
      return false;
    },
    [pasteNodeInputs, uploadFiles],
  );

  const pasteFromSystemClipboard = useCallback(
    async (point?: { x: number; y: number }) => {
      const content = await readMoodboardClipboardContent();
      if (content && applyClipboardPaste(content, point)) return;
      pasteCopiedNodes(point);
    },
    [applyClipboardPaste, pasteCopiedNodes],
  );

  const handleBlankTap = useCallback((point: { x: number; y: number }) => {
    setContextMenu(null);
    if (referencePickActiveRef.current) {
      window.requestAnimationFrame(() => refreshSelectionInRuntimeRef.current(selectedIdsRef.current));
      return;
    }
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
    onFrameStateDraftChange: setDraftInputs,
  });
  syncNodeInputsInRuntimeRef.current = runtime.syncNodeInputsInRuntime;
  refreshSelectionInRuntimeRef.current = runtime.refreshSelectionInRuntime;
  const { changeZoom, fitView, getLastCanvasPoint, hoverInRuntime, runtimeReady, selectIdsInRuntime, zoom } = runtime;
  selectIdsInRuntimeRef.current = selectIdsInRuntime;
  const initialFitViewKey = viewKey ?? "default";

  useEffect(() => {
    if (!runtimeReady || nodes.length === 0 || initialFitViewKeyRef.current === initialFitViewKey) return;
    const frame = window.requestAnimationFrame(() => {
      initialFitViewKeyRef.current = initialFitViewKey;
      fitView();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitView, initialFitViewKey, nodes.length, runtimeReady]);

  const upload = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    uploadFiles(event.target.files);
    event.currentTarget.value = "";
  }, [uploadFiles]);

  const selectLayer = useCallback(
    (id: string) => {
      const nextIds = handleSelect(id);
      selectIdsInRuntime(nextIds);
    },
    [handleSelect, selectIdsInRuntime],
  );

  const selectLayers = useCallback(
    (ids: string[]) => {
      const nextIds = handleSelectIds(ids);
      selectIdsInRuntime(nextIds);
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
        // Paste (Cmd/Ctrl+V) is handled by the document "paste" listener below so it can
        // also read images and node payloads copied from other apps.
        if (key === "d") {
          if (selectedIdsRef.current.length === 0) return;
          event.preventDefault();
          duplicateNodes(selectedIdsRef.current);
          return;
        }
        if (isResetZoomShortcut(event)) {
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
    const releaseTemporaryHand = () => {
      if (temporaryHandToolRef.current == null) return;
      const restoreTool = temporaryHandToolRef.current;
      temporaryHandToolRef.current = null;
      if (toolRef.current === "hand") setTool(restoreTool);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isTemporaryHandShortcut(event) || temporaryHandToolRef.current == null) return;
      event.preventDefault();
      releaseTemporaryHand();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") releaseTemporaryHand();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableShortcutTarget(event.target)) return;
      const data = event.clipboardData;
      if (!data) return;
      const files = Array.from(data.files ?? []);
      if (files.length === 0 && data.items) {
        for (const item of Array.from(data.items)) {
          if (item.kind !== "file") continue;
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (applyClipboardPaste({ text: data.getData("text/plain"), files }, getLastCanvasPoint() ?? undefined)) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseTemporaryHand);
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseTemporaryHand);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("paste", onPaste);
    };
  }, [applyClipboardPaste, bringNodesToFront, changeZoom, contextMenu, copySelectedNodes, deleteNodes, duplicateNodes, fitView, getLastCanvasPoint, moveNodesLayerStep, nudgeNodes, redoCanvas, selectLayers, sendNodesToBack, undoCanvas, zoom]);

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
    pasteFromSystemClipboard,
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

export function mergeDraftMoodboardNodes(nodes: MoodboardNode[], draftInputs: SaveMoodboardNodeInput[] | null): MoodboardNode[] {
  if (!draftInputs?.length) return nodes;
  const draftById = new Map(draftInputs.filter((input) => input.id).map((input) => [input.id, input]));
  return nodes.map((node) => {
    const draft = draftById.get(node.id);
    if (!draft) return node;
    return {
      ...node,
      type: draft.type,
      x: draft.x,
      y: draft.y,
      width: draft.width,
      height: draft.height,
      rotation: draft.rotation ?? 0,
      zIndex: draft.zIndex ?? node.zIndex,
      data: draft.data ?? node.data,
    };
  });
}

function cloneMoodboardNodeInputs(inputs: SaveMoodboardNodeInput[]): SaveMoodboardNodeInput[] {
  return inputs.map((node) => ({ ...node, data: { ...node.data } }));
}

function moodboardNodesFromInputs(currentNodes: MoodboardNode[], inputs: SaveMoodboardNodeInput[]): MoodboardNode[] {
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));
  const fallback = currentNodes[0] ?? null;
  const now = Date.now();
  return inputs
    .filter((input): input is SaveMoodboardNodeInput & { id: string } => Boolean(input.id))
    .map((input, index) => {
      const current = currentById.get(input.id);
      const createdAt = current?.createdAt ?? now + index;
      return {
        id: input.id,
        boardId: current?.boardId ?? fallback?.boardId ?? "",
        type: input.type,
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        rotation: input.rotation ?? current?.rotation ?? 0,
        zIndex: input.zIndex ?? current?.zIndex ?? 0,
        data: input.data ? { ...input.data } : current?.data ? { ...current.data } : {},
        createdAt,
        updatedAt: current?.updatedAt ?? createdAt,
      };
    });
}
