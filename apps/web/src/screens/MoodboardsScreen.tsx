import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Images, LayoutGrid, List, Pencil, Plus, Search, Trash2 } from "lucide-react";
import type { Moodboard } from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { useToast } from "../components/Toast.tsx";
import {
  Button,
  Card,
  Dialog,
  IconButton,
  Input,
  Loading,
  Picker,
  SearchInput,
  Segmented,
  Stagger,
  StaggerItem,
  Tabs,
} from "../components/ui/index.ts";

function formatUpdatedAt(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  if (now - ts < 24 * 60 * 60 * 1000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function BoardThumb({ coverUrl }: { coverUrl?: string | null }) {
  return (
    <div className="aspect-[4/3] overflow-hidden border-b border-border bg-surface-2">
      {coverUrl ? (
        <img src={coverUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="dz-canvas grid h-full w-full place-items-center text-muted-foreground/60">
          <Images size={28} strokeWidth={1.5} />
        </div>
      )}
    </div>
  );
}

export function MoodboardsScreen({ onOpenBoard }: { onOpenBoard: (id: string) => void }) {
  const api = useApi();
  const { toast } = useToast();
  const [boards, setBoards] = useState<Moodboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"active" | "archived">("active");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState<"recent" | "name" | "oldest">("recent");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Moodboard | null>(null);
  const [draft, setDraft] = useState("");

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .listMoodboards()
      .then(setBoards)
      .catch(() => toast("Couldn't load moodboards.", { variant: "error" }))
      .finally(() => setLoading(false));
  }, [api, toast]);

  useEffect(() => refresh(), [refresh]);

  const activeCount = boards.filter((b) => !b.archivedAt).length;
  const archivedCount = boards.length - activeCount;
  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = boards
      .filter((b) => (view === "archived" ? b.archivedAt : !b.archivedAt))
      .filter((b) => !term || b.name.toLowerCase().includes(term));
    const sorted = [...list];
    if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "oldest") sorted.sort((a, b) => a.createdAt - b.createdAt);
    else sorted.sort((a, b) => b.updatedAt - a.updatedAt);
    return sorted;
  }, [boards, q, sort, view]);

  const create = async () => {
    const name = draft.trim() || "Untitled moodboard";
    try {
      const board = await api.createMoodboard({ name });
      setCreating(false);
      setDraft("");
      refresh();
      onOpenBoard(board.id);
    } catch {
      toast("Couldn't create the moodboard.", { variant: "error" });
    }
  };

  const rename = async () => {
    if (!renaming) return;
    const name = draft.trim();
    setRenaming(null);
    if (!name) return;
    try {
      await api.patchMoodboard(renaming.id, { name });
      refresh();
    } catch {
      toast("Couldn't rename the moodboard.", { variant: "error" });
    }
  };

  const archive = async (board: Moodboard, archived: boolean) => {
    try {
      await api.patchMoodboard(board.id, { archived });
      refresh();
    } catch {
      toast(archived ? "Couldn't archive the moodboard." : "Couldn't restore the moodboard.", { variant: "error" });
    }
  };

  const remove = async (board: Moodboard) => {
    if (!window.confirm(`Delete ${board.name} permanently? This can't be undone.`)) return;
    try {
      await api.deleteMoodboard(board.id);
      refresh();
    } catch {
      toast("Couldn't delete the moodboard.", { variant: "error" });
    }
  };

  const actions = (board: Moodboard) =>
    view === "archived" ? (
      <>
        <IconButton aria-label={`Restore ${board.name}`} onClick={() => void archive(board, false)}>
          <ArchiveRestore size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton aria-label={`Delete ${board.name}`} className="hover:text-destructive" onClick={() => void remove(board)}>
          <Trash2 size={14} strokeWidth={1.75} />
        </IconButton>
      </>
    ) : (
      <>
        <IconButton
          aria-label={`Rename ${board.name}`}
          onClick={() => {
            setRenaming(board);
            setDraft(board.name);
          }}
        >
          <Pencil size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton aria-label={`Archive ${board.name}`} onClick={() => void archive(board, true)}>
          <Archive size={14} strokeWidth={1.75} />
        </IconButton>
      </>
    );

  return (
    <div className="relative h-full w-full overflow-auto">
      <div className="relative w-full px-7 pb-20 pt-10">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Moodboard</h1>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Collect references, generate visual material, and arrange design direction before a project starts.
              </p>
            </div>
            <Button
              className="gap-2"
              onClick={() => {
                setCreating(true);
                setDraft("");
              }}
            >
              <Plus size={15} strokeWidth={1.75} />
              New board
            </Button>
          </div>

          <div className="mt-9 flex flex-wrap items-center gap-2">
            <Tabs
              aria-label="Moodboard view"
              value={view}
              onChange={(v) => setView(v as typeof view)}
              items={[
                { value: "active", label: <span className="flex items-center gap-1.5">All <span className="tnum text-muted-foreground">{activeCount}</span></span> },
                {
                  value: "archived",
                  label: (
                    <span className="flex items-center gap-1.5">
                      <Archive size={12} strokeWidth={1.75} /> Archived <span className="tnum text-muted-foreground">{archivedCount}</span>
                    </span>
                  ),
                },
              ]}
            />
            <div className="ml-auto flex items-center gap-1.5">
              <Picker
                ariaLabel="Sort moodboards"
                size="sm"
                tone="ghost"
                value={sort}
                onChange={(v) => setSort(v as typeof sort)}
                options={[
                  { value: "recent", label: "Recent" },
                  { value: "name", label: "Name" },
                  { value: "oldest", label: "Oldest" },
                ]}
              />
              <Segmented
                ariaLabel="Layout"
                size="sm"
                value={layout}
                onChange={(v) => setLayout(v as typeof layout)}
                options={[
                  { value: "grid", title: "Grid", icon: <LayoutGrid size={14} strokeWidth={1.75} /> },
                  { value: "list", title: "List", icon: <List size={14} strokeWidth={1.75} /> },
                ]}
              />
              <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search moodboards" className="w-36 sm:w-48" />
            </div>
          </div>

          {loading ? (
            <Loading label="Loading moodboards..." />
          ) : visible.length === 0 ? (
            <div className="dz-canvas mt-5 grid min-h-[360px] place-items-center rounded-2xl border border-dashed border-border">
              <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
                <span className="grid size-14 place-items-center rounded-2xl border border-border bg-card text-muted-foreground">
                  {q.trim() ? <Search size={24} strokeWidth={1.5} /> : <Images size={24} strokeWidth={1.5} />}
                </span>
                <p className="text-base font-medium text-foreground">{q.trim() ? "No matches" : view === "archived" ? "Nothing archived" : "No moodboards yet"}</p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {q.trim() ? "No boards match your search." : "Create a board to collect images, notes, and generated visual material."}
                </p>
              </div>
            </div>
          ) : layout === "grid" ? (
            <Stagger as="ul" className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visible.map((board) => (
                <StaggerItem as="li" key={board.id}>
                  <Card
                    className="group cursor-pointer gap-0 overflow-hidden p-0 transition-all duration-150 ease-[var(--ease-out)] hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop"
                    onClick={() => onOpenBoard(board.id)}
                  >
                    <BoardThumb coverUrl={board.coverUrl} />
                    <div className="p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{board.name}</p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">Updated {formatUpdatedAt(board.updatedAt)}</p>
                        </div>
                        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100" onClick={(e) => e.stopPropagation()}>
                          {actions(board)}
                        </div>
                      </div>
                    </div>
                  </Card>
                </StaggerItem>
              ))}
            </Stagger>
          ) : (
            <Stagger as="ul" className="mt-5 overflow-hidden rounded-xl border border-border">
              {visible.map((board) => (
                <StaggerItem as="li" key={board.id} className="border-b border-border last:border-0">
                  <div onClick={() => onOpenBoard(board.id)} className="group flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-2/50">
                    <div className="h-9 w-12 shrink-0 overflow-hidden rounded-md border border-border bg-surface-2">
                      {board.coverUrl ? <img src={board.coverUrl} alt="" className="h-full w-full object-cover" /> : <div className="dz-canvas h-full w-full" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{board.name}</p>
                      <p className="truncate text-xs text-muted-foreground">Moodboard</p>
                    </div>
                    <div className="relative flex min-w-[7rem] shrink-0 justify-end" onClick={(e) => e.stopPropagation()}>
                      <span className="text-xs text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                        {formatUpdatedAt(board.updatedAt)}
                      </span>
                      <div className="absolute right-0 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        {actions(board)}
                      </div>
                    </div>
                  </div>
                </StaggerItem>
              ))}
            </Stagger>
          )}
        </div>
      </div>

      <Dialog open={creating || renaming !== null} onClose={() => { setCreating(false); setRenaming(null); }} label={renaming ? "Rename moodboard" : "New moodboard"} className="max-w-md">
        <form
          className="p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void (renaming ? rename() : create());
          }}
        >
          <h2 className="text-base font-semibold tracking-tight">{renaming ? "Rename moodboard" : "New moodboard"}</h2>
          <Input aria-label="Moodboard name" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} placeholder="Moodboard name" className="mt-3" />
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { setCreating(false); setRenaming(null); }}>
              Cancel
            </Button>
            <Button type="submit" disabled={renaming !== null && draft.trim().length === 0}>
              {renaming ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
