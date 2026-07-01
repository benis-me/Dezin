import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ImagePlus, Plus } from "lucide-react";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { Button } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { MoodboardContextMenu } from "./MoodboardContextMenu.tsx";
import { CanvasActionBar, CanvasZoomBar, GeneratorPromptToolbar, SelectionToolbar } from "./MoodboardCanvasToolbars.tsx";
import { MoodboardLayerPanel } from "./MoodboardLayerPanel.tsx";
import { MoodboardPropertiesPanel } from "./MoodboardPropertiesPanel.tsx";
import { makeNodeFrame } from "./leafer-node-renderer.ts";
import {
  buildLayerTree,
  clampMenu,
  eventCanvasPoint,
  eventClientPoint,
  generatorPrompt,
  isNodeLocked,
  isNodeVisible,
  localId,
  nodeIdFromTarget,
  rounded,
  toInput,
  type ContextMenuState,
  type FloatingRect,
  type LeaferRuntime,
  type MoodboardCanvasTool,
} from "./canvas-utils.ts";

const LAYERS_OPEN_KEY = "dezin:moodboard:layers-open";

export function MoodboardCanvas({
  nodes,
  selectedId,
  busy = false,
  onSelect,
  onNodesChange,
  onAddNote,
  onAddSection,
  onAddImageGenerator,
  onUploadFiles,
  onGenerateImage,
}: {
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
}) {
  const [tool, setTool] = useState<MoodboardCanvasTool>("select");
  const [layersOpen, setLayersOpen] = useState(() => localStorage.getItem(LAYERS_OPEN_KEY) !== "0");
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [selectionRect, setSelectionRect] = useState<FloatingRect | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [collapsedLayerIds, setCollapsedLayerIds] = useState<Set<string>>(() => new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const runtimeRef = useRef<LeaferRuntime | null>(null);
  const framesRef = useRef<Map<string, any>>(new Map());
  const nodesRef = useRef(nodes);
  const selectedIdRef = useRef(selectedId);
  const toolRef = useRef(tool);
  const onSelectRef = useRef(onSelect);
  const onNodesChangeRef = useRef(onNodesChange);
  const onAddNoteRef = useRef(onAddNote);
  const onAddSectionRef = useRef(onAddSection);
  const onAddImageGeneratorRef = useRef(onAddImageGenerator);

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
  }, [onAddImageGenerator, onAddNote, onAddSection, onNodesChange, onSelect]);

  const selected = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId]);
  const layerTree = useMemo(() => buildLayerTree(nodes), [nodes]);

  const saveInputs = useCallback((next: SaveMoodboardNodeInput[]) => onNodesChangeRef.current(next), []);

  const patchNode = useCallback(
    (id: string, patch: Partial<SaveMoodboardNodeInput>) => {
      saveInputs(nodesRef.current.map((node) => (node.id === id ? { ...toInput(node), ...patch, data: patch.data ?? node.data } : toInput(node))));
    },
    [saveInputs],
  );

  const flushFrameState = useCallback(() => {
    const frames = framesRef.current;
    const next = nodesRef.current.map((node) => {
      const frame = frames.get(node.id);
      if (!frame) return toInput(node);
      return {
        ...toInput(node),
        x: rounded(frame.x, node.x),
        y: rounded(frame.y, node.y),
        width: Math.max(40, rounded(frame.width, node.width)),
        height: Math.max(40, rounded(frame.height, node.height)),
        rotation: rounded(frame.rotation, node.rotation ?? 0),
        zIndex: rounded(frame.zIndex, node.zIndex ?? 0),
      };
    });
    saveInputs(next);
  }, [saveInputs]);

  const updateFloatingSelection = useCallback(() => {
    const runtime = runtimeRef.current;
    const id = selectedIdRef.current;
    const frame = id ? framesRef.current.get(id) : null;
    const container = containerRef.current;
    if (!runtime || !frame || !container) {
      setSelectionRect(null);
      return;
    }
    const tree = runtime.app?.tree;
    const scale = Number(tree?.scale ?? tree?.scaleX ?? 1) || 1;
    const tx = Number(tree?.x ?? 0) || 0;
    const ty = Number(tree?.y ?? 0) || 0;
    const x = Number(frame.x ?? 0) || 0;
    const y = Number(frame.y ?? 0) || 0;
    const width = Number(frame.width ?? 160) || 160;
    const height = Number(frame.height ?? 120) || 120;
    const left = tx + (x + width / 2) * scale;
    const top = ty + y * scale - 44;
    const bottom = ty + (y + height) * scale + 12;
    setSelectionRect({
      left: Math.max(16, Math.min(container.clientWidth - 16, left)),
      top: Math.max(12, Math.min(container.clientHeight - 56, top)),
      bottom: Math.max(12, Math.min(container.clientHeight - 132, bottom)),
    });
  }, []);

  const selectInRuntime = useCallback((id: string | null) => {
    const runtime = runtimeRef.current;
    if (!runtime?.app?.editor) return;
    try {
      const frame = id ? framesRef.current.get(id) : null;
      runtime.app.editor.select(frame ? [frame] : []);
      window.requestAnimationFrame(updateFloatingSelection);
    } catch {
      /* Leafer editor may not be ready during first paint. */
    }
  }, [updateFloatingSelection]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    const setup = async () => {
      await Promise.all([import("@leafer-in/editor"), import("@leafer-in/resize"), import("@leafer-in/scroll")]);
      const leafer = (await import("leafer-editor")) as any;
      if (disposed || !containerRef.current) return;

      const app = new leafer.App({
        view: containerRef.current,
        tree: {
          type: "design",
          pixelSnap: true,
          pointSnap: true,
          smooth: true,
          fill: "#f7f7f5",
        },
        editor: {
          hideOnMove: true,
          skewable: false,
          flipable: false,
          bright: true,
          stroke: "#2563eb",
          pointFill: "#ffffff",
          pointRadius: 2,
          pointSize: 9,
        },
        wheel: { preventDefault: true },
        move: { dragEmpty: false },
        zoom: { min: 0.1, max: 4 },
      });

      const layer = new leafer.Frame({ id: "moodboard-node-layer", name: "nodes", fill: "transparent", hitSelf: false, isSnap: false });
      app.tree.add(layer);

      const runtime: LeaferRuntime = {
        app,
        layer,
        Frame: leafer.Frame,
        Rect: leafer.Rect,
        Image: leafer.Image,
        Text: leafer.Text,
        PointerEvent: leafer.PointerEvent,
        DragEvent: leafer.DragEvent,
        EditorEvent: leafer.EditorEvent,
        EditorMoveEvent: leafer.EditorMoveEvent,
        EditorRotateEvent: leafer.EditorRotateEvent,
        EditorScaleEvent: leafer.EditorScaleEvent,
        ZoomEvent: leafer.ZoomEvent,
      };
      runtimeRef.current = runtime;

      const resize = () => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect?.width && rect.height) app.resize({ width: rect.width, height: rect.height, pixelRatio: window.devicePixelRatio || 1 });
        window.requestAnimationFrame(updateFloatingSelection);
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(containerRef.current);

      const syncSelectedFromEditor = () => {
        const id = nodeIdFromTarget(app.editor?.target);
        selectedIdRef.current = id;
        onSelectRef.current(id);
        window.requestAnimationFrame(updateFloatingSelection);
      };
      const syncFloatingOnly = () => {
        window.requestAnimationFrame(updateFloatingSelection);
      };
      const syncAfterTransform = () => {
        flushFrameState();
        const scale = Number(app.tree?.scaleX ?? app.tree?.scale ?? 1);
        if (Number.isFinite(scale)) setZoom(scale);
        window.requestAnimationFrame(updateFloatingSelection);
      };
      const handleTap = (event: any) => {
        setContextMenu(null);
        const targetId = nodeIdFromTarget(event?.target);
        if (targetId) {
          selectedIdRef.current = targetId;
          onSelectRef.current(targetId);
          window.requestAnimationFrame(updateFloatingSelection);
          return;
        }
        const point = eventCanvasPoint(event);
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
        setSelectionRect(null);
      };
      const handleDoubleTap = (event: any) => {
        const point = eventCanvasPoint(event);
        if (Number.isFinite(point.x) && Number.isFinite(point.y)) onAddImageGeneratorRef.current(point);
      };
      const handleMenu = (event: any) => {
        event?.preventDefault?.();
        const client = clampMenu(eventClientPoint(event));
        const point = eventCanvasPoint(event);
        setContextMenu({ x: client.x, y: client.y, canvasX: point.x, canvasY: point.y, targetId: nodeIdFromTarget(event?.target) });
      };

      app.on(runtime.PointerEvent.TAP, handleTap);
      app.on(runtime.PointerEvent.DOUBLE_TAP, handleDoubleTap);
      app.on(runtime.PointerEvent.MENU, handleMenu);
      if (runtime.DragEvent?.DRAG) app.on(runtime.DragEvent.DRAG, syncFloatingOnly);
      app.on(runtime.DragEvent.END, syncAfterTransform);
      if (runtime.ZoomEvent?.END) app.on(runtime.ZoomEvent.END, syncAfterTransform);
      app.editor?.on(runtime.EditorEvent.SELECT, syncSelectedFromEditor);
      if (runtime.EditorMoveEvent?.MOVE) app.editor?.on(runtime.EditorMoveEvent.MOVE, syncFloatingOnly);
      if (runtime.EditorScaleEvent?.SCALE) app.editor?.on(runtime.EditorScaleEvent.SCALE, syncFloatingOnly);
      if (runtime.EditorRotateEvent?.ROTATE) app.editor?.on(runtime.EditorRotateEvent.ROTATE, syncFloatingOnly);

      cleanup = () => {
        observer.disconnect();
        app.off(runtime.PointerEvent.TAP, handleTap);
        app.off(runtime.PointerEvent.DOUBLE_TAP, handleDoubleTap);
        app.off(runtime.PointerEvent.MENU, handleMenu);
        if (runtime.DragEvent?.DRAG) app.off(runtime.DragEvent.DRAG, syncFloatingOnly);
        app.off(runtime.DragEvent.END, syncAfterTransform);
        if (runtime.ZoomEvent?.END) app.off(runtime.ZoomEvent.END, syncAfterTransform);
        app.editor?.off(runtime.EditorEvent.SELECT, syncSelectedFromEditor);
        if (runtime.EditorMoveEvent?.MOVE) app.editor?.off(runtime.EditorMoveEvent.MOVE, syncFloatingOnly);
        if (runtime.EditorScaleEvent?.SCALE) app.editor?.off(runtime.EditorScaleEvent.SCALE, syncFloatingOnly);
        if (runtime.EditorRotateEvent?.ROTATE) app.editor?.off(runtime.EditorRotateEvent.ROTATE, syncFloatingOnly);
        layer.removeAll(true);
        app.destroy();
        runtimeRef.current = null;
        framesRef.current.clear();
      };

      setRuntimeReady(true);
    };

    void setup();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [flushFrameState]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.layer.removeAll(true);
    framesRef.current.clear();

    [...nodes]
      .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
      .forEach((node) => {
        const frame = makeNodeFrame(runtime, node, node.id === selectedId, node.id === hoveredId, (id) => {
          onSelectRef.current(id);
          selectInRuntime(id);
        });
        framesRef.current.set(node.id, frame);
        runtime.layer.add(frame);
      });

    selectInRuntime(selectedId);
    window.requestAnimationFrame(updateFloatingSelection);
  }, [hoveredId, nodes, selectedId, selectInRuntime, runtimeReady, updateFloatingSelection]);

  useEffect(() => {
    try {
      const app = runtimeRef.current?.app;
      if (app?.config) app.config.move = { ...(app.config.move ?? {}), dragEmpty: tool === "hand" };
    } catch {
      /* Leafer config shape can vary by version. */
    }
  }, [runtimeReady, tool]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      const editing = tag === "INPUT" || tag === "TEXTAREA" || (event.target as HTMLElement | null)?.isContentEditable;
      if (editing) return;

      if (event.key === "Escape") {
        if (contextMenu) {
          setContextMenu(null);
        } else if (toolRef.current !== "select") {
          setTool("select");
        } else {
          onSelect(null);
        }
      }
      if ((event.key === "Backspace" || event.key === "Delete") && selectedId) {
        event.preventDefault();
        deleteNode(selectedId);
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
  });

  const changeZoom = (next: number) => {
    const runtime = runtimeRef.current;
    const clamped = Math.max(0.1, Math.min(4, next));
    if (runtime?.app?.tree) {
      runtime.app.tree.scaleX = clamped;
      runtime.app.tree.scaleY = clamped;
      runtime.app.tree.forceUpdate?.();
    }
    setZoom(clamped);
  };

  const patchSelectedData = (patch: Record<string, unknown>) => {
    if (!selected) return;
    patchNode(selected.id, { data: { ...selected.data, ...patch } });
  };

  const deleteNode = (id: string) => {
    saveInputs(nodesRef.current.filter((node) => node.id !== id).map(toInput));
    onSelectRef.current(null);
    setContextMenu(null);
  };

  const duplicateNode = (id: string) => {
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
  };

  const bringToFront = (id: string) => {
    patchNode(id, { zIndex: Math.max(0, ...nodesRef.current.map((item) => item.zIndex ?? 0)) + 1 });
    setContextMenu(null);
  };

  const sendToBack = (id: string) => {
    patchNode(id, { zIndex: Math.min(0, ...nodesRef.current.map((item) => item.zIndex ?? 0)) - 1 });
    setContextMenu(null);
  };

  const patchNodeData = (id: string, patch: Record<string, unknown>) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (!node) return;
    patchNode(id, { data: { ...node.data, ...patch } });
  };

  const renameNode = (id: string, name: string) => {
    patchNodeData(id, { name });
  };

  const toggleNodeVisible = (id: string) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (!node) return;
    patchNodeData(id, { visible: !isNodeVisible(node) });
    setContextMenu(null);
  };

  const toggleNodeLocked = (id: string) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (!node) return;
    patchNodeData(id, { locked: !isNodeLocked(node) });
    setContextMenu(null);
  };

  const toggleLayerCollapsed = (id: string) => {
    setCollapsedLayerIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    onUploadFiles(event.target.files);
    event.currentTarget.value = "";
  };

  const contextTargetId = contextMenu?.targetId ?? null;

  return (
    <div className="relative min-h-0 flex-1 bg-surface">
      <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={upload} />
      <div className="relative h-full min-w-0 overflow-hidden">
        {layersOpen ? (
          <MoodboardLayerPanel
            items={layerTree}
            selectedId={selectedId}
            collapsedIds={collapsedLayerIds}
            onToggleCollapsed={toggleLayerCollapsed}
            onSelect={(id) => {
              onSelect(id);
              selectInRuntime(id);
            }}
            onHover={setHoveredId}
            onRename={renameNode}
            onToggleVisible={toggleNodeVisible}
            onToggleLocked={toggleNodeLocked}
            onBringToFront={bringToFront}
            onSendToBack={sendToBack}
          />
        ) : null}

        <div
          ref={containerRef}
          data-testid="moodboard-leafer-canvas"
          className={cn(
            "h-full w-full overflow-hidden",
            tool === "hand" && "cursor-grab active:cursor-grabbing",
            (tool === "note" || tool === "section") && "cursor-crosshair",
          )}
        />

        {!runtimeReady ? (
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
              <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
                <Plus size={14} strokeWidth={1.75} />
                Add images
              </Button>
            </div>
          </div>
        ) : null}

        {selected && selectionRect ? (
          <div className="pointer-events-none absolute z-30" style={{ left: selectionRect.left, top: selectionRect.top, transform: "translateX(-50%)" }}>
            <SelectionToolbar
              node={selected}
              onDuplicate={() => duplicateNode(selected.id)}
              onBringToFront={() => bringToFront(selected.id)}
              onSendToBack={() => sendToBack(selected.id)}
              onDelete={() => deleteNode(selected.id)}
            />
          </div>
        ) : null}

        {selected?.type === "image-generator" && selectionRect ? (
          <div
            className="pointer-events-none absolute z-30"
            style={{ left: selectionRect.left, top: selectionRect.bottom, transform: "translateX(-50%)" }}
          >
            <GeneratorPromptToolbar
              node={selected}
              busy={busy}
              onPromptChange={(prompt) => patchNodeData(selected.id, { generatorPrompt: prompt, generatorStatus: prompt ? "ready" : "" })}
              onGenerate={(prompt) => onGenerateImage(selected, prompt)}
            />
          </div>
        ) : null}

        <CanvasActionBar
          tool={tool}
          layersOpen={layersOpen}
          onToolChange={setTool}
          onUpload={() => inputRef.current?.click()}
          onAddImageGenerator={() => onAddImageGenerator()}
          onToggleLayers={() => setLayersOpen((value) => !value)}
        />
        <CanvasZoomBar zoom={zoom} onChangeZoom={changeZoom} />

        {contextMenu ? (
            <MoodboardContextMenu
              menu={contextMenu}
              targetId={contextTargetId}
              onClose={() => setContextMenu(null)}
              onAddNote={() => {
                onAddNote({ x: contextMenu.canvasX, y: contextMenu.canvasY });
                setContextMenu(null);
              }}
              onAddSection={() => {
                onAddSection({ x: contextMenu.canvasX, y: contextMenu.canvasY });
                setContextMenu(null);
              }}
              onGenerate={() => {
                onAddImageGenerator({ x: contextMenu.canvasX, y: contextMenu.canvasY });
                setContextMenu(null);
              }}
              onDuplicate={contextTargetId ? () => duplicateNode(contextTargetId) : undefined}
              onBringToFront={contextTargetId ? () => bringToFront(contextTargetId) : undefined}
              onSendToBack={contextTargetId ? () => sendToBack(contextTargetId) : undefined}
              onToggleVisible={contextTargetId ? () => toggleNodeVisible(contextTargetId) : undefined}
              onToggleLocked={contextTargetId ? () => toggleNodeLocked(contextTargetId) : undefined}
              onDelete={contextTargetId ? () => deleteNode(contextTargetId) : undefined}
              onZoomIn={() => {
                changeZoom(zoom * 1.14);
                setContextMenu(null);
              }}
              onZoomOut={() => {
                changeZoom(zoom * 0.88);
                setContextMenu(null);
              }}
              onResetZoom={() => {
                changeZoom(1);
                setContextMenu(null);
              }}
              targetNode={contextTargetId ? nodes.find((node) => node.id === contextTargetId) ?? null : null}
            />
          ) : null}

        {selected ? (
          <MoodboardPropertiesPanel
            node={selected}
            onPatch={(patch) => selected && patchNode(selected.id, patch)}
            onPatchData={patchSelectedData}
            onGenerate={() => selected.type === "image-generator" && onGenerateImage(selected, generatorPrompt(selected))}
          />
        ) : null}
      </div>
    </div>
  );
}
