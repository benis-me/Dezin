import "@leafer-in/resize";
import { ScrollBar } from "@leafer-in/scroll";
import { useCallback, useEffect, useRef, useState } from "react";
import { DragEvent, EditorEvent, EditorMoveEvent, EditorRotateEvent, EditorScaleEvent, PointerEvent, PropertyEvent, ZoomEvent, type App } from "leafer-editor";
import { ViewportLighter } from "@dezin/leafer-react";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { selectAppNodesByIds } from "./leafer-adapter/editor-selection.ts";
import { CanvasSnap } from "./leafer-adapter/snap.ts";
import {
  contextTargetIdFromEvent,
  eventCanvasPoint,
  eventClientPoint,
  moveContainedNodesWithSections,
  normalizeCanvasRect,
  nodeIdFromTarget,
  nodeIdsFromTarget,
  rectFromBounds,
  resolveFloatingRect,
  rounded,
  sameFloatingRect,
  toInput,
  type CanvasDrawRect,
  type CanvasPoint,
  type CanvasRect,
  type ContextMenuState,
  type FloatingRect,
  type MoodboardCanvasTool,
} from "./canvas-utils.ts";

interface UseLeaferMoodboardRuntimeOptions {
  nodes: MoodboardNode[];
  selectedIds: string[];
  tool: MoodboardCanvasTool;
  onSelectIds: (ids: string[]) => void;
  onBlankTap: (point: { x: number; y: number }) => void;
  onSectionDraw: (rect: CanvasDrawRect) => void;
  onDoubleTap: (point: { x: number; y: number }) => void;
  onContextMenu: (menu: ContextMenuState) => void;
  onFrameStateChange: (nodes: SaveMoodboardNodeInput[]) => void;
}

