import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Card, Badge, Button, Loading, Segmented } from "../components/ui/index.ts";
import { BrandGlyph, hasBrandLogo } from "../components/design-system-logos.tsx";
import { useApi } from "../lib/api-context.tsx";
import { useAutoRefresh } from "../lib/use-auto-refresh.ts";
import { navigate } from "../router.tsx";
import type { DesignSystemCard, Swatch } from "../lib/api.ts";

const FALLBACK: Swatch = { bg: "var(--surface)", surface: "var(--surface-2)", fg: "var(--foreground)", accent: "var(--muted-foreground)" };

function SwatchRow({ swatch }: { swatch?: Swatch }) {
  const sw = swatch ?? FALLBACK;
  return (
    <div className="flex gap-1">
      {[sw.bg, sw.surface, sw.fg, sw.accent].map((c, i) => (
        <span key={i} className="h-4 w-4 rounded-full border border-border-strong/50" style={{ backgroundColor: c }} />
      ))}
    </div>
  );
}

/** A mini brand vignette — the brand name + a button + chip in the brand's own colors. */
function Specimen({ id, name, swatch }: { id: string; name: string; swatch?: Swatch }) {
  const sw = swatch ?? FALLBACK;
  return (
    <div className="rounded-t-xl border-b border-border px-4 py-3.5" style={{ backgroundColor: sw.bg, color: sw.fg }}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          {hasBrandLogo(id) ? <BrandGlyph id={id} className="size-4 shrink-0" /> : null}
          {name}
        </span>
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: sw.accent }} />
      </div>
      <div className="mt-0.5 text-xs" style={{ color: sw.fg, opacity: 0.55 }}>
        Aa — the quick brown fox
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        <span className="rounded-md px-2.5 py-1 text-[11px] font-medium" style={{ backgroundColor: sw.accent, color: "#fff" }}>
          Button
        </span>
        <span
          className="rounded-md px-2.5 py-1 text-[11px]"
          style={{ backgroundColor: sw.surface, color: sw.fg, border: `1px solid ${sw.accent}22` }}
        >
          Input
        </span>
        <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ border: `1px solid ${sw.fg}`, opacity: 0.4 }}>
          v2.1
        </span>
      </div>
    </div>
  );
}

export function DesignSystemsScreen() {
  const api = useApi();
  const [systems, setSystems] = useState<DesignSystemCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "built-in" | "custom">("all");

  const refresh = useCallback(() => {
    api
      .listDesignSystems()
      .then(setSystems)
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"));
  }, [api]);

  useEffect(() => refresh(), [refresh]);
  useAutoRefresh(refresh);

  return (
    <div className="relative h-full w-full overflow-auto">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[36vh]"
        style={{ background: "radial-gradient(60% 100% at 30% 0%, color-mix(in oklch, var(--primary) 10%, transparent), transparent 70%)" }}
      />
      <div className="relative w-full px-7 pb-20 pt-10">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-start justify-between gap-4">
            <div className="max-w-2xl">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Design systems</h1>
              <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
                The brand visual language each artifact is built from. {systems ? `${systems.length} systems.` : ""}
              </p>
            </div>
            <Button onClick={() => navigate("/design-systems/new")} className="gap-2">
              <Plus size={15} strokeWidth={1.75} />
              New design system
            </Button>
          </div>

          {systems && systems.length > 0 ? (
            <div className="mt-5">
              <Segmented
                ariaLabel="Filter design systems"
                size="sm"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "built-in", label: "Built-in" },
                  { value: "custom", label: "Custom" },
                ]}
              />
            </div>
          ) : null}

          {error ? (
            <p className="mt-6 text-sm text-destructive">Couldn't load design systems: {error}</p>
          ) : systems === null ? (
            <Loading label="Loading design systems…" />
          ) : systems.filter((s) => filter === "all" || (s.origin ?? "built-in") === filter).length === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">No {filter === "all" ? "" : `${filter} `}design systems found.</p>
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {systems
                .filter((s) => filter === "all" || (s.origin ?? "built-in") === filter)
                .map((s) => (
                  <Card
                    key={s.id}
                    onClick={() => navigate(`/design-systems/${s.id}`)}
                    className="cursor-pointer gap-0 overflow-hidden p-0 transition-all duration-150 ease-[var(--ease-out)] hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop"
                  >
                    <Specimen id={s.id} name={s.name} swatch={s.swatch} />
                    <div className="flex items-center justify-between gap-2 p-3">
                      {s.category ? <Badge variant="outline">{s.category}</Badge> : <span />}
                      <SwatchRow swatch={s.swatch} />
                    </div>
                  </Card>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
