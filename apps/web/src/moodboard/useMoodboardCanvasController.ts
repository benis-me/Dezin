import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import {
  buildLayerTree,
  isNodeLocked,
  isNodeVisible,
  localId,
  toInput,
  type ContextMenuState,
  type MoodboardCanvasTool,
} from "./canvas-utils.ts";
import { useLeaferMoodboardRuntime } from "./useLeaferMoodboardRuntime.ts";

const LAYERS_OPEN_KEY = "dezin:moodboard:layers-open";

export interface MoodboardCanvasProps {
  nodes: MoodboardNode[];
  selectedId: string | null;
  busy?: boolean;
  onSelect: (id: string | null) => void;
  onNodesChange: (nodes: SaveMoodboardNodeInput[]) => void;
  onAddNote: (point?: { x: number; y: number }) => void;
  onAddSection: (point?: { x: number; y: number }) => void;
  onAddImageGenerator: (point?: { x: number; y: number }) => void;
  onUploadFiles: (files: FileList | null) => void;
  onGenerateImage: (node: MoodboardNode, prompt: string) => Promise<void>;
}

export function useMoodboardCanvasController({
  nodes,
  selectedId,
  onSelect,
  onNodesChange,
  onAddNote,
  onAddSection,
  onAddImageGenerator,
  onUploadFiles,
}: MoodboardCanvasProps) {
  const [tool, setTool] = useState<MoodboardCanvasTool>("select");
  const [layersOpen, setLayersOpen] = useState(() => localStorage.getItem(LAYERS_OPEN_KEY) !== "0");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [collapsedLayerIds, setCollapsedLayerIds] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const nodesRef = useRef(nodes);
  const selectedIdRef = useRef(selectedId);
  const toolRef = useRef(tool);
  const onSelectRef = useRef(onSelect);
  const onNodesChangeRef = useRef(onNodesChange);
  const onAddNoteRef = useRef(onAddNote);
  const onAddSectionRef = useRef(onAddSection);
  const onAddImageGeneratorRef = useRef(onAddImageGenerator);
  const onUploadFilesRef = useRef(onUploadFiles);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    localStorage.setItem(LAYERS_OPEN_KEY, layersOpen ? "1" : "0");
  }, [layersOpen]);

  useEffect(() => {
    onSelectRef.current = onSelect;
    onNodesChangeRef.current = onNodesChange;
    onAddNoteRef.current = onAddNote;
    onAddSectionRef.current = onAddSection;
    onAddImageGeneratorRef.current = onAddImageGenerator;
    onUploadFilesRef.current = onUploadFiles;
  }, [onAddImageGenerator, onAddNote, onAddSection, onNodesChange, onSelect, onUploadFiles]);

  const selected = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId]);
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
      const node = selectedIdRef.current ? nodesRef.current.find((item) => item.id === selectedIdRef.current) : null;
      if (!node) return;
      patchNode(node.id, { data: { ...node.data, ...patch } });
    },
    [patchNode],
  );

  const deleteNode = useCallback(
    (id: string) => {
      saveInputs(nodesRef.current.filter((node) => node.id !== id).map(toInput));
      onSelectRef.current(null);
      setContextMenu(null);
    },
    [saveInputs],
  );

  const duplicateNode = useCallback(
    (id: string) => {
      const node = nodesRef.current.find((item) => item.id === id);
      if (!node) return;
      const nextId = localId();
      saveInputs([
        ...nodesRef.current.map(toInput),
        {
          ...toInput(node),
          id: nextId,
          x: node.x + 28,
          y: node.y + 28,
          zIndex: Math.max(0, ...nodesRef.current.map((item) => item.zIndex ?? 0)) + 1,
          data: { ...node.data },
        },
      ]);
      onSelectRef.current(nextId);
      setContextMenu(null);
    },
    [saveInputs],
  );

  const bringToFront = useCallback(
    (id: string) => {
      patchNode(id, { zIndex: Math.max(0, ...nodesRef.current.map((item) => item.zIndex ?? 0)) + 1 });
      setContextMenu(null);
    },
    [patchNode],
  );

  const sendToBack = useCallback(
    (id: string) => {
      patchNode(id, { zIndex: Math.min(0, ...nodesRef.current.map((item) => item.zIndex ?? 0)) - 1 });
      setContextMenu(null);
    },
    [patchNode],
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
      patchNodeData(id, { visible: !isNodeVisible(node) });
      setContextMenu(null);
    },
    [patchNodeData],
  );

  const toggleNodeLocked = useCallback(
    (id: string) => {
      const node = nodesRef.current.find((item) => item.id === id);
      if (!node) return;
      patchNodeData(id, { locked: !isNodeLocked(node) });
      setContextMenu(null);
    },
    [patchNodeData],
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
    selectedIdRef.current = null;
    onSelectRef.current(null);
  }, []);

  const handleSelect = useCallback((id: string | null) => {
    setContextMenu(null);
    selectedIdRef.current = id;
    onSelectRef.current(id);
  }, []);

  const runtime = useLeaferMoodboardRuntime({
    nodes,
    selectedId,
    hoveredId,
    tool,
    onSelect: handleSelect,
    onBlankTap: handleBlankTap,
    onDoubleTap: (point) => onAddImageGeneratorRef.current(point),
    onContextMenu: setContextMenu,
    onFrameStateChange: saveInputs,
  });
  const { changeZoom, fitView, selectInRuntime, zoom } = runtime;

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
          handleSelect(null);
        }
      }
      if ((event.key === "Backspace" || event.key === "Delete") && selectedIdRef.current) {
        event.preventDefault();
        deleteNode(selectedIdRef.current);
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
  }, [changeZoom, contextMenu, deleteNode, fitView, handleSelect, zoom]);

  const contextTargetId = contextMenu?.targetId ?? null;

  return {
    ...runtime,
    tool,
    layersOpen,
    contextMenu,
    contextTargetId,
    selected,
    layerTree,
    inputRef,
    collapsedLayerIds,
    setTool,
    setHoveredId,
    setContextMenu,
    setLayersOpen,
    upload,
    patchNode,
    patchNodeData,
    patchSelectedData,
    deleteNode,
    duplicateNode,
    bringToFront,
    sendToBack,
    renameNode,
    toggleNodeVisible,
    toggleNodeLocked,
    toggleLayerCollapsed,
    selectLayer,
  };
}
