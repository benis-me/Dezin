import { useCallback, useEffect, useRef, useState } from "react";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { makeNodeFrame } from "./leafer-node-renderer.ts";
import {
  clampMenu,
  eventCanvasPoint,
  eventClientPoint,
  nodeIdFromTarget,
  resolveFloatingRect,
  rounded,
  sameFloatingRect,
  toInput,
  type ContextMenuState,
  type FloatingRect,
  type LeaferRuntime,
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
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<LeaferRuntime | null>(null);
  const framesRef = useRef<Map<string, any>>(new Map());
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

  const updateFloatingSelection = useCallback(() => {
    const runtime = runtimeRef.current;
    const id = selectedIdRef.current;
    const frame = id ? framesRef.current.get(id) : null;
    const container = containerRef.current;
    if (!runtime || !frame || !container) {
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
        tree: runtime.app?.tree,
        world: frame.worldBoxBounds ?? frame.boxBounds,
      }),
    );
  }, [commitSelectionRect]);

  const scheduleFloatingSelection = useCallback(() => {
    if (floatingRafRef.current != null) return;
    floatingRafRef.current = window.requestAnimationFrame(() => {
      floatingRafRef.current = null;
      updateFloatingSelection();
    });
  }, [updateFloatingSelection]);

  const selectInRuntime = useCallback(
    (id: string | null) => {
      const runtime = runtimeRef.current;
      if (!runtime?.app?.editor) return;
      try {
        const frame = id ? framesRef.current.get(id) : null;
        runtime.app.editor.select(frame ? [frame] : []);
        scheduleFloatingSelection();
      } catch {
        /* Leafer editor may not be ready during first paint. */
      }
    },
    [scheduleFloatingSelection],
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
    callbacksRef.current.onFrameStateChange(next);
  }, []);

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
          hideOnMove: false,
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
        scheduleFloatingSelection();
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(containerRef.current);

      const syncSelectedFromEditor = () => {
        const id = nodeIdFromTarget(app.editor?.target);
        selectedIdRef.current = id;
        callbacksRef.current.onSelect(id);
        scheduleFloatingSelection();
      };
      const syncFloatingOnly = () => {
        scheduleFloatingSelection();
      };
      const syncAfterTransform = () => {
        flushFrameState();
        const scale = Number(app.tree?.scaleX ?? app.tree?.scale ?? 1);
        if (Number.isFinite(scale)) setZoom(scale);
        scheduleFloatingSelection();
      };
      const syncSelectionOnPointerDown = (event: any) => {
        const targetId = nodeIdFromTarget(event?.target);
        if (!targetId || targetId === selectedIdRef.current) return;
        const frame = framesRef.current.get(targetId);
        if (!frame) return;
        try {
          app.editor?.select([frame]);
        } catch {
          /* Editor may ignore early pointer-down selection. */
        }
        selectedIdRef.current = targetId;
        callbacksRef.current.onSelect(targetId);
        scheduleFloatingSelection();
      };
      const handleTap = (event: any) => {
        const targetId = nodeIdFromTarget(event?.target);
        if (targetId) {
          selectedIdRef.current = targetId;
          callbacksRef.current.onSelect(targetId);
          scheduleFloatingSelection();
          return;
        }
        callbacksRef.current.onBlankTap(eventCanvasPoint(event));
      };
      const handleDoubleTap = (event: any) => {
        const point = eventCanvasPoint(event);
        if (Number.isFinite(point.x) && Number.isFinite(point.y)) callbacksRef.current.onDoubleTap(point);
      };
      const handleMenu = (event: any) => {
        event?.preventDefault?.();
        const client = clampMenu(eventClientPoint(event));
        const point = eventCanvasPoint(event);
        const targetId = nodeIdFromTarget(event?.target);
        if (targetId) {
          const frame = framesRef.current.get(targetId);
          if (frame) {
            try {
              app.editor?.select([frame]);
            } catch {
              /* Editor may ignore context-menu selection during setup. */
            }
          }
          selectedIdRef.current = targetId;
          callbacksRef.current.onSelect(targetId);
          scheduleFloatingSelection();
        }
        callbacksRef.current.onContextMenu({ x: client.x, y: client.y, canvasX: point.x, canvasY: point.y, targetId });
      };

      app.on(runtime.PointerEvent.TAP, handleTap);
      if (runtime.PointerEvent.DOWN) app.on(runtime.PointerEvent.DOWN, syncSelectionOnPointerDown);
      app.on(runtime.PointerEvent.DOUBLE_TAP, handleDoubleTap);
      app.on(runtime.PointerEvent.MENU, handleMenu);
      runtime.app?.tree?.on?.("move", syncFloatingOnly);
      runtime.app?.tree?.on?.("zoom", syncFloatingOnly);
      runtime.app?.tree?.on?.("transform", syncFloatingOnly);
      runtime.app?.tree?.on?.("property.leafer_change", syncFloatingOnly);
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
        if (runtime.PointerEvent.DOWN) app.off(runtime.PointerEvent.DOWN, syncSelectionOnPointerDown);
        app.off(runtime.PointerEvent.DOUBLE_TAP, handleDoubleTap);
        app.off(runtime.PointerEvent.MENU, handleMenu);
        runtime.app?.tree?.off?.("move", syncFloatingOnly);
        runtime.app?.tree?.off?.("zoom", syncFloatingOnly);
        runtime.app?.tree?.off?.("transform", syncFloatingOnly);
        runtime.app?.tree?.off?.("property.leafer_change", syncFloatingOnly);
        if (runtime.DragEvent?.DRAG) app.off(runtime.DragEvent.DRAG, syncFloatingOnly);
        app.off(runtime.DragEvent.END, syncAfterTransform);
        if (runtime.ZoomEvent?.END) app.off(runtime.ZoomEvent.END, syncAfterTransform);
        app.editor?.off(runtime.EditorEvent.SELECT, syncSelectedFromEditor);
        if (runtime.EditorMoveEvent?.MOVE) app.editor?.off(runtime.EditorMoveEvent.MOVE, syncFloatingOnly);
        if (runtime.EditorScaleEvent?.SCALE) app.editor?.off(runtime.EditorScaleEvent.SCALE, syncFloatingOnly);
        if (runtime.EditorRotateEvent?.ROTATE) app.editor?.off(runtime.EditorRotateEvent.ROTATE, syncFloatingOnly);
        if (floatingRafRef.current != null) {
          window.cancelAnimationFrame(floatingRafRef.current);
          floatingRafRef.current = null;
        }
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
  }, [flushFrameState, scheduleFloatingSelection]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.layer.removeAll(true);
    framesRef.current.clear();

    [...nodes]
      .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
      .forEach((node) => {
        const frame = makeNodeFrame(runtime, node, (id) => {
          callbacksRef.current.onSelect(id);
          selectInRuntime(id);
        });
        framesRef.current.set(node.id, frame);
        runtime.layer.add(frame);
      });

    selectInRuntime(selectedIdRef.current);
    scheduleFloatingSelection();
  }, [nodes, runtimeReady, scheduleFloatingSelection, selectInRuntime]);

  useEffect(() => {
    selectInRuntime(selectedId);
  }, [selectedId, selectInRuntime]);

  useEffect(() => {
    try {
      const app = runtimeRef.current?.app;
      if (app?.config) app.config.move = { ...(app.config.move ?? {}), dragEmpty: tool === "hand" };
    } catch {
      /* Leafer config shape can vary by version. */
    }
  }, [runtimeReady, tool]);

  const changeZoom = useCallback((next: number) => {
    const runtime = runtimeRef.current;
    const clamped = Math.max(0.1, Math.min(4, next));
    if (runtime?.app?.tree) {
      runtime.app.tree.scaleX = clamped;
      runtime.app.tree.scaleY = clamped;
      runtime.app.tree.forceUpdate?.();
    }
    setZoom(clamped);
    scheduleFloatingSelection();
  }, [scheduleFloatingSelection]);

  const fitView = useCallback(() => {
    const runtime = runtimeRef.current;
    const container = containerRef.current;
    const tree = runtime?.app?.tree;
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
    containerRef,
    runtimeReady,
    selectionRect,
    zoom,
    changeZoom,
    fitView,
    selectInRuntime,
  };
}
