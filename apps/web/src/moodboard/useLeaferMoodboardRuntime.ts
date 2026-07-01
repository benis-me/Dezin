import "@leafer-in/resize";
import { ScrollBar } from "@leafer-in/scroll";
import { useCallback, useEffect, useRef, useState } from "react";
import { DragEvent, EditorEvent, EditorMoveEvent, EditorRotateEvent, EditorScaleEvent, PointerEvent, PropertyEvent, ZoomEvent, type App } from "leafer-editor";
import { ViewportLighter } from "@dezin/leafer-react";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import {
  contextTargetIdFromEvent,
  eventCanvasPoint,
  eventClientPoint,
  moveContainedNodesWithSections,
  nodeIdFromTarget,
  resolveFloatingRect,
  rounded,
  sameFloatingRect,
  toInput,
  type ContextMenuState,
  type FloatingRect,
  type MoodboardCanvasTool,
} from "./canvas-utils.ts";

interface UseLeaferMoodboardRuntimeOptions {
  nodes: MoodboardNode[];
  selectedId: string | null;
  tool: MoodboardCanvasTool;
  onSelect: (id: string | null) => void;
  onBlankTap: (point: { x: number; y: number }) => void;
  onDoubleTap: (point: { x: number; y: number }) => void;
  onContextMenu: (menu: ContextMenuState) => void;
  onFrameStateChange: (nodes: SaveMoodboardNodeInput[]) => void;
}

