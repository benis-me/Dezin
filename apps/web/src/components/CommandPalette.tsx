import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  CornerDownLeft,
  LayoutGrid,
  Moon,
  PanelsTopLeft,
  Plus,
  Search,
  Settings,
  Shapes,
  Sparkles,
  Sun,
} from "lucide-react";
import { Dialog, ScrollArea } from "./ui/index.ts";
import { useApi } from "../lib/api-context.tsx";
import { navigate } from "../router.tsx";
import type { DesignSystemCard, Project } from "../lib/api.ts";

interface Item {
  id: string;
  label: string;
  group: string;
  icon: ReactNode;
  run: () => void;
  keywords?: string;
}

export function CommandPalette({
  open,
  onClose,
  dark,
  onToggleTheme,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  dark?: boolean;
  onToggleTheme?: () => void;
  onOpenSettings?: () => void;
}) {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [systems, setSystems] = useState<DesignSystemCard[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    let alive = true;
    api.listProjects().then((p) => alive && setProjects(p)).catch(() => {});
    api.listDesignSystems().then((d) => alive && setSystems(d)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, api]);

  const items = useMemo<Item[]>(() => {
    const actions: Item[] = [
      { id: "a-new", label: "New design", group: "Actions", icon: <Plus size={15} strokeWidth={1.75} />, keywords: "create start", run: () => navigate("/") },
      {
        id: "a-new-ds",
        label: "New design system",
        group: "Actions",
        icon: <Sparkles size={15} strokeWidth={1.75} />,
        keywords: "create brand",
        run: () => navigate("/design-systems/new"),
      },
      ...(onToggleTheme
        ? [
            {
              id: "a-theme",
              label: dark ? "Switch to light mode" : "Switch to dark mode",
              group: "Actions",
              icon: dark ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />,
              keywords: "theme appearance",
              run: () => onToggleTheme(),
            },
          ]
        : []),
      ...(onOpenSettings
        ? [{ id: "a-settings", label: "Settings", group: "Actions", icon: <Settings size={15} strokeWidth={1.75} />, run: () => onOpenSettings() }]
        : []),
    ];
    const nav: Item[] = [
      { id: "nav-home", label: "Home", group: "Go to", icon: <LayoutGrid size={15} strokeWidth={1.75} />, run: () => navigate("/") },
      { id: "nav-ds", label: "Design systems", group: "Go to", icon: <Shapes size={15} strokeWidth={1.75} />, run: () => navigate("/design-systems") },
    ];
    const proj: Item[] = projects.map((p) => ({
      id: `p-${p.id}`,
      label: p.name,
      group: "Projects",
      icon: <PanelsTopLeft size={15} strokeWidth={1.75} />,
      run: () => navigate(`/projects/${p.id}`),
    }));
    const ds: Item[] = systems.map((s) => ({
      id: `d-${s.id}`,
      label: s.name,
      group: "Design systems",
      icon: <Shapes size={15} strokeWidth={1.75} />,
      keywords: s.category,
      run: () => navigate(`/design-systems/${s.id}`),
    }));
    const q = query.trim().toLowerCase();
    const all = [...actions, ...nav, ...proj, ...ds];
    return q ? all.filter((i) => `${i.label} ${i.keywords ?? ""}`.toLowerCase().includes(q)) : all;
  }, [projects, systems, query, dark, onToggleTheme, onOpenSettings]);

  const choose = (it: Item) => {
    it.run();
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const it = items[Math.min(index, items.length - 1)];
      if (it) choose(it);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  const activeIndex = Math.min(index, items.length - 1);

  return (
    <Dialog open={open} onClose={onClose} label="Command palette" align="top" autoFocus={false} className="overflow-hidden sm:max-w-xl">
      <div className="flex items-center gap-2.5 border-b border-border px-4">
        <Search size={16} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
        <input
          autoFocus
          aria-label="Command"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search projects, design systems, actions…"
          className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <ScrollArea className="max-h-80">
      <ul className="p-1.5">
        {items.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-muted-foreground">No matches</li>
        ) : (
          items.map((it, i) => {
            const active = i === activeIndex;
            const newGroup = i === 0 || items[i - 1]!.group !== it.group;
            return (
              <li key={it.id}>
                {newGroup ? (
                  <p className="label-mono px-2.5 pb-1 pt-2 first:pt-1">{it.group}</p>
                ) : null}
                <button
                  type="button"
                  onClick={() => choose(it)}
                  onMouseEnter={() => setIndex(i)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                    active ? "bg-surface-2 text-foreground" : "text-foreground-2 hover:bg-surface-2"
                  }`}
                >
                  <span className={`shrink-0 ${active ? "text-foreground" : "text-muted-foreground"}`}>{it.icon}</span>
                  <span className="flex-1 truncate">{it.label}</span>
                  {active ? <CornerDownLeft size={13} strokeWidth={2} className="shrink-0 text-muted-foreground" /> : null}
                </button>
              </li>
            );
          })
        )}
      </ul>
      </ScrollArea>
      <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <kbd className="rounded border border-border px-1">↑</kbd>
          <kbd className="rounded border border-border px-1">↓</kbd>
          navigate
        </span>
        <span className="flex items-center gap-1">
          <kbd className="rounded border border-border px-1">↵</kbd>
          select
        </span>
        <span className="flex items-center gap-1">
          <kbd className="rounded border border-border px-1">esc</kbd>
          close
        </span>
      </div>
    </Dialog>
  );
}
