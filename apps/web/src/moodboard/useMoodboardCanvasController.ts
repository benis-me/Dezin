import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import {
  buildLayerTree,
  isNodeLocked,
  isNodeVisible,
  localId,
  MOODBOARD_LAYERS_OPEN_KEY,
  readInitialLayersOpen,
  reorderLayerInputs,
  toInput,
  type ContextMenuState,
  type MoodboardCanvasTool,
} from "./canvas-utils.ts";
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
  const selectedIdsRef = useRef(selectedIds);
  const toolRef = useRef(tool);
  const onSelectIdsRef = useRef(onSelectIds);
  const onNodesChangeRef = useRef(onNodesChange);
  const onAddNoteRef = useRef(onAddNote);
  const onAddSectionRef = useRef(onAddSection);
  const onAddImageGeneratorRef = useRef(onAddImageGenerator);
  const onUploadFilesRef = useRef(onUploadFiles);

  useEffect(() => {
    nodesRef.current = nodes;
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

  const saveInputs = useCallback((next: SaveMoodboardNodeInput[]) => onNodesChangeRef.current(next), []);

  const patchNode = useCallback(
    (id: string, patch: Partial<SaveMoodboardNodeInput>) => {
      saveInputs(nodesRef.current.map((node) => (node.id === id ? { ...toInput(node), ...patch, data: patch.data ?? node.data } : toInput(node))));
    },
    [saveInputs],
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
    const existing = new Set(nodesRef.current.map((node) => node.id));
    const nextIds = ids.filter((id, index) => existing.has(id) && ids.indexOf(id) === index);
    setContextMenu(null);
    selectedIdsRef.current = nextIds;
    onSelectIdsRef.current(nextIds);
  }, []);

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

  const bringNodesToFront = useCallback(
    (ids: string[]) => {
      const current = nodesRef.current;
      const byId = new Set(current.map((node) => node.id));
      const targetIds = ids.filter((id, index) => byId.has(id) && ids.indexOf(id) === index);
      if (targetIds.length === 0) return;

      let nextZIndex = Math.max(0, ...current.map((item) => item.zIndex ?? 0)) + 1;
      const zIndexById = new Map(targetIds.map((id) => [id, nextZIndex++]));
      saveInputs(current.map((node) => (zIndexById.has(node.id) ? { ...toInput(node), zIndex: zIndexById.get(node.id) } : toInput(node))));
      setContextMenu(null);
    },
    [saveInputs],
  );

  const sendNodesToBack = useCallback(
    (ids: string[]) => {
      const current = nodesRef.current;
      const byId = new Set(current.map((node) => node.id));
      const targetIds = ids.filter((id, index) => byId.has(id) && ids.indexOf(id) === index);
      if (targetIds.length === 0) return;

      let nextZIndex = Math.min(0, ...current.map((item) => item.zIndex ?? 0)) - targetIds.length;
      const zIndexById = new Map(targetIds.map((id) => [id, nextZIndex++]));
      saveInputs(current.map((node) => (zIndexById.has(node.id) ? { ...toInput(node), zIndex: zIndexById.get(node.id) } : toInput(node))));
      setContextMenu(null);
    },
    [saveInputs],
  );

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

  const handleBlankTap = useCallback((point: { x: number; y: number }) => {
    setContextMenu(null);
    if (toolRef.current === "note") {
      onAddNoteRef.current(point);
      setTool("select");
      return;
    }
    if (toolRef.current === "section") {
      onAddSectionRef.current(point);
      setTool("select");
      return;
    }
    handleSelectIds([]);
  }, [handleSelectIds]);

  const runtime = useLeaferMoodboardRuntime({
    nodes,
    selectedIds,
    tool,
    onSelectIds: handleSelectIds,
    onBlankTap: handleBlankTap,
    onSectionDraw: (rect) => {
      onAddSectionRef.current(rect);
      setTool("select");
    },
    onDoubleTap: (point) => onAddImageGeneratorRef.current(point),
    onContextMenu: setContextMenu,
    onFrameStateChange: saveInputs,
  });
  const { changeZoom, fitView, hoverInRuntime, selectIdsInRuntime, selectInRuntime, zoom } = runtime;

  const upload = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    onUploadFilesRef.current(event.target.files);
    event.currentTarget.value = "";
  }, []);

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
      const tag = (event.target as HTMLElement | null)?.tagName;
      const editing = tag === "INPUT" || tag === "TEXTAREA" || (event.target as HTMLElement | null)?.isContentEditable;
      if (editing) return;

      if (event.shiftKey && event.key === "1") {
        event.preventDefault();
        fitView();
        return;
      }
      if (event.metaKey || event.ctrlKey) {
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
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "v") setTool("select");
        if (key === "h") setTool("hand");
        if (key === "n") setTool("note");
        if (key === "f") setTool("section");
        if (key === "l") setLayersOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changeZoom, contextMenu, deleteNodes, fitView, selectLayers, zoom]);

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
    bringToFront,
    bringNodesToFront,
    sendToBack,
    sendNodesToBack,
    setNodesVisible,
    setNodesLocked,
    renameNode,
    toggleNodeVisible,
    toggleNodeLocked,
    toggleLayerCollapsed,
    selectLayer,
    selectLayers,
    reorderLayer,
  };
}
