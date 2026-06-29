import { useState } from "react";
import { Check, ChevronDown, MessageSquare, Pencil, Trash2 } from "lucide-react";
import type { Conversation } from "../lib/api.ts";
import { Input, Popover, PopoverContent, PopoverTrigger, ScrollArea } from "./ui/index.ts";

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

/** The conversation switcher — list with turn count + time, inline rename, and delete. */
export function ConversationSelect({
  conversations,
  activeId,
  onSwitch,
  onRename,
  onDelete,
  label,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  label: (c: Conversation, i: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const active = conversations.find((c) => c.id === activeId);
  const activeLabel = active ? label(active, conversations.indexOf(active)) : "Conversation";

  const commitRename = (c: Conversation, i: number): void => {
    onRename(c.id, draft.trim() || label(c, i));
    setEditingId(null);
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger
        aria-label="Conversation switcher"
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-surface-2 data-[state=open]:text-foreground"
      >
        <MessageSquare size={13} strokeWidth={1.75} />
        <span className="max-w-[12rem] truncate font-medium text-foreground">{activeLabel}</span>
        <ChevronDown size={13} strokeWidth={2} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        <ScrollArea viewportClassName="max-h-72">
          <ul>
            {conversations.map((c, i) => {
              const editing = editingId === c.id;
              return (
                <li key={c.id} className="group">
                  {editing ? (
                    <div className="flex items-center gap-1 px-1 py-1">
                      <Input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(c, i);
                          else if (e.key === "Escape") {
                            e.stopPropagation();
                            setEditingId(null);
                          }
                        }}
                        onBlur={() => commitRename(c, i)}
                        aria-label="Conversation name"
                        className="h-8"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent">
                      <button
                        type="button"
                        onClick={() => {
                          onSwitch(c.id);
                          setOpen(false);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                      >
                        <MessageSquare size={13} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium leading-tight">{label(c, i)}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {c.turns ?? 0} turn{c.turns === 1 ? "" : "s"} · {relTime(c.createdAt)}
                          </span>
                        </span>
                        {c.id === activeId ? <Check size={13} strokeWidth={2.5} className="shrink-0 text-foreground" /> : null}
                      </button>
                      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          aria-label={`Rename ${label(c, i)}`}
                          onClick={() => {
                            setDraft(label(c, i));
                            setEditingId(c.id);
                          }}
                          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                        >
                          <Pencil size={12} strokeWidth={1.75} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${label(c, i)}`}
                          onClick={() => onDelete(c.id)}
                          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-background hover:text-destructive"
                        >
                          <Trash2 size={12} strokeWidth={1.75} />
                        </button>
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
