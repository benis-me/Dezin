import { useCallback, useEffect, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { Badge, Button, Card, Dialog, Input, Loading, SearchInput, Segmented } from "../components/ui/index.ts";
import { useApi } from "../lib/api-context.tsx";
import { useAutoRefresh } from "../lib/use-auto-refresh.ts";
import { navigate } from "../router.tsx";
import type { EffectCard } from "../lib/api.ts";

function EffectThumb({ effect }: { effect: EffectCard }) {
  return (
    <div data-testid={`effect-card-preview-${effect.id}`} className="relative aspect-[4/3] overflow-hidden border-b border-border bg-surface">
      {effect.previewUrl ? (
        <img src={effect.previewUrl} alt={`${effect.name} preview`} loading="lazy" draggable={false} className="h-full w-full object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center bg-[linear-gradient(135deg,var(--surface),var(--surface-2))] text-muted-foreground">
          <Sparkles size={18} strokeWidth={1.8} />
        </div>
      )}
    </div>
  );
}

export function EffectsScreen({ startNew = false }: { startNew?: boolean }) {
  const api = useApi();
  const [effects, setEffects] = useState<EffectCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "built-in" | "custom">("all");
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(startNew);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    api
      .listEffects()
      .then(setEffects)
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"));
  }, [api]);

  useEffect(() => refresh(), [refresh]);
  useAutoRefresh(refresh);

  useEffect(() => {
    if (startNew) setDialogOpen(true);
  }, [startNew]);

  const filtered = (effects ?? []).filter((effect) => {
    const matchesFilter = filter === "all" || effect.origin === filter;
    const haystack = `${effect.name} ${effect.id} ${effect.category} ${effect.summary}`.toLowerCase();
    return matchesFilter && (!query.trim() || haystack.includes(query.trim().toLowerCase()));
  });

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const effect = await api.createEffect({ name: trimmed });
      navigate(`/effects/${effect.id}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="relative h-full w-full overflow-auto">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[36vh]"
        style={{ background: "radial-gradient(60% 100% at 28% 0%, color-mix(in oklch, var(--primary) 9%, transparent), transparent 70%)" }}
      />
      <div className="relative w-full px-7 pb-20 pt-10">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-start justify-between gap-4">
            <div className="max-w-2xl">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Effects</h1>
              <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
                Reusable visual effect processors for Dezin artifacts. {effects ? `${effects.length} effects.` : ""}
              </p>
            </div>
            <Button onClick={() => setDialogOpen(true)} className="gap-2">
              <Plus size={15} strokeWidth={1.75} />
              New Effect
            </Button>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <Segmented
              ariaLabel="Filter effects"
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "built-in", label: "Built-in" },
                { value: "custom", label: "Custom" },
              ]}
            />
            <SearchInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search effects" className="w-32 sm:w-44" />
          </div>

          {error ? (
            <p className="mt-6 text-sm text-destructive">Couldn't load effects: {error}</p>
          ) : effects === null ? (
            <Loading label="Loading effects..." />
          ) : filtered.length === 0 ? (
            <div className="mt-10 grid place-items-center rounded-lg border border-dashed border-border bg-card/40 px-6 py-12 text-center">
              <div className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-background text-muted-foreground">
                <Sparkles size={18} strokeWidth={1.8} />
              </div>
              <p className="mt-3 text-sm text-muted-foreground">No effects match this view.</p>
            </div>
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((effect) => (
                <Card
                  key={effect.id}
                  onClick={() => navigate(`/effects/${effect.id}`)}
                  className="cursor-pointer gap-0 overflow-hidden p-0 transition-all duration-150 ease-[var(--ease-out)] hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop"
                >
                  <EffectThumb effect={effect} />
                  <div className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0 truncate text-sm font-medium text-foreground">{effect.name}</div>
                    <Badge variant={effect.origin === "built-in" ? "secondary" : "default"} className="shrink-0">
                      {effect.origin === "built-in" ? effect.category : "Custom"}
                    </Badge>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} label="New effect" className="max-w-md">
        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2 className="text-base font-semibold tracking-tight">New effect</h2>
          <Input autoFocus aria-label="Effect Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Effect name" className="mt-3" />
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || creating}>
              Create
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
