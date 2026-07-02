import "@leafer-in/resize";
import { ScrollBar } from "@leafer-in/scroll";
import { useCallback, useEffect, useRef, useState } from "react";
import { DragEvent, EditorEvent, EditorMoveEvent, EditorRotateEvent, EditorScaleEvent, PointerEvent, PropertyEvent, ZoomEvent, type App } from "leafer-editor";
import { ViewportLighter } from "@dezin/leafer-react";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { selectAppNodesByIds } from "./leafer-adapter/editor-selection.ts";
import { CanvasSnap } from "./leafer-adapter/snap.ts";
import {
  clientPointToCanvasPoint,
  collectFloatingOccluderRects,
  containedNodeIdsForSection,
  contextTargetIdFromEvent,
  eventCanvasPoint,
  eventClientPoint,
  moveContainedNodesWithSections,
  normalizeCanvasRect,
  nodeIdFromTarget,
  nodeIdsFromTarget,
  rectFromBounds,
  resolveAnchoredZoomTransform,
  resolveCanvasFitTransform,
  resolveFloatingRect,
  rounded,
  sameFloatingRect,
  sameIdList,
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
  onFrameStateDraftChange: (nodes: SaveMoodboardNodeInput[] | null) => void;
}

const FLOATING_TRACK_MS = 420;
export const MOODBOARD_SCROLLBAR_PADDING = 1;

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
  onFrameStateDraftChange,
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
  const sectionChildrenDragRef = useRef<SectionChildrenDragState | null>(null);
  const sectionDragHandledRef = useRef(false);
  const pointerSelectionHandledRef = useRef(false);
  const lastCanvasPointRef = useRef<CanvasPoint | null>(null);
  const transformingRef = useRef(false);
  const floatingRectRef = useRef<FloatingRect | null>(null);
  const floatingRafRef = useRef<number | null>(null);
  const floatingTrackRafRef = useRef<number | null>(null);
  const frameDraftRafRef = useRef<number | null>(null);
  const floatingTrackUntilRef = useRef(0);
  const callbacksRef = useRef({ onSelectIds, onBlankTap, onSectionDraw, onDoubleTap, onContextMenu, onFrameStateChange, onFrameStateDraftChange });

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
    callbacksRef.current = { onSelectIds, onBlankTap, onSectionDraw, onDoubleTap, onContextMenu, onFrameStateChange, onFrameStateDraftChange };
  }, [onBlankTap, onContextMenu, onDoubleTap, onFrameStateChange, onFrameStateDraftChange, onSectionDraw, onSelectIds]);

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

  const commitSelectedIdsFromRuntime = useCallback((ids: string[]) => {
    if (sameIdList(selectedIdsRef.current, ids)) return false;
    selectedIdsRef.current = ids;
    callbacksRef.current.onSelectIds(ids);
    return true;
  }, []);

  const updateFloatingSelection = useCallback(() => {
    const ids = selectedIdsRef.current;
    const frames = ids.map((id) => findFrame(id)).filter((frame): frame is NonNullable<typeof frame> => Boolean(frame));
    const container = hostRef.current;
    const app: any = appRef.current;
    if (frames.length === 0 || !container) {
      commitSelectionRect(null);
      return;
    }
    const frame = frames.length === 1 ? frames[0] : unionFrameBounds(frames, "boxBounds");
    const world = frames.length === 1 ? frames[0].worldBoxBounds ?? frames[0].boxBounds : unionFrameBounds(frames, "worldBoxBounds");

    const containerRect = container.getBoundingClientRect();
    commitSelectionRect(
      resolveFloatingRect({
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
        containerLeft: containerRect.left,
        containerTop: containerRect.top,
        frame,
        tree: app?.tree,
        world,
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

  const trackFloatingSelection = useCallback(() => {
    scheduleFloatingSelection();
    floatingTrackUntilRef.current = Math.max(floatingTrackUntilRef.current, nowMs() + FLOATING_TRACK_MS);
    if (floatingTrackRafRef.current != null) return;
    const tick = (time: number) => {
      floatingTrackRafRef.current = null;
      if (time > floatingTrackUntilRef.current) return;
      scheduleFloatingSelection();
      floatingTrackRafRef.current = window.requestAnimationFrame(tick);
    };
    floatingTrackRafRef.current = window.requestAnimationFrame(tick);
  }, [scheduleFloatingSelection]);

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

  const setLastCanvasPoint = useCallback((point: CanvasPoint) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    lastCanvasPointRef.current = point;
  }, []);

  const getLastCanvasPoint = useCallback(() => lastCanvasPointRef.current, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const updateFromPointer = (event: globalThis.PointerEvent) => {
      const rect = host.getBoundingClientRect();
      setLastCanvasPoint(
        clientPointToCanvasPoint({
          clientX: event.clientX,
          clientY: event.clientY,
          containerLeft: rect.left,
          containerTop: rect.top,
          tree: (appRef.current as any)?.tree,
        }),
      );
    };
    host.addEventListener("pointermove", updateFromPointer);
    host.addEventListener("pointerdown", updateFromPointer);
    return () => {
      host.removeEventListener("pointermove", updateFromPointer);
      host.removeEventListener("pointerdown", updateFromPointer);
    };
  }, [runtimeReady, setLastCanvasPoint]);

  const selectIdsInRuntime = useCallback(
    (ids: string[]) => {
      const editor = (appRef.current as any)?.editor;
      if (!editor) return;
      try {
        if (sameIdList(nodeIdsFromTarget(editor.target), ids)) {
          scheduleFloatingSelection();
          return;
        }
        selectAppNodesByIds(appRef.current, ids);
        scheduleFloatingSelection();
      } catch {
        /* Leafer editor may not be ready during first paint. */
      }
    },
    [scheduleFloatingSelection],
  );

  const selectInRuntime = useCallback((id: string | null) => selectIdsInRuntime(id ? [id] : []), [selectIdsInRuntime]);

  const refreshSelectionInRuntime = useCallback(
    (ids = selectedIdsRef.current, options: { resetEditor?: boolean } = {}) => {
      const app: any = appRef.current;
      const editor = app?.editor;
      if (!editor) return;
      const nextIds = ids.filter((id) => findFrame(id));
      const refresh = (resetEditor = false) => {
        if (resetEditor) {
          try {
            editor.cancel?.();
          } catch {
            /* Some Leafer builds do not expose cancel during early setup. */
          }
        }
        try {
          selectAppNodesByIds(appRef.current, nextIds);
        } catch {
          selectAppNodesByIds(appRef.current, nextIds);
        }
        try {
          editor.update?.();
          editor.selector?.update?.();
          editor.selector?.forceUpdate?.();
        } catch {
          /* Editor selector internals vary between Leafer builds. */
        }
        scheduleFloatingSelection();
      };
      refresh(options.resetEditor === true);
      window.requestAnimationFrame(() => {
        refresh(options.resetEditor === true);
        window.setTimeout(() => refresh(true), 80);
        window.setTimeout(refresh, 200);
      });
    },
    [findFrame, scheduleFloatingSelection],
  );

  const syncNodeInputsInRuntime = useCallback(
    (inputs: SaveMoodboardNodeInput[], idsToReselect = selectedIdsRef.current) => {
      const app: any = appRef.current;
      if (!app) return;
      inputs.forEach((input) => {
        const frame = findFrame(input.id);
        if (!frame) return;
        const patch = {
          x: input.x,
          y: input.y,
          width: input.width,
          height: input.height,
          rotation: input.rotation ?? 0,
          zIndex: input.zIndex ?? 0,
        };
        try {
          if (typeof frame.set === "function") {
            frame.set(patch);
          } else {
            Object.assign(frame, patch);
          }
          frame.forceUpdate?.();
          frame.updateLayout?.();
        } catch {
          Object.assign(frame, patch);
        }
      });
      app.tree?.forceUpdate?.();
      app.forceUpdate?.();
      refreshSelectionInRuntime(idsToReselect, { resetEditor: true });
    },
    [findFrame, refreshSelectionInRuntime],
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

  const readFrameStateInputs = useCallback((): SaveMoodboardNodeInput[] => {
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
    return moveContainedNodesWithSections(nodesRef.current, next);
  }, [findFrame]);

  const publishFrameStateDraft = useCallback(() => {
    if (frameDraftRafRef.current != null) return;
    frameDraftRafRef.current = window.requestAnimationFrame(() => {
      frameDraftRafRef.current = null;
      callbacksRef.current.onFrameStateDraftChange(readFrameStateInputs());
    });
  }, [readFrameStateInputs]);

  const flushFrameState = useCallback(() => {
    callbacksRef.current.onFrameStateChange(readFrameStateInputs());
  }, [readFrameStateInputs]);

  const beginSectionChildrenDrag = useCallback(
    (event: any) => {
      const targetId = nodeIdFromTarget(event?.target);
      const selected = selectedIdsRef.current;
      const candidateIds = selected.length === 1 ? selected : targetId ? [targetId] : [];
      const sectionId = candidateIds.find((id) => nodesRef.current.find((node) => node.id === id)?.type === "section");
      if (!sectionId) {
        sectionChildrenDragRef.current = null;
        return;
      }
      const frame = findFrame(sectionId);
      if (!frame) {
        sectionChildrenDragRef.current = null;
        return;
      }
      const childIds = containedNodeIdsForSection(nodesRef.current, sectionId).filter((id) => !selected.includes(id));
      sectionChildrenDragRef.current = {
        sectionId,
        childIds,
        lastX: Number(frame.x ?? 0),
        lastY: Number(frame.y ?? 0),
      };
    },
    [findFrame],
  );

  const syncSectionChildrenDuringDrag = useCallback(() => {
    const state = sectionChildrenDragRef.current;
    if (!state || state.childIds.length === 0) return;
    const sectionFrame = findFrame(state.sectionId);
    if (!sectionFrame) return;
    const nextX = Number(sectionFrame.x ?? state.lastX);
    const nextY = Number(sectionFrame.y ?? state.lastY);
    const dx = nextX - state.lastX;
    const dy = nextY - state.lastY;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;

    state.childIds.forEach((id) => {
      const frame = findFrame(id);
      if (!frame) return;
      setFramePosition(frame, Number(frame.x ?? 0) + dx, Number(frame.y ?? 0) + dy);
    });
    state.lastX = nextX;
    state.lastY = nextY;
    const app: any = appRef.current;
    app?.tree?.forceUpdate?.();
    app?.forceUpdate?.();
  }, [findFrame]);

  const handleAppReady = useCallback((app: App) => {
    appRef.current = app;
    try {
      scrollBarRef.current?.destroy();
      scrollBarRef.current = new ScrollBar(app as any, {
        theme: { fill: "rgba(35,35,32,0.32)", stroke: "rgba(255,255,255,0.78)" },
        padding: MOODBOARD_SCROLLBAR_PADDING,
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
      if (floatingTrackRafRef.current != null) {
        window.cancelAnimationFrame(floatingTrackRafRef.current);
        floatingTrackRafRef.current = null;
      }
      if (frameDraftRafRef.current != null) {
        window.cancelAnimationFrame(frameDraftRafRef.current);
        frameDraftRafRef.current = null;
      }
      callbacksRef.current.onFrameStateDraftChange(null);
    };
  }, []);

  useEffect(() => {
    const app: any = appRef.current;
    const editor = app?.editor;
    if (!runtimeReady || !app || !editor) return;

    const syncSelectedFromEditor = (event?: any) => {
      const ids = nodeIdsFromTarget(event?.value ?? editor.target);
      commitSelectedIdsFromRuntime(ids);
      scheduleFloatingSelection();
    };
    const syncFloatingOnly = () => scheduleFloatingSelection();
    const trackFloatingOnly = () => trackFloatingSelection();
    const syncDuringViewportTransform = () => {
      startTransforming();
      const scale = Number(app.tree?.scaleX ?? app.tree?.scale ?? 1);
      if (Number.isFinite(scale)) setZoom(scale);
      trackFloatingSelection();
    };
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
      trackFloatingSelection();
    };
    const selectFromTarget = (target: unknown, event?: any) => {
      const targetId = nodeIdFromTarget(target);
      if (!targetId) return false;
      const current = selectedIdsRef.current;
      const source = event?.origin ?? event?.nativeEvent ?? event;
      const additive = Boolean(source?.metaKey || source?.ctrlKey || source?.shiftKey);
      const nextIds = additive ? toggleSelectionId(current, targetId) : [targetId];
      const changed = commitSelectedIdsFromRuntime(nextIds);
      if (changed) selectIdsInRuntime(nextIds);
      scheduleFloatingSelection();
      return true;
    };
    const handlePointerDown = (event: any) => {
      const point = eventCanvasPoint(event);
      setLastCanvasPoint(point);
      pointerSelectionHandledRef.current = false;
      if (toolRef.current === "section" && !nodeIdFromTarget(event?.target)) {
        sectionDragStartRef.current = point;
        setSectionDraftRect(null);
        selectIdsInRuntime([]);
        return;
      }
      pointerSelectionHandledRef.current = selectFromTarget(event?.target, event);
    };
    const handleTap = (event: any) => {
      const point = eventCanvasPoint(event);
      setLastCanvasPoint(point);
      if (pointerSelectionHandledRef.current && nodeIdFromTarget(event?.target)) {
        pointerSelectionHandledRef.current = false;
        return;
      }
      pointerSelectionHandledRef.current = false;
	      if (selectFromTarget(event?.target, event)) return;
      if (contextTargetIdFromEvent(event?.target, editor.target)) {
        scheduleFloatingSelection();
        return;
      }
	      if (sectionDragHandledRef.current) {
	        sectionDragHandledRef.current = false;
	        return;
      }
      sectionDragStartRef.current = null;
      setSectionDraftRect(null);
      selectIdsInRuntime([]);
      callbacksRef.current.onBlankTap(point);
    };
    const handleDoubleTap = (event: any) => {
      const point = eventCanvasPoint(event);
      setLastCanvasPoint(point);
      if (nodeIdFromTarget(event?.target)) return;
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
      setLastCanvasPoint(point);
      const targetId = contextTargetIdFromEvent(event?.target, editor.target);
      if (targetId) {
        const nextIds = selectedIdsRef.current.includes(targetId) ? selectedIdsRef.current : [targetId];
        const changed = commitSelectedIdsFromRuntime(nextIds);
        if (changed) selectIdsInRuntime(nextIds);
      }
      callbacksRef.current.onContextMenu({ x: client.x, y: client.y, canvasX: point.x, canvasY: point.y, targetId });
    };
    const syncDuringDrag = (event: any) => {
      const point = eventCanvasPoint(event);
      setLastCanvasPoint(point);
      if (toolRef.current === "section" && sectionDragStartRef.current) {
        const rect = normalizeCanvasRect(sectionDragStartRef.current, point);
        setSectionDraftRect(rect.width >= 4 && rect.height >= 4 ? toViewportDraftRect(rect) : null);
        return;
      }
      startTransforming();
      syncSectionChildrenDuringDrag();
      publishFrameStateDraft();
      trackFloatingSelection();
    };
    const handleDragEnd = (event: any) => {
      const point = eventCanvasPoint(event);
      setLastCanvasPoint(point);
      if (toolRef.current === "section" && sectionDragStartRef.current) {
        const rect = normalizeCanvasRect(sectionDragStartRef.current, point);
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
      sectionChildrenDragRef.current = null;
    };
    const handleDragStart = (event: any) => {
      if (toolRef.current === "section" && sectionDragStartRef.current) return;
      beginSectionChildrenDrag(event);
      startTransforming();
    };
    const handleZoomStart = () => {
      startTransforming();
      trackFloatingSelection();
    };
    const handleEditorTransform = () => {
      startTransforming();
      publishFrameStateDraft();
      trackFloatingSelection();
    };

    app.on(PointerEvent.TAP, handleTap);
    app.on(PointerEvent.DOWN, handlePointerDown);
    app.on(PointerEvent.DOUBLE_TAP, handleDoubleTap);
    app.on(PointerEvent.MENU, handleMenu);
    app.on(DragEvent.START, handleDragStart);
    app.on(DragEvent.DRAG, syncDuringDrag);
    app.on(DragEvent.END, handleDragEnd);
    app.on(ZoomEvent.START, handleZoomStart);
    app.on(ZoomEvent.ZOOM, syncDuringViewportTransform);
    app.on(ZoomEvent.END, syncAfterViewportTransform);
    app.tree?.on?.(PropertyEvent.LEAFER_CHANGE, trackFloatingOnly);
    app.tree?.on?.("move", trackFloatingOnly);
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
      app.off(ZoomEvent.ZOOM, syncDuringViewportTransform);
      app.off(ZoomEvent.END, syncAfterViewportTransform);
      app.tree?.off?.(PropertyEvent.LEAFER_CHANGE, trackFloatingOnly);
      app.tree?.off?.("move", trackFloatingOnly);
      app.tree?.off?.("move.end", syncAfterViewportTransform);
      editor.off(EditorEvent.SELECT, syncSelectedFromEditor);
      editor.off(EditorEvent.HOVER, syncFloatingOnly);
      editor.off(EditorMoveEvent.MOVE, handleEditorTransform);
      editor.off(EditorScaleEvent.SCALE, handleEditorTransform);
      editor.off(EditorRotateEvent.ROTATE, handleEditorTransform);
    };
  }, [beginSectionChildrenDrag, commitSelectedIdsFromRuntime, finishTransforming, flushFrameState, publishFrameStateDraft, runtimeReady, scheduleFloatingSelection, selectIdsInRuntime, startTransforming, syncSectionChildrenDuringDrag, toViewportDraftRect, trackFloatingSelection]);

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
      const container = hostRef.current;
      const tree = app?.tree;
      const clamped = Math.max(0.1, Math.min(4, next));
      if (tree) {
        const transform = resolveAnchoredZoomTransform({
          currentX: Number(tree.x ?? 0),
          currentY: Number(tree.y ?? 0),
          currentScale: Number(tree.scaleX ?? tree.scale ?? 1),
          nextScale: clamped,
          anchorX: container ? container.clientWidth / 2 : 0,
          anchorY: container ? container.clientHeight / 2 : 0,
        });
        tree.x = transform.x;
        tree.y = transform.y;
        tree.scaleX = transform.scale;
        tree.scaleY = transform.scale;
        tree.forceUpdate?.();
      }
      setZoom(clamped);
      trackFloatingSelection();
    },
    [trackFloatingSelection],
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
    trackFloatingSelection();
  }, [changeZoom, trackFloatingSelection]);

  const fitNodes = useCallback(
    (ids: string[], options: { padding?: number; maxScale?: number } = {}) => {
      const app: any = appRef.current;
      const container = hostRef.current;
      const tree = app?.tree;
      const targetIds = new Set(ids);
      const currentNodes = nodesRef.current.filter((node) => targetIds.has(node.id));
      if (!tree || !container || currentNodes.length === 0) return false;

      const left = Math.min(...currentNodes.map((node) => node.x));
      const top = Math.min(...currentNodes.map((node) => node.y));
      const right = Math.max(...currentNodes.map((node) => node.x + node.width));
      const bottom = Math.max(...currentNodes.map((node) => node.y + node.height));
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);
      const padding = options.padding ?? 128;
      const maxScale = options.maxScale ?? 2.4;
      const transform = resolveCanvasFitTransform({
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
        contentRect: rectFromBounds(left, top, left + width, top + height),
        occluders: collectFloatingOccluderRects(container, container.closest("[data-moodboard-canvas-root]") ?? container),
        padding,
        maxScale,
      });

      tree.scaleX = transform.scale;
      tree.scaleY = transform.scale;
      tree.x = transform.x;
      tree.y = transform.y;
      tree.forceUpdate?.();
      setZoom(transform.scale);
      trackFloatingSelection();
      return true;
    },
    [trackFloatingSelection],
  );

  return {
    appRef,
    hostRef,
    runtimeReady,
    selectionRect,
    isTransforming,
    sectionDraftRect,
    zoom,
    changeZoom,
    fitView,
    fitNodes,
    handleAppReady,
    handleLayerCreated,
    selectInRuntime,
    selectIdsInRuntime,
    refreshSelectionInRuntime,
    syncNodeInputsInRuntime,
    hoverInRuntime,
    getLastCanvasPoint,
  };
}