export function useLeaferMoodboardRuntime({
  nodes,
  selectedIds,
  tool,
  onSelectIds,
  onBlankTap,
  onSectionDraw,
  onDoubleTap,
  onContextMenu,
  onFrameStateChange,
}: UseLeaferMoodboardRuntimeOptions) {
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [selectionRect, setSelectionRect] = useState<FloatingRect | null>(null);
  const [isTransforming, setIsTransforming] = useState(false);
  const [sectionDraftRect, setSectionDraftRect] = useState<CanvasRect | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<App | null>(null);
  const layerRef = useRef<any>(null);
  const viewportLighterRef = useRef<ViewportLighter | null>(null);
  const scrollBarRef = useRef<ScrollBar | null>(null);
  const snapRef = useRef<CanvasSnap | null>(null);
  const nodesRef = useRef(nodes);
  const selectedIdsRef = useRef(selectedIds);
  const toolRef = useRef(tool);
  const sectionDragStartRef = useRef<CanvasPoint | null>(null);
  const sectionDragHandledRef = useRef(false);
  const pointerSelectionHandledRef = useRef(false);
  const transformingRef = useRef(false);
  const floatingRectRef = useRef<FloatingRect | null>(null);
  const floatingRafRef = useRef<number | null>(null);
  const callbacksRef = useRef({ onSelectIds, onBlankTap, onSectionDraw, onDoubleTap, onContextMenu, onFrameStateChange });

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
    callbacksRef.current = { onSelectIds, onBlankTap, onSectionDraw, onDoubleTap, onContextMenu, onFrameStateChange };
  }, [onBlankTap, onContextMenu, onDoubleTap, onFrameStateChange, onSectionDraw, onSelectIds]);

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
    const id = selectedIdsRef.current.length === 1 ? selectedIdsRef.current[0] : null;
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
    if (transformingRef.current) return;
    if (floatingRafRef.current != null) return;
    floatingRafRef.current = window.requestAnimationFrame(() => {
      floatingRafRef.current = null;
      updateFloatingSelection();
    });
  }, [updateFloatingSelection]);

  const startTransforming = useCallback(() => {
    if (transformingRef.current) return;
    transformingRef.current = true;
    setIsTransforming(true);
  }, []);

  const finishTransforming = useCallback(() => {
    if (!transformingRef.current) return;
    transformingRef.current = false;
    setIsTransforming(false);
  }, []);

  const toViewportDraftRect = useCallback((rect: CanvasDrawRect): CanvasRect | null => {
    const tree: any = appRef.current?.tree;
    const scaleX = Number(tree?.scaleX ?? tree?.scale ?? 1) || 1;
    const scaleY = Number(tree?.scaleY ?? tree?.scale ?? 1) || 1;
    const left = Number(tree?.x ?? 0) + rect.x * scaleX;
    const top = Number(tree?.y ?? 0) + rect.y * scaleY;
    return rectFromBounds(left, top, left + rect.width * scaleX, top + rect.height * scaleY);
  }, []);

  const selectIdsInRuntime = useCallback(
    (ids: string[]) => {
      const editor = (appRef.current as any)?.editor;
      if (!editor) return;
      try {
        selectAppNodesByIds(appRef.current, ids);
        scheduleFloatingSelection();
      } catch {
        /* Leafer editor may not be ready during first paint. */
      }
    },
    [scheduleFloatingSelection],
  );

  const selectInRuntime = useCallback((id: string | null) => selectIdsInRuntime(id ? [id] : []), [selectIdsInRuntime]);

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
      const app = appRef.current;
      if (app) {
        try {
          snapRef.current?.enable(false);
          snapRef.current?.destroy();
          snapRef.current = new CanvasSnap(app, {
            parentContainer: layer,
            lineColor: "rgba(48, 112, 255, 0.76)",
            strokeWidth: 1,
          });
          snapRef.current.enable(true);
        } catch {
          snapRef.current = null;
        }
      }
      setRuntimeReady(true);
      selectIdsInRuntime(selectedIdsRef.current);
      scheduleFloatingSelection();
    },
    [scheduleFloatingSelection, selectIdsInRuntime],
  );

  useEffect(() => {
    return () => {
      viewportLighterRef.current?.destroy();
      viewportLighterRef.current = null;
      scrollBarRef.current?.destroy();
      scrollBarRef.current = null;
      snapRef.current?.enable(false);
      snapRef.current?.destroy();
      snapRef.current = null;
      appRef.current = null;
      layerRef.current = null;
      setRuntimeReady(false);
      transformingRef.current = false;
      setIsTransforming(false);
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
      const ids = nodeIdsFromTarget(event?.value ?? editor.target);
      selectedIdsRef.current = ids;
      callbacksRef.current.onSelectIds(ids);
      scheduleFloatingSelection();
    };
    const syncFloatingOnly = () => scheduleFloatingSelection();
    const syncAfterNodeTransform = () => {
      finishTransforming();
      flushFrameState();
      const scale = Number(app.tree?.scaleX ?? app.tree?.scale ?? 1);
      if (Number.isFinite(scale)) setZoom(scale);
      scheduleFloatingSelection();
    };
    const syncAfterViewportTransform = () => {
      finishTransforming();
      const scale = Number(app.tree?.scaleX ?? app.tree?.scale ?? 1);
      if (Number.isFinite(scale)) setZoom(scale);
      scheduleFloatingSelection();
    };
    const selectFromTarget = (target: unknown, event?: any) => {
      const targetId = nodeIdFromTarget(target);
      if (!targetId) return false;
      const current = selectedIdsRef.current;
      const source = event?.origin ?? event?.nativeEvent ?? event;
      const additive = Boolean(source?.metaKey || source?.ctrlKey || source?.shiftKey);
      const nextIds = additive ? toggleSelectionId(current, targetId) : [targetId];
      selectedIdsRef.current = nextIds;
      callbacksRef.current.onSelectIds(nextIds);
      selectIdsInRuntime(nextIds);
      scheduleFloatingSelection();
      return true;
    };
    const handlePointerDown = (event: any) => {
      pointerSelectionHandledRef.current = false;
      if (toolRef.current === "section" && !nodeIdFromTarget(event?.target)) {
        sectionDragStartRef.current = eventCanvasPoint(event);
        setSectionDraftRect(null);
        selectIdsInRuntime([]);
        return;
      }
      pointerSelectionHandledRef.current = selectFromTarget(event?.target, event);
    };
    const handleTap = (event: any) => {
      if (pointerSelectionHandledRef.current && nodeIdFromTarget(event?.target)) {
        pointerSelectionHandledRef.current = false;
        return;
      }
      pointerSelectionHandledRef.current = false;
      if (selectFromTarget(event?.target, event)) return;
      if (sectionDragHandledRef.current) {
        sectionDragHandledRef.current = false;
        return;
      }
      sectionDragStartRef.current = null;
      setSectionDraftRect(null);
      selectIdsInRuntime([]);
      callbacksRef.current.onBlankTap(eventCanvasPoint(event));
    };
    const handleDoubleTap = (event: any) => {
      if (nodeIdFromTarget(event?.target)) return;
      const point = eventCanvasPoint(event);
      if (Number.isFinite(point.x) && Number.isFinite(point.y)) callbacksRef.current.onDoubleTap(point);
    };
    const handleMenu = (event: any) => {
      event?.preventDefault?.();
      const containerRect = hostRef.current?.getBoundingClientRect();
      const client = eventClientPoint(
        event,
        containerRect ? { containerLeft: containerRect.left, containerTop: containerRect.top, tree: app?.tree } : undefined,
      );
      const point = eventCanvasPoint(event);
      const targetId = contextTargetIdFromEvent(event?.target, editor.target);
      if (targetId) {
        const nextIds = selectedIdsRef.current.includes(targetId) ? selectedIdsRef.current : [targetId];
        selectedIdsRef.current = nextIds;
        callbacksRef.current.onSelectIds(nextIds);
        selectIdsInRuntime(nextIds);
      }
      callbacksRef.current.onContextMenu({ x: client.x, y: client.y, canvasX: point.x, canvasY: point.y, targetId });
    };
    const syncDuringDrag = (event: any) => {
      if (toolRef.current === "section" && sectionDragStartRef.current) {
        const rect = normalizeCanvasRect(sectionDragStartRef.current, eventCanvasPoint(event));
        setSectionDraftRect(rect.width >= 4 && rect.height >= 4 ? toViewportDraftRect(rect) : null);
        return;
      }
      startTransforming();
    };
    const handleDragEnd = (event: any) => {
      if (toolRef.current === "section" && sectionDragStartRef.current) {
        const rect = normalizeCanvasRect(sectionDragStartRef.current, eventCanvasPoint(event));
        sectionDragStartRef.current = null;
        setSectionDraftRect(null);
        finishTransforming();
        if (rect.width >= 48 && rect.height >= 48) {
          sectionDragHandledRef.current = true;
          callbacksRef.current.onSectionDraw(rect);
        }
        return;
      }
      syncAfterNodeTransform();
    };
    const handleDragStart = () => {
      if (toolRef.current === "section" && sectionDragStartRef.current) return;
      startTransforming();
    };
    const handleZoomStart = () => startTransforming();
    const handleEditorTransform = () => startTransforming();

    app.on(PointerEvent.TAP, handleTap);
    app.on(PointerEvent.DOWN, handlePointerDown);
    app.on(PointerEvent.DOUBLE_TAP, handleDoubleTap);
    app.on(PointerEvent.MENU, handleMenu);
    app.on(DragEvent.START, handleDragStart);
    app.on(DragEvent.DRAG, syncDuringDrag);
    app.on(DragEvent.END, handleDragEnd);
    app.on(ZoomEvent.START, handleZoomStart);
    app.on(ZoomEvent.ZOOM, handleZoomStart);
    app.on(ZoomEvent.END, syncAfterViewportTransform);
    app.tree?.on?.(PropertyEvent.LEAFER_CHANGE, syncFloatingOnly);
    app.tree?.on?.("move", syncFloatingOnly);
    app.tree?.on?.("move.end", syncAfterViewportTransform);
    editor.on(EditorEvent.SELECT, syncSelectedFromEditor);
    editor.on(EditorEvent.HOVER, syncFloatingOnly);
    editor.on(EditorMoveEvent.MOVE, handleEditorTransform);
    editor.on(EditorScaleEvent.SCALE, handleEditorTransform);
    editor.on(EditorRotateEvent.ROTATE, handleEditorTransform);

    return () => {
      app.off(PointerEvent.TAP, handleTap);
      app.off(PointerEvent.DOWN, handlePointerDown);
      app.off(PointerEvent.DOUBLE_TAP, handleDoubleTap);
      app.off(PointerEvent.MENU, handleMenu);
      app.off(DragEvent.START, handleDragStart);
      app.off(DragEvent.DRAG, syncDuringDrag);
      app.off(DragEvent.END, handleDragEnd);
      app.off(ZoomEvent.START, handleZoomStart);
      app.off(ZoomEvent.ZOOM, handleZoomStart);
      app.off(ZoomEvent.END, syncAfterViewportTransform);
      app.tree?.off?.(PropertyEvent.LEAFER_CHANGE, syncFloatingOnly);
      app.tree?.off?.("move", syncFloatingOnly);
      app.tree?.off?.("move.end", syncAfterViewportTransform);
      editor.off(EditorEvent.SELECT, syncSelectedFromEditor);
      editor.off(EditorEvent.HOVER, syncFloatingOnly);
      editor.off(EditorMoveEvent.MOVE, handleEditorTransform);
      editor.off(EditorScaleEvent.SCALE, handleEditorTransform);
      editor.off(EditorRotateEvent.ROTATE, handleEditorTransform);
    };
  }, [finishTransforming, flushFrameState, runtimeReady, scheduleFloatingSelection, selectIdsInRuntime, startTransforming, toViewportDraftRect]);

  useEffect(() => {
    selectIdsInRuntime(selectedIds);
  }, [selectedIds, selectIdsInRuntime]);

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
          selectedIdsRef.current = [];
          if (tool !== "section") {
            sectionDragStartRef.current = null;
            sectionDragHandledRef.current = false;
            setSectionDraftRect(null);
          }
          callbacksRef.current.onSelectIds([]);
          scheduleFloatingSelection();
        } else {
          sectionDragStartRef.current = null;
          sectionDragHandledRef.current = false;
          setSectionDraftRect(null);
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
    isTransforming,
    sectionDraftRect,
    zoom,
    changeZoom,
    fitView,
    handleAppReady,
    handleLayerCreated,
    selectInRuntime,
    selectIdsInRuntime,
    hoverInRuntime,
  };
}

function toggleSelectionId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}
