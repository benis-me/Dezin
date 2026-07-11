import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Archive, ArchiveRestore, ArrowRight, ImagePlus, Images, LayoutGrid, List, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import type { Moodboard, Settings } from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { useAgents } from "../lib/agents-context.tsx";
import { useAutoRefresh } from "../lib/use-auto-refresh.ts";
import { SETTINGS_UPDATED_EVENT } from "../lib/settings-events.ts";
import { useToast } from "../components/Toast.tsx";
import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
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
import { ImageModelPicker } from "../moodboard/ImageModelPicker.tsx";
import { fileToBase64, imageSize } from "../moodboard/moodboard-board-utils.ts";
import { imageModelOptions } from "../moodboard/useMoodboardBoard.ts";
import { filesFromDataTransfer, hasDraggedFiles, localPathsFromDataTransfer } from "../lib/drag-drop.ts";
import { beginResourceLoad, idleResource, rejectResource, resolveResource } from "../lib/async-resource.ts";

interface PromptImage {
  file: File;
  name: string;
  base64: string;
  preview: string;
}

type StartMode = "agent" | "generate";

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
        <img src={coverUrl} alt="" draggable={false} className="h-full w-full object-cover" />
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
  const { agents, rescan: rescanAgents } = useAgents();
  const [boardsResource, setBoardsResource] = useState(() => idleResource<Moodboard[]>());
  const boardRequestRef = useRef(0);
  const boards = boardsResource.data ?? [];
  const loading = boardsResource.status === "idle" || boardsResource.status === "loading";
  const [view, setView] = useState<"active" | "archived">("active");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState<"recent" | "name" | "oldest">("recent");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Moodboard | null>(null);
  const [draft, setDraft] = useState("");
  const [prompt, setPrompt] = useState("");
  const [promptImages, setPromptImages] = useState<PromptImage[]>([]);
  const [starting, setStarting] = useState(false);
  const [startMode, setStartMode] = useState<StartMode>("agent");
  const [settingsAgent, setSettingsAgent] = useState<string | null>(null);
  const [settingsModel, setSettingsModel] = useState("");
  const [runAgent, setRunAgent] = useState("");
  const [runModel, setRunModel] = useState("");
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [imageModel, setImageModel] = useState("");
  const promptImageInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    const request = ++boardRequestRef.current;
    setBoardsResource((current) => beginResourceLoad(current));
    api
      .listMoodboards()
      .then((next) => {
        if (request === boardRequestRef.current) setBoardsResource(resolveResource(next));
      })
      .catch((error) => {
        if (request === boardRequestRef.current) setBoardsResource((current) => rejectResource(current, error));
      });
  }, [api]);

  useEffect(() => refresh(), [refresh]);
  useAutoRefresh(refresh);

  const applyImageSettings = useCallback((settings: Settings) => {
    const models = imageModelOptions(settings);
    const configuredImageModel = settings.imageModel.trim();
    setImageModels(models);
    setImageModel((current) => (current && models.includes(current) ? current : models.includes(configuredImageModel) ? configuredImageModel : models[0] || ""));
  }, []);

  useEffect(() => {
    let alive = true;
    void api
      .getSettings()
      .then((settings) => {
        if (!alive) return;
        setSettingsAgent(settings.agentCommand ?? "");
        setSettingsModel(settings.model ?? "");
        applyImageSettings(settings);
      })
      .catch(() => {
        if (!alive) return;
        setSettingsAgent("");
        setImageModels([]);
      });
    const onSettingsUpdated = (event: Event) => {
      const settings = (event as CustomEvent<Settings>).detail;
      if (settings) applyImageSettings(settings);
    };
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated);
    return () => {
      alive = false;
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated);
    };
  }, [api, applyImageSettings]);

  useEffect(() => {
    if (settingsAgent === null) return;
    const available = agents.filter((agent) => agent.available);
    if (!available.length) return;
    const useSaved = settingsAgent !== "" && available.some((agent) => agent.command === settingsAgent);
    setRunAgent((current) => current || (useSaved ? settingsAgent : available[0]!.command));
    if (useSaved && settingsModel) setRunModel((current) => current || settingsModel);
  }, [agents, settingsAgent, settingsModel]);

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
  const promptText = prompt.trim();
  const generateNeedsModel = startMode === "generate" && promptText.length > 0 && !imageModel;

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

  const addPromptImages = async (files: FileList | File[] | null): Promise<void> => {
    if (!files) return;
    const next: PromptImage[] = [];
    for (const file of Array.from(files).filter((item) => item.type.startsWith("image/"))) {
      try {
        const base64 = await fileToBase64(file);
        next.push({ file, name: file.name, base64, preview: `data:${file.type || "image/png"};base64,${base64}` });
      } catch {
        toast("Couldn't read that image.", { variant: "error" });
      }
    }
    if (next.length) setPromptImages((current) => [...current, ...next]);
  };

  const handlePromptDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handlePromptDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    const dataTransfer = event.dataTransfer;
    const paths = localPathsFromDataTransfer(dataTransfer);
    if (paths.length) {
      setPrompt((current) => `${current}${current.trim() ? "\n\n" : ""}Use these local paths as reference: ${paths.join(", ")}`);
    }
    void filesFromDataTransfer(dataTransfer).then(addPromptImages);
  };

  const startBoard = async () => {
    const text = prompt.trim();
    if (!text && promptImages.length === 0) return;
    setStarting(true);
    try {
      const images = await Promise.all(
        promptImages.map(async (image) => {
          const size = await imageSizeWithFallback(image.file);
          return {
            name: image.name,
            contentBase64: image.base64,
            mimeType: image.file.type,
            width: size.width,
            height: size.height,
          };
        }),
      );
      const board = await api.startMoodboard({
        name: titleFromPrompt(text) || (promptImages.length ? "Visual references" : "Untitled moodboard"),
        prompt: text || undefined,
        mode: startMode,
        images: images.length ? images : undefined,
        agentCommand: startMode === "agent" ? runAgent || undefined : undefined,
        agentModel: startMode === "agent" ? runModel || undefined : undefined,
        imageModel: startMode === "generate" ? imageModel || undefined : undefined,
      });
      setPrompt("");
      setPromptImages([]);
      refresh();
      onOpenBoard(board.id);
    } catch {
      toast("Couldn't create the moodboard.", { variant: "error" });
    } finally {
      setStarting(false);
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
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[38vh]"
        style={{ background: "radial-gradient(65% 105% at 68% 0%, color-mix(in oklch, var(--primary) 10%, transparent), transparent 72%)" }}
      />
      <div className="relative w-full px-7 pb-20 pt-10">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-start justify-between gap-4">
            <div className="max-w-2xl">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Moodboard</h1>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">Collect references, generate visual material, and arrange design direction before a project starts.</p>
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

          <div
            aria-label="Moodboard prompt dropzone"
            className="mt-5 w-full rounded-2xl border border-input bg-card/80 p-2.5 transition-[color,border-color,box-shadow] duration-150 hover:border-border-strong focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 focus-within:hover:border-ring"
            onDragEnter={handlePromptDragOver}
            onDragOver={handlePromptDragOver}
            onDrop={handlePromptDrop}
          >
            <input
              ref={promptImageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                void addPromptImages(event.target.files);
                event.target.value = "";
              }}
            />
            {promptImages.length ? (
              <div className="flex flex-wrap gap-2 px-2 pb-1 pt-1.5">
                {promptImages.map((image, index) => (
                  <span key={`${image.name}-${index}`} className="group relative overflow-hidden rounded-lg border border-border">
                    <img src={image.preview} alt={image.name} className="h-16 w-16 object-cover" />
                    <button
                      type="button"
                      aria-label={`Remove ${image.name}`}
                      onClick={() => setPromptImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-md bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                    >
                      <X size={12} strokeWidth={2} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <textarea
              aria-label="Describe moodboard direction"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Collect visual references for a calm hospitality brand with warm editorial photography..."
              rows={3}
              className="field-sizing-content max-h-64 min-h-[92px] w-full resize-none bg-transparent px-3 py-2.5 text-base leading-relaxed outline-none placeholder:text-muted-foreground"
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 px-1 pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <IconButton aria-label="Attach images" onClick={() => promptImageInputRef.current?.click()}>
                  <ImagePlus size={15} strokeWidth={1.75} />
                </IconButton>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Segmented
                  ariaLabel="Moodboard start mode"
                  size="sm"
                  value={startMode}
                  onChange={(value) => setStartMode(value as StartMode)}
                  options={[
                    { value: "agent", label: "Agent" },
                    { value: "generate", label: "Model" },
                  ]}
                />
                {startMode === "agent" ? (
                  <AgentModelSelect
                    agents={agents}
                    agent={runAgent}
                    model={runModel}
                    onAgentChange={(value) => {
                      setRunAgent(value);
                      setRunModel("");
                    }}
                    onModelChange={setRunModel}
                    onRescan={rescanAgents}
                  />
                ) : (
                  <ImageModelPicker model={imageModel} options={imageModels} onModelChange={setImageModel} />
                )}
                <Button
                  size="lg"
                  aria-label={startMode === "generate" ? "Generate board" : "Start board"}
                  onClick={() => void startBoard()}
                  disabled={starting || generateNeedsModel || (!promptText && promptImages.length === 0)}
                  className="px-6 shadow-[0_8px_24px_-8px_color-mix(in_oklch,var(--primary)_48%,transparent)]"
                >
                  {startMode === "generate" ? "Generate" : "Start board"}
                  <ArrowRight size={16} strokeWidth={2} />
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-14">
          <div className="flex flex-wrap items-center gap-2">
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

          {boardsResource.status === "error" ? (
            <div role="alert" className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
              <span>{boardsResource.data ? "Couldn't refresh moodboards. Showing the last loaded list." : "Couldn't load moodboards."}</span>
              <Button variant="outline" size="sm" aria-label="Retry loading moodboards" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : null}

          {loading ? (
            <Loading label="Loading moodboards..." />
          ) : boardsResource.status === "error" && boardsResource.data === null ? null : visible.length === 0 ? (
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
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${board.name}`}
                    className="group cursor-pointer gap-0 overflow-hidden p-0 transition-all duration-150 ease-[var(--ease-out)] hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={() => onOpenBoard(board.id)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                      event.preventDefault();
                      onOpenBoard(board.id);
                    }}
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
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${board.name}`}
                    onClick={() => onOpenBoard(board.id)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                      event.preventDefault();
                      onOpenBoard(board.id);
                    }}
                    className="group flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                  >
                    <div className="h-9 w-12 shrink-0 overflow-hidden rounded-md border border-border bg-surface-2">
                      {board.coverUrl ? <img src={board.coverUrl} alt="" draggable={false} className="h-full w-full object-cover" /> : <div className="dz-canvas h-full w-full" />}
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

function titleFromPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ");
}

async function imageSizeWithFallback(file: File): Promise<{ width: number | undefined; height: number | undefined }> {
  return Promise.race([
    imageSize(file),
    new Promise<{ width: undefined; height: undefined }>((resolve) => window.setTimeout(() => resolve({ width: undefined, height: undefined }), 80)),
  ]);
}
