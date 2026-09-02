import type { OnMove, OnMoveEnd, ReactFlowInstance, Viewport } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import type { DesignFlowNode } from "./DesignCanvasNode.tsx";
import { sameViewport, syncHoverLabelViewportScale } from "./design-canvas-screen-helpers.ts";
import type { DesignCanvas, DesignCanvasIntent } from "./types.ts";

/**
 * Viewport authority for the canvas: the local React Flow viewport, its
 * debounced persistence to the daemon, the initial viewport applied once per
 * project, the focus-mode viewport lock, and the layout nonce that re-measures
 * floating chrome after any geometry change.
 */
export function useCanvasViewport({
  surfaceRef,
  flowRef,
  projectId,
  applyIntents,
  refresh,
}: {
  surfaceRef: RefObject<HTMLElement | null>;
  flowRef: RefObject<ReactFlowInstance<DesignFlowNode> | null>;
  projectId: string;
  applyIntents: (intents: DesignCanvasIntent[]) => Promise<DesignCanvas>;
  refresh: () => Promise<unknown>;
}) {
  const viewportSaveTimerRef = useRef<number | null>(null);
  const localViewportTargetRef = useRef<Viewport | null>(null);
  const authoritativeViewportRef = useRef<Viewport | null>(null);
  const focusViewportLockRef = useRef<Viewport | null>(null);
  const mountedViewportProjectRef = useRef<string | null>(null);
  const layoutFrameRef = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [layoutNonce, setLayoutNonce] = useState(0);

  const bumpLayout = useCallback(() => {
    if (layoutFrameRef.current !== null) return;
    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = null;
      setLayoutNonce((current) => current + 1);
    });
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const observer = new ResizeObserver(bumpLayout);
    observer.observe(surface);
    window.addEventListener("resize", bumpLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", bumpLayout);
    };
  }, [bumpLayout, surfaceRef]);

  const applyInitialViewport = useCallback((instance: ReactFlowInstance<DesignFlowNode>, target: Viewport) => {
    mountedViewportProjectRef.current = projectId;
    const mounted = instance.getViewport();
    if (sameViewport(mounted, target)) {
      syncHoverLabelViewportScale(surfaceRef.current, mounted.zoom);
      setZoom(mounted.zoom);
      return;
    }
    void instance.setViewport({ ...target }, { duration: 0 }).then(() => {
      if (flowRef.current !== instance) return;
      const currentZoom = instance.getZoom();
      syncHoverLabelViewportScale(surfaceRef.current, currentZoom);
      setZoom(currentZoom);
      bumpLayout();
    }).catch(() => {
      if (flowRef.current === instance) {
        const currentZoom = instance.getZoom();
        syncHoverLabelViewportScale(surfaceRef.current, currentZoom);
        setZoom(currentZoom);
      }
    });
  }, [bumpLayout, flowRef, projectId, surfaceRef]);

  const onFlowInit = useCallback((instance: ReactFlowInstance<DesignFlowNode>) => {
    flowRef.current = instance;
    syncHoverLabelViewportScale(surfaceRef.current, instance.getZoom());
    const target = authoritativeViewportRef.current;
    if (target) applyInitialViewport(instance, target);
    else setZoom(instance.getZoom());
    bumpLayout();
  }, [applyInitialViewport, bumpLayout, flowRef, surfaceRef]);

  /** Drop a debounced viewport write, e.g. when focus mode takes over the viewport. */
  const cancelPendingViewportSave = useCallback(() => {
    if (viewportSaveTimerRef.current !== null) {
      window.clearTimeout(viewportSaveTimerRef.current);
      viewportSaveTimerRef.current = null;
      localViewportTargetRef.current = null;
    }
  }, []);

  const persistViewport = useCallback((viewport: Viewport) => {
    const current = authoritativeViewportRef.current;
    if (sameViewport(current, viewport) || sameViewport(localViewportTargetRef.current, viewport)) return;
    if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
    const intendedViewport = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
    localViewportTargetRef.current = intendedViewport;
    viewportSaveTimerRef.current = window.setTimeout(() => {
      viewportSaveTimerRef.current = null;
      const latest = authoritativeViewportRef.current;
      if (sameViewport(latest, intendedViewport)) {
        if (sameViewport(localViewportTargetRef.current, intendedViewport)) localViewportTargetRef.current = null;
        return;
      }
      void applyIntents([{
        type: "set-viewport",
        viewport: intendedViewport,
      }]).catch(() => {
        void refresh();
      }).finally(() => {
        if (sameViewport(localViewportTargetRef.current, intendedViewport)) localViewportTargetRef.current = null;
      });
    }, 500);
  }, [applyIntents, refresh]);

  const restoreLockedFocusViewport = useCallback((viewport: Viewport): boolean => {
    const locked = focusViewportLockRef.current;
    if (!locked) return false;
    syncHoverLabelViewportScale(surfaceRef.current, locked.zoom);
    setZoom(locked.zoom);
    if (!sameViewport(viewport, locked)) {
      void flowRef.current?.setViewport({ ...locked }, { duration: 0 }).catch(() => undefined);
    }
    return true;
  }, [flowRef, surfaceRef]);

  const onMove = useCallback<OnMove>((_event, viewport) => {
    if (restoreLockedFocusViewport(viewport)) return;
    setZoom(viewport.zoom);
    bumpLayout();
  }, [bumpLayout, restoreLockedFocusViewport]);

  const onViewportChange = useCallback((viewport: Viewport) => {
    // XYFlow updates its viewport transform outside React's render path. Write
    // the matching counter-scale in that same hot path, before the next paint.
    syncHoverLabelViewportScale(surfaceRef.current, viewport.zoom);
  }, [surfaceRef]);

  const onMoveEnd = useCallback<OnMoveEnd>((_event, viewport) => {
    if (restoreLockedFocusViewport(viewport)) return;
    setZoom(viewport.zoom);
    persistViewport(viewport);
  }, [persistViewport, restoreLockedFocusViewport]);

  useEffect(() => () => {
    if (layoutFrameRef.current !== null) window.cancelAnimationFrame(layoutFrameRef.current);
    if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
    focusViewportLockRef.current = null;
    mountedViewportProjectRef.current = null;
  }, []);

  return {
    zoom,
    setZoom,
    layoutNonce,
    bumpLayout,
    applyInitialViewport,
    onFlowInit,
    onMove,
    onMoveEnd,
    onViewportChange,
    cancelPendingViewportSave,
    authoritativeViewportRef,
    focusViewportLockRef,
    mountedViewportProjectRef,
  };
}