export function useLeaferMoodboardRuntime({
  nodes,
  selectedId,
  tool,
  onSelect,
  onBlankTap,
  onDoubleTap,
  onContextMenu,
  onFrameStateChange,
}: UseLeaferMoodboardRuntimeOptions) {
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [selectionRect, setSelectionRect] = useState<FloatingRect | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<App | null>(null);
  const layerRef = useRef<any>(null);
  const viewportLighterRef = useRef<ViewportLighter | null>(null);
  const scrollBarRef = useRef<ScrollBar | null>(null);
  const nodesRef = useRef(nodes);
  const selectedIdRef = useRef(selectedId);
  const toolRef = useRef(tool);
  const floatingRectRef = useRef<FloatingRect | null>(null);
  const floatingRafRef = useRef<number | null>(null);
  const callbacksRef = useRef({ onSelect, onBlankTap, onDoubleTap, onContextMenu, onFrameStateChange });

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
    callbacksRef.current = { onSelect, onBlankTap, onDoubleTap, onContextMenu, onFrameStateChange };
  }, [onBlankTap, onContextMenu, onDoubleTap, onFrameStateChange, onSelect]);

  const commitSelectionRect = useCallback((next: FloatingRect | null) => {
    const prev = floatingRectRef.current;
    if (sameFloatingRect(prev, next)) return;
    floatingRectRef.current = next;
    setSelectionRect(next);
  }, []);

  const findFrame = useCallback((id: string | null | undefined): any | null => {
    if (!id) return null;
    const app: any = appRef.current;
    return app?.findId?.(id) ?? app?.tree?.findOne?.(`#${id}`) ?? layerRef.current?.findOne?.(`#${id}`) ?? null;
  }, []);

  const updateFloatingSelection = useCallback(() => {
    const id = selectedIdRef.current;
    const frame = findFrame(id);
    const container = hostRef.current;
    const app: any = appRef.current;
    if (!frame || !container) {
      commitSelectionRect(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    commitSelectionRect(
      resolveFloatingRect({
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
        containerLeft: containerRect.left,
        containerTop: containerRect.top,
        frame,
        tree: app?.tree,
        world: frame.worldBoxBounds ?? frame.boxBounds,
      }),
    );
  }, [commitSelectionRect, findFrame]);

  const scheduleFloatingSelection = useCallback(() => {
    if (floatingRafRef.current != null) return;
    floatingRafRef.current = window.requestAnimationFrame(() => {
      floatingRafRef.current = null;
      updateFloatingSelection();
    });
  }, [updateFloatingSelection]);

  const selectInRuntime = useCallback(
    (id: string | null) => {
      const editor = (appRef.current as any)?.editor;
      if (!editor) return;
      try {
        editor.target = findFrame(id) ?? undefined;
        scheduleFloatingSelection();
      } catch {
        /* Leafer editor may not be ready during first paint. */
      }
    },
    [findFrame, scheduleFloatingSelection],
  );

  const hoverInRuntime = useCallback(
    (id: string | null) => {
      const editor = (appRef.current as any)?.editor;
      if (!editor) return;
      try {
        editor.hoverTarget = findFrame(id) ?? undefined;
      } catch {
        /* Leafer editor hover state may be unavailable during first paint. */
      }
    },
    [findFrame],
  );

  const flushFrameState = useCallback(() => {
    const next = nodesRef.current.map((node) => {
      const frame = findFrame(node.id);
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
    callbacksRef.current.onFrameStateChange(moveContainedNodesWithSections(nodesRef.current, next));
  }, [findFrame]);

  const handleAppReady = useCallback((app: App) => {
    appRef.current = app;
    try {
      scrollBarRef.current?.destroy();
      scrollBarRef.current = new ScrollBar(app as any, {
        theme: { fill: "rgba(35,35,32,0.32)", stroke: "rgba(255,255,255,0.78)" },
        padding: 8,
        minSize: 18,
      });
    } catch {
      scrollBarRef.current = null;
    }
    try {
      viewportLighterRef.current = new ViewportLighter((app as any).tree, { sliceRender: 10_000 });
    } catch {
      viewportLighterRef.current = null;
    }
  }, []);

  const handleLayerCreated = useCallback(
    (layer: any) => {
      layerRef.current = layer;
      setRuntimeReady(true);
      selectInRuntime(selectedIdRef.current);
      scheduleFloatingSelection();
    },
    [scheduleFloatingSelection, selectInRuntime],
  );

  useEffect(() => {
    return () => {
      viewportLighterRef.current?.destroy();
      viewportLighterRef.current = null;
      scrollBarRef.current?.destroy();
      scrollBarRef.current = null;
      appRef.current = null;
      layerRef.current = null;
      setRuntimeReady(false);
      if (floatingRafRef.current != null) {
        window.cancelAnimationFrame(floatingRafRef.current);
        floatingRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const app: any = appRef.current;
    const editor = app?.editor;
    if (!runtimeReady || !app || !editor) return;

    const syncSelectedFromEditor = (event?: any) => {
      const id = nodeIdFromTarget(event?.value ?? editor.target);
      selectedIdRef.current = id;
      callbacksRef.current.onSelect(id);
      scheduleFloatingSelection();
    };
    const syncFloatingOnly = () => scheduleFloatingSelection();
    const syncAfterTransform = () => {
      flushFrameState();
      const scale = Number(app.tree?.scaleX ?? app.tree?.scale ?? 1);
      if (Number.isFinite(scale)) setZoom(scale);
      scheduleFloatingSelection();
    };
    const selectFromTarget = (target: unknown) => {
      const targetId = nodeIdFromTarget(target);
      if (!targetId) return false;
      selectedIdRef.current = targetId;
      callbacksRef.current.onSelect(targetId);
      selectInRuntime(targetId);
      scheduleFloatingSelection();
      return true;
    };
    const handlePointerDown = (event: any) => {
      selectFromTarget(event?.target);
    };
    const handleTap = (event: any) => {
      if (selectFromTarget(event?.target)) return;
      selectInRuntime(null);
      callbacksRef.current.onBlankTap(eventCanvasPoint(event));
    };
    const handleDoubleTap = (event: any) => {
      if (nodeIdFromTarget(event?.target)) return;
      const point = eventCanvasPoint(event);
      if (Number.isFinite(point.x) && Number.isFinite(point.y)) callbacksRef.current.onDoubleTap(point);
    };
    const handleMenu = (event: any) => {
      event?.preventDefault?.();
      const client = eventClientPoint(event);
      const point = eventCanvasPoint(event);
      const targetId = contextTargetIdFromEvent(event?.target, editor.target);
      if (targetId) {
        selectedIdRef.current = targetId;
        callbacksRef.current.onSelect(targetId);
        selectInRuntime(targetId);
      }
      callbacksRef.current.onContextMenu({ x: client.x, y: client.y, canvasX: point.x, canvasY: point.y, targetId });
    };

    app.on(PointerEvent.TAP, handleTap);
    app.on(PointerEvent.DOWN, handlePointerDown);
    app.on(PointerEvent.DOUBLE_TAP, handleDoubleTap);
    app.on(PointerEvent.MENU, handleMenu);
    app.on(DragEvent.START, syncFloatingOnly);
    app.on(DragEvent.DRAG, syncFloatingOnly);
    app.on(DragEvent.END, syncAfterTransform);
    app.on(ZoomEvent.START, syncFloatingOnly);
    app.on(ZoomEvent.ZOOM, syncFloatingOnly);
    app.on(ZoomEvent.END, syncAfterTransform);
    app.tree?.on?.(PropertyEvent.LEAFER_CHANGE, syncFloatingOnly);
    app.tree?.on?.("move", syncFloatingOnly);
    app.tree?.on?.("move.end", syncAfterTransform);
    editor.on(EditorEvent.SELECT, syncSelectedFromEditor);
    editor.on(EditorEvent.HOVER, syncFloatingOnly);
    editor.on(EditorMoveEvent.MOVE, syncFloatingOnly);
    editor.on(EditorScaleEvent.SCALE, syncFloatingOnly);
    editor.on(EditorRotateEvent.ROTATE, syncFloatingOnly);

    return () => {
      app.off(PointerEvent.TAP, handleTap);
      app.off(PointerEvent.DOWN, handlePointerDown);
      app.off(PointerEvent.DOUBLE_TAP, handleDoubleTap);
      app.off(PointerEvent.MENU, handleMenu);
      app.off(DragEvent.START, syncFloatingOnly);
      app.off(DragEvent.DRAG, syncFloatingOnly);
      app.off(DragEvent.END, syncAfterTransform);
      app.off(ZoomEvent.START, syncFloatingOnly);
      app.off(ZoomEvent.ZOOM, syncFloatingOnly);
      app.off(ZoomEvent.END, syncAfterTransform);
      app.tree?.off?.(PropertyEvent.LEAFER_CHANGE, syncFloatingOnly);
      app.tree?.off?.("move", syncFloatingOnly);
      app.tree?.off?.("move.end", syncAfterTransform);
      editor.off(EditorEvent.SELECT, syncSelectedFromEditor);
      editor.off(EditorEvent.HOVER, syncFloatingOnly);
      editor.off(EditorMoveEvent.MOVE, syncFloatingOnly);
      editor.off(EditorScaleEvent.SCALE, syncFloatingOnly);
      editor.off(EditorRotateEvent.ROTATE, syncFloatingOnly);
    };
  }, [flushFrameState, runtimeReady, scheduleFloatingSelection, selectInRuntime]);

  useEffect(() => {
    selectInRuntime(selectedId);
  }, [selectedId, selectInRuntime]);

  useEffect(() => {
    const app: any = appRef.current;
    const editor = app?.editor;
    if (!runtimeReady || !app || !editor) return;
    try {
      if (app.config) app.config.move = { ...(app.config.move ?? {}), dragEmpty: tool === "hand" };
      if (editor.config) {
        const drawing = tool === "note" || tool === "section";
        editor.config.boxSelect = !drawing;
        editor.config.moveable = !drawing;
        if (drawing) {
          editor.target = undefined;
          selectedIdRef.current = null;
          callbacksRef.current.onSelect(null);
          scheduleFloatingSelection();
        }
      }
    } catch {
      /* Leafer config shape can vary by version. */
    }
  }, [runtimeReady, scheduleFloatingSelection, tool]);

  const changeZoom = useCallback(
    (next: number) => {
      const app: any = appRef.current;
      const tree = app?.tree;
      const clamped = Math.max(0.1, Math.min(4, next));
      if (tree) {
        tree.scaleX = clamped;
        tree.scaleY = clamped;
        tree.forceUpdate?.();
      }
      setZoom(clamped);
      scheduleFloatingSelection();
    },
    [scheduleFloatingSelection],
  );

  const fitView = useCallback(() => {
    const app: any = appRef.current;
    const container = hostRef.current;
    const tree = app?.tree;
    const currentNodes = nodesRef.current;
    if (!tree || !container || currentNodes.length === 0) {
      changeZoom(1);
      return;
    }

    const left = Math.min(...currentNodes.map((node) => node.x));
    const top = Math.min(...currentNodes.map((node) => node.y));
    const right = Math.max(...currentNodes.map((node) => node.x + node.width));
    const bottom = Math.max(...currentNodes.map((node) => node.y + node.height));
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const padding = 96;
    const availableWidth = Math.max(120, container.clientWidth - padding * 2);
    const availableHeight = Math.max(120, container.clientHeight - padding * 2);
    const nextScale = Math.max(0.1, Math.min(2, Math.min(availableWidth / width, availableHeight / height)));
    const centerX = left + width / 2;
    const centerY = top + height / 2;

    tree.scaleX = nextScale;
    tree.scaleY = nextScale;
    tree.x = container.clientWidth / 2 - centerX * nextScale;
    tree.y = container.clientHeight / 2 - centerY * nextScale;
    tree.forceUpdate?.();
    setZoom(nextScale);
    scheduleFloatingSelection();
  }, [changeZoom, scheduleFloatingSelection]);

  return {
    hostRef,
    runtimeReady,
    selectionRect,
    zoom,
    changeZoom,
    fitView,
    handleAppReady,
    handleLayerCreated,
    selectInRuntime,
    hoverInRuntime,
  };
}
