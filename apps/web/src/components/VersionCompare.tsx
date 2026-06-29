import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Columns2, GripVertical, SlidersHorizontal } from "lucide-react";
import { Dialog, Segmented } from "./ui/index.ts";

interface Side {
  url: string;
  label: string;
}

/** Visual diff between two versions/branches: side-by-side, or a before/after slider. */
export function VersionCompare({ open, onClose, a, b }: { open: boolean; onClose: () => void; a: Side; b: Side }) {
  const [mode, setMode] = useState<"slider" | "split">("slider");
  const [pos, setPos] = useState(50);
  const wrapRef = useRef<HTMLDivElement>(null);
  const aRef = useRef<HTMLIFrameElement>(null);
  const bRef = useRef<HTMLIFrameElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);

  // Drive the drag through the DOM directly (no per-frame React re-render of the iframes),
  // and turn off the iframes' hit-testing so fast drags don't get swallowed by them.
  const drag = (e: ReactMouseEvent): void => {
    e.preventDefault();
    let p = pos;
    if (aRef.current) aRef.current.style.pointerEvents = "none";
    if (bRef.current) bRef.current.style.pointerEvents = "none";
    const move = (ev: MouseEvent): void => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      p = Math.min(99, Math.max(1, ((ev.clientX - rect.left) / rect.width) * 100));
      if (bRef.current) bRef.current.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
      if (handleRef.current) handleRef.current.style.left = `${p}%`;
    };
    const up = (): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      if (aRef.current) aRef.current.style.pointerEvents = "";
      if (bRef.current) bRef.current.style.pointerEvents = "";
      setPos(p);
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const tag = "pointer-events-none absolute top-2.5 z-10 rounded-md bg-foreground/85 px-2 py-0.5 text-[11px] font-medium text-background";

  return (
    <Dialog open={open} onClose={onClose} label="Compare versions" className="sm:max-w-[92vw]" showClose>
      <div className="flex h-[82vh] flex-col">
        {/* toggle sits on the left so it never collides with the Dialog close button */}
        <div className="flex items-center gap-3 border-b border-border py-2 pl-3 pr-12">
          <Segmented
            ariaLabel="Compare mode"
            size="sm"
            value={mode}
            onChange={(v) => setMode(v as typeof mode)}
            options={[
              { value: "slider", title: "Before / after slider", icon: <SlidersHorizontal size={14} strokeWidth={1.75} /> },
              { value: "split", title: "Side by side", icon: <Columns2 size={14} strokeWidth={1.75} /> },
            ]}
          />
          <span className="truncate text-sm font-medium">
            {a.label} <span className="text-muted-foreground">↔</span> {b.label}
          </span>
        </div>
        <div ref={wrapRef} className="relative flex-1 overflow-hidden bg-surface-2">
          {mode === "split" ? (
            <div className="flex h-full">
              <div className="relative h-full flex-1 border-r border-border">
                <span className={`${tag} left-2.5`}>{a.label}</span>
                <iframe src={a.url} title={a.label} className="h-full w-full bg-white" />
              </div>
              <div className="relative h-full flex-1">
                <span className={`${tag} left-2.5`}>{b.label}</span>
                <iframe src={b.url} title={b.label} className="h-full w-full bg-white" />
              </div>
            </div>
          ) : (
            <>
              {/* A fills the pane; B is full-size too but clip-path reveals only its left portion */}
              <iframe ref={aRef} src={a.url} title={a.label} className="absolute inset-0 h-full w-full bg-white" />
              <iframe
                ref={bRef}
                src={b.url}
                title={b.label}
                className="absolute inset-0 h-full w-full bg-white"
                style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
              />
              <span className={`${tag} left-2.5`}>{b.label}</span>
              <span className={`${tag} right-2.5`}>{a.label}</span>
              <button
                ref={handleRef}
                type="button"
                aria-label="Drag to compare"
                onMouseDown={drag}
                className="absolute inset-y-0 z-20 grid w-5 -translate-x-1/2 cursor-col-resize place-items-center"
                style={{ left: `${pos}%` }}
              >
                <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary" />
                <span className="relative grid size-7 place-items-center rounded-full border border-border bg-card shadow-pop">
                  <GripVertical size={14} strokeWidth={2} className="text-foreground" />
                </span>
              </button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
