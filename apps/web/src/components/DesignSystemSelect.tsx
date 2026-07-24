import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Shapes } from "lucide-react";
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, ScrollArea, SearchInput, Tabs } from "./ui/index.ts";
import { BrandGlyph, DesignSystemMark, hasBrandLogo } from "./design-system-logos.tsx";
import { navigate } from "../router.tsx";
import type { DesignSystemCard, Swatch } from "../lib/api.ts";

const FALLBACK_SWATCH: Swatch = { bg: "var(--surface)", surface: "var(--surface-2)", fg: "var(--foreground)", accent: "var(--muted-foreground)" };

/** A compact, on-hover specimen of a design system: palette, type, and component shapes. */
function DesignSystemPreview({ system }: { system: DesignSystemCard }) {
  const sw = system.swatch ?? FALLBACK_SWATCH;
  return (
    <div className="dz-animate-in w-56 overflow-hidden rounded-lg border border-border bg-popover shadow-pop">
      <div className="px-3 py-2.5" style={{ background: sw.bg, color: sw.fg }}>
        <div className="flex items-center gap-1.5">
          {hasBrandLogo(system.id) ? <BrandGlyph id={system.id} className="size-3.5 shrink-0" /> : null}
          <span className="truncate text-[13px] font-semibold tracking-tight">{system.name}</span>
        </div>
        <div className="mt-0.5 text-[11px]" style={{ opacity: 0.55 }}>
          Aa — the quick brown fox
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span className="rounded px-2 py-0.5 text-[10px] font-medium" style={{ background: sw.accent, color: "#fff" }}>
            Button
          </span>
          <span className="rounded px-2 py-0.5 text-[10px]" style={{ background: sw.surface, color: sw.fg, border: `1px solid ${sw.accent}22` }}>
            Input
          </span>
        </div>
      </div>
      <div className="flex h-5">
        {[sw.bg, sw.surface, sw.fg, sw.accent].map((c, i) => (
          <span key={i} className="flex-1" style={{ background: c }} />
        ))}
      </div>
      {system.category ? <div className="truncate px-3 py-1.5 text-[10px] text-muted-foreground">{system.category}</div> : null}
    </div>
  );
}

