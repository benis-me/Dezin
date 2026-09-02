import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface SelectionGhost {
  id: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The brief afterimage of a marquee selection: React Flow removes its selection
 * box instantly, so the last measured rectangle fades out for 180ms instead.
 */
export function useSelectionGhost({
  surfaceRef,
  reduceMotion,
}: {
  surfaceRef: RefObject<HTMLElement | null>;
  reduceMotion: boolean;
}) {
  const timerRef = useRef<number | null>(null);
  const rectRef = useRef<Omit<SelectionGhost, "id"> | null>(null);
  const sequenceRef = useRef(0);
  const [selectionGhost, setSelectionGhost] = useState<SelectionGhost | null>(null);

  const captureSelectionRect = useCallback(() => {
    const surface = surfaceRef.current;
    const selection = surface?.querySelector<HTMLElement>(".react-flow__selection");
    if (!surface || !selection) return;
    const surfaceBounds = surface.getBoundingClientRect();
    const selectionBounds = selection.getBoundingClientRect();
    if (selectionBounds.width < 1 || selectionBounds.height < 1) return;
    rectRef.current = {
      left: selectionBounds.left - surfaceBounds.left,
      top: selectionBounds.top - surfaceBounds.top,
      width: selectionBounds.width,
      height: selectionBounds.height,
    };
  }, [surfaceRef]);

  const onSelectionStart = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    rectRef.current = null;
    setSelectionGhost(null);
  }, []);

  const onSelectionEnd = useCallback(() => {
    captureSelectionRect();
    const rect = rectRef.current;
    if (!rect || reduceMotion) {
      rectRef.current = null;
      return;
    }
    const ghost = { ...rect, id: sequenceRef.current + 1 };
    sequenceRef.current = ghost.id;
    setSelectionGhost(ghost);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setSelectionGhost((current) => current?.id === ghost.id ? null : current);
    }, 180);
    rectRef.current = null;
  }, [captureSelectionRect, reduceMotion]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return { selectionGhost, captureSelectionRect, onSelectionStart, onSelectionEnd };
}
