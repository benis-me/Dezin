import { useState } from "react";
import { Check, ChevronDown, Shapes } from "lucide-react";
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, ScrollArea, SearchInput } from "./ui/index.ts";
import { DesignSystemMark } from "./design-system-logos.tsx";
import { navigate } from "../router.tsx";
import type { DesignSystemCard } from "../lib/api.ts";

/** The "Design system" picker from the reference — searchable, with Clear + Create. */
export function DesignSystemSelect({
  systems,
  value,
  onChange,
  defaultId,
  compact = false,
}: {
  systems: DesignSystemCard[];
  value: string;
  onChange: (id: string) => void;
  defaultId?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"built-in" | "custom">("built-in");

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
        if (!o) setQ("");
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
          <div className="mx-1 mb-1 flex shrink-0 items-center gap-0.5 rounded-md bg-surface-2/70 p-0.5">
            {(["built-in", "custom"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`flex-1 rounded-[5px] py-1 text-xs font-medium transition-colors ${
                  tab === t ? "bg-card text-foreground ring-1 ring-border" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "built-in" ? "Built-in" : "Custom"}
              </button>
            ))}
          </div>
          <ScrollArea viewportClassName="max-h-[min(18rem,calc(var(--radix-popover-content-available-height,40rem)-8.5rem))]">
          <ul className="px-1">
            {filtered.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-muted-foreground">
                No {tab === "custom" ? "custom systems yet" : "matches"}
              </li>
            ) : (
              filtered.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
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
          <div className="mt-1 flex shrink-0 items-center gap-2 border-t border-border px-2 pt-2">
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md border border-dashed border-border-strong/60">
                <Shapes size={13} strokeWidth={1.75} />
              </span>
              No design system
              {value === "" ? <Check size={14} strokeWidth={2.5} className="ml-auto text-foreground" /> : null}
            </button>
          </div>
      </PopoverContent>
    </Popover>
  );
}