/** The "Design system" picker — searchable, with Clear + Create and an on-hover preview. */
export function DesignSystemSelect({
  systems,
  value,
  onChange,
  defaultId,
  compact = false,
  catalogStatus = "ready",
  onRetry,
}: {
  systems: DesignSystemCard[];
  value: string;
  onChange: (id: string) => void;
  defaultId?: string;
  compact?: boolean;
  catalogStatus?: "loading" | "ready" | "error";
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"built-in" | "custom">("built-in");
  const [preview, setPreview] = useState<{ system: DesignSystemCard; top: number; left: number } | null>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // On open, reveal the current selection: switch to its tab and centre it in the list.
  // setTimeout (not rAF — which is paused in background tabs) retries until the Radix
  // popover has positioned and the viewport is scrollable.
  useEffect(() => {
    if (!open) return;
    let timer = 0;
    let tries = 0;
    const attempt = (): void => {
      const row = selectedRef.current;
      const vp = row?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
      if (row && vp && vp.scrollHeight > vp.clientHeight) {
        const r = row.getBoundingClientRect();
        const v = vp.getBoundingClientRect();
        vp.scrollTop += r.top - v.top - (v.height - r.height) / 2;
        return;
      }
      if (tries++ < 15) timer = window.setTimeout(attempt, 16);
    };
    timer = window.setTimeout(attempt, 0);
    return () => clearTimeout(timer);
  }, [open, tab]);

  const showPreview = (e: React.MouseEvent, system: DesignSystemCard): void => {
    const row = e.currentTarget.getBoundingClientRect();
    const pop = (e.currentTarget as HTMLElement).closest('[data-slot="popover-content"]')?.getBoundingClientRect();
    const W = 224;
    const H = 150;
    const gap = 8;
    const right = pop?.right ?? row.right;
    const left = pop?.left ?? row.left;
    let x = right + gap;
    if (x + W > window.innerWidth - 8) x = Math.max(8, left - W - gap);
    let y = row.top - 4;
    if (y + H > window.innerHeight - 8) y = window.innerHeight - 8 - H;
    if (y < 8) y = 8;
    setPreview({ system, top: y, left: x });
  };

  const current = systems.find((s) => s.id === value);
  const label = value === "" ? "None" : (current?.name ?? "Select");
  const ql = q.trim().toLowerCase();
  const filtered = systems.filter(
    (s) =>
      (s.origin ?? "built-in") === tab &&
      (!ql || s.name.toLowerCase().includes(ql) || s.category.toLowerCase().includes(ql)),
  );

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          const cur = systems.find((s) => s.id === value);
          if (cur) setTab(cur.origin ?? "built-in");
        } else {
          setQ("");
          setPreview(null);
        }
      }}
      modal
    >
      <PopoverTrigger asChild>
        {compact ? (
          <button
            type="button"
            aria-label="Design system"
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-surface-2 data-[state=open]:text-foreground"
          >
            {value !== "" && current ? (
              <DesignSystemMark id={current.id} swatch={current.swatch} className="size-5" />
            ) : (
              <Shapes size={13} strokeWidth={1.75} />
            )}
            <span className="max-w-[12rem] truncate font-medium text-foreground">{label}</span>
            <ChevronDown size={13} strokeWidth={2} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Design system"
            className="flex h-11 items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-left transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:border-border-strong"
          >
            {value !== "" && current ? <DesignSystemMark id={current.id} swatch={current.swatch} /> : null}
            <span className="min-w-0">
              <span className="label-mono block leading-none">Design system</span>
              <span className="mt-0.5 block max-w-[12rem] truncate text-sm font-medium leading-tight">{label}</span>
            </span>
            <ChevronDown size={15} strokeWidth={2} className="ml-1 shrink-0 text-muted-foreground" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
          <div className="flex shrink-0 items-center gap-1.5 p-1 pb-1.5">
            <div className="flex-1">
              <SearchInput
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search design systems"
                aria-label="Search design systems"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Clear
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/design-systems/new")}>
              Create
            </Button>
          </div>
          <Tabs
            aria-label="Design system type"
            className="mx-1 flex w-auto"
            value={tab}
            onChange={(v) => setTab(v as "built-in" | "custom")}
            items={[
              { value: "built-in", label: "Built-in" },
              { value: "custom", label: "Custom" },
            ]}
          />
          <ScrollArea viewportClassName="max-h-[min(18rem,calc(var(--radix-popover-content-available-height,40rem)-8.5rem))]">
          <ul aria-label="Design systems" className="px-1 py-1" onMouseLeave={() => setPreview(null)}>
            {catalogStatus === "loading" && systems.length === 0 ? (
              <li role="status" className="px-2 py-6 text-center text-sm text-muted-foreground">
                Loading design systems…
              </li>
            ) : catalogStatus === "error" && systems.length === 0 ? (
              <li role="alert" className="px-2 py-5 text-center text-sm text-muted-foreground">
                <div>Couldn&apos;t load design systems.</div>
                {onRetry ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1.5"
                    aria-label="Retry loading design systems"
                    onClick={onRetry}
                  >
                    Retry
                  </Button>
                ) : null}
              </li>
            ) : filtered.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-muted-foreground">
                No {tab === "custom" ? "custom systems yet" : "matches"}
              </li>
            ) : (
              filtered.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    ref={s.id === value ? selectedRef : undefined}
                    onMouseEnter={(e) => showPreview(e, s)}
                    onClick={() => {
                      onChange(s.id);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <DesignSystemMark id={s.id} swatch={s.swatch} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium leading-tight">{s.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{s.category}</span>
                    </span>
                    {s.id === defaultId ? <Badge variant="secondary">Org default</Badge> : null}
                    {s.id === value ? <Check size={14} strokeWidth={2.5} className="shrink-0 text-foreground" /> : null}
                  </button>
                </li>
              ))
            )}
          </ul>
          </ScrollArea>
          <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-2">
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-1 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md border border-dashed border-border-strong/60">
                <Shapes size={13} strokeWidth={1.75} />
              </span>
              No design system
              {value === "" ? <Check size={14} strokeWidth={2.5} className="ml-auto text-foreground" /> : null}
            </button>
          </div>
      </PopoverContent>
      {open && preview
        ? createPortal(
            <div className="pointer-events-none fixed z-[60]" style={{ top: preview.top, left: preview.left }}>
              <DesignSystemPreview system={preview.system} />
            </div>,
            document.body,
          )
        : null}
    </Popover>
  );
}
