import { useState } from "react";
import { Check, ChevronDown, GitBranch, GitCompare, Pencil, Plus, Trash2 } from "lucide-react";
import type { Variant } from "../lib/api.ts";
import { Input, Popover, PopoverContent, PopoverTrigger, ScrollArea } from "./ui/index.ts";

/** Branch switcher — switch the active design branch, fork a new one, rename, delete, compare. */
export function VariantSwitcher({
  variants,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
  onCompare,
}: {
  variants: Variant[];
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onCompare: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const active = variants.find((v) => v.active) ?? variants[0];
  if (!active || variants.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger
        aria-label="Branch switcher"
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-surface-2 data-[state=open]:text-foreground"
      >
        <GitBranch size={13} strokeWidth={1.75} />
        <span className="max-w-[10rem] truncate font-medium text-foreground">{active.name}</span>
        {variants.length > 1 ? <span className="tnum text-[10px] text-muted-foreground">{variants.length}</span> : null}
        <ChevronDown size={13} strokeWidth={2} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
          <ScrollArea viewportClassName="max-h-72">
          <ul>
            {variants.map((v) => {
              const editing = editingId === v.id;
              const commit = () => {
                onRename(v.id, draft.trim() || v.name);
                setEditingId(null);
              };
              return (
                <li key={v.id} className="group">
                  {editing ? (
                    <div className="px-1 py-1">
                      <Input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commit();
                          else if (e.key === "Escape") {
                            e.stopPropagation();
                            setEditingId(null);
                          }
                        }}
                        onBlur={commit}
                        aria-label="Branch name"
                        className="h-8"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent">
                      <button
                        type="button"
                        onClick={() => {
                          if (!v.active) onSwitch(v.id);
                          setOpen(false);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                      >
                        <GitBranch size={13} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">{v.name}</span>
                        {v.active ? <Check size={13} strokeWidth={2.5} className="shrink-0 text-foreground" /> : null}
                      </button>
                      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        {!v.active ? (
                          <button
                            type="button"
                            aria-label={`Compare ${v.name} with the active branch`}
                            onClick={() => {
                              onCompare(v.id);
                              setOpen(false);
                            }}
                            className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                          >
                            <GitCompare size={12} strokeWidth={1.75} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`Rename ${v.name}`}
                          onClick={() => {
                            setDraft(v.name);
                            setEditingId(v.id);
                          }}
                          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                        >
                          <Pencil size={12} strokeWidth={1.75} />
                        </button>
                        {!v.active && variants.length > 1 ? (
                          <button
                            type="button"
                            aria-label={`Delete ${v.name}`}
                            onClick={() => onDelete(v.id)}
                            className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-background hover:text-destructive"
                          >
                            <Trash2 size={12} strokeWidth={1.75} />
                          </button>
                        ) : null}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          </ScrollArea>
          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              onClick={() => {
                onCreate();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
            >
              <Plus size={14} strokeWidth={2} className="text-muted-foreground" />
              New branch <span className="text-xs text-muted-foreground">(fork current)</span>
            </button>
          </div>
      </PopoverContent>
    </Popover>
  );
}