interface SectionChildrenDragState {
  sectionId: string;
  childIds: string[];
  lastX: number;
  lastY: number;
}

function setFramePosition(frame: any, x: number, y: number): void {
  try {
    if (typeof frame.set === "function") frame.set({ x, y });
    else Object.assign(frame, { x, y });
    frame.forceUpdate?.();
    frame.updateLayout?.();
  } catch {
    Object.assign(frame, { x, y });
  }
}

function nowMs(): number {
  return window.performance?.now?.() ?? Date.now();
}

function toggleSelectionId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function unionFrameBounds(frames: any[], key: "boxBounds" | "worldBoxBounds" = "worldBoxBounds"): { x: number; y: number; width: number; height: number } {
  const bounds = frames
    .map((frame) => (key === "boxBounds" && hasUsableFrameBounds(frame) ? frame : frame[key] ?? frame))
    .map((bound) => ({
      x: Number(bound?.x ?? 0),
      y: Number(bound?.y ?? 0),
      width: Math.max(1, Number(bound?.width ?? 0) || 1),
      height: Math.max(1, Number(bound?.height ?? 0) || 1),
    }));
  const left = Math.min(...bounds.map((bound) => bound.x));
  const top = Math.min(...bounds.map((bound) => bound.y));
  const right = Math.max(...bounds.map((bound) => bound.x + bound.width));
  const bottom = Math.max(...bounds.map((bound) => bound.y + bound.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function hasUsableFrameBounds(frame: any): boolean {
  return [frame?.x, frame?.y, frame?.width, frame?.height].every((value) => Number.isFinite(Number(value)));
}
