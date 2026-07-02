import { Search } from "lucide-react";
import type { Settings } from "../lib/api.ts";
import { Input } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import type { ProviderPreset } from "./model-provider-registry.ts";
import { ProviderIcon } from "./model-provider-ui-utils.tsx";

export function ModelProviderSidebar({
  providers,
  selectedId,
  activeProviderId,
  enabled,
  apiKey,
  apiKeyConfigured = false,
  query,
  onQueryChange,
  onSelect,
}: {
  providers: ProviderPreset[];
  selectedId: string;
  activeProviderId: Settings["aiProviderId"];
  enabled: boolean;
  apiKey: string;
  apiKeyConfigured?: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (provider: ProviderPreset) => void;
}) {
  return (
    <aside className="w-52 shrink-0 border-r border-border bg-muted/35 p-2.5">
      <label className="relative block">
        <Search size={14} strokeWidth={1.75} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search model platform..."
          aria-label="Search model platform"
          className="h-8 pl-8 text-xs"
        />
      </label>
      <div className="mt-2 space-y-1">
        {providers.map((provider) => {
          const active = provider.id === selectedId;
          const configured = provider.id === activeProviderId && enabled && Boolean(apiKey || apiKeyConfigured || provider.id === "mock" || provider.id === "ollama");
          return (
            <button
              key={provider.id}
              type="button"
              onClick={() => onSelect(provider)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left transition-colors",
                active ? "border-border bg-background" : "border-transparent hover:bg-background/70",
              )}
            >
              <ProviderIcon id={provider.id} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{provider.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{provider.protocol}</span>
              </span>
              <span
                aria-label={`${provider.name} ${configured ? "enabled" : "disabled"}`}
                className={cn("size-1.5 shrink-0 rounded-full", configured ? "bg-[var(--success)]" : "bg-border-strong")}
              />
            </button>
          );
        })}
      </div>
    </aside>
  );
}
