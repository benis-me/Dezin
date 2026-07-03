import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { EffectDetail } from "../lib/api.ts";
import { renderEffectCanvas, type EffectValues } from "./effect-renderer.ts";
import { isGlslEffect, isPaperEffect, PaperEffectRenderer } from "./PaperEffectRenderer.tsx";

export interface EffectPreviewHandle {
  exportPng(name: string): void;
}

export const EffectPreviewCanvas = forwardRef<
  EffectPreviewHandle,
  {
    effect: EffectDetail;
    values: EffectValues;
    paused?: boolean;
    className?: string;
  }
>(function EffectPreviewCanvas({ effect, values, paused = false, className = "" }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const valuesRef = useRef(values);
  const effectRef = useRef(effect);

  valuesRef.current = values;
  effectRef.current = effect;
  const usesPaperRuntime = isPaperEffect(effect) || isGlslEffect(effect);

  useImperativeHandle(ref, () => ({
    exportPng(name: string) {
      const canvas = canvasRef.current ?? containerRef.current?.querySelector("canvas") ?? null;
      if (!canvas) return;
      const url = canvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "effect"}.png`;
      link.click();
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || usesPaperRuntime) return;
    let frame = 0;
    let stopped = false;
    const started = performance.now();

    const draw = () => {
      if (stopped) return;
      const time = paused ? 0 : (performance.now() - started) / 1000;
      renderEffectCanvas(canvas, effectRef.current, valuesRef.current, time);
      frame = window.requestAnimationFrame(draw);
    };

    draw();
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
    };
  }, [paused, usesPaperRuntime]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || usesPaperRuntime || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => renderEffectCanvas(canvas, effectRef.current, valuesRef.current, 0));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [usesPaperRuntime]);

  return (
    <div ref={containerRef} className={`h-full w-full overflow-hidden rounded-lg border border-border bg-[var(--surface)] ${className}`}>
      {usesPaperRuntime ? (
        <PaperEffectRenderer effect={effect} values={values} />
      ) : (
        <canvas
          ref={canvasRef}
          className="h-full w-full"
        />
      )}
    </div>
  );
});
