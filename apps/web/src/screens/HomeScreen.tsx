import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Boxes,
  Check,
  FileText,
  FolderInput,
  Layers,
  Image as ImageIcon,
  Palette,
  LayoutGrid,
  List,
  Pencil,
  PenLine,
  Presentation,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
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
  Spinner,
  Stagger,
  StaggerItem,
  Tabs,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  type PickerOption,
} from "../components/ui/index.ts";
import { AttachMenu } from "../components/AttachMenu.tsx";
import { DesignSystemSelect } from "../components/DesignSystemSelect.tsx";
import { FieldSelect } from "../components/FieldSelect.tsx";
import { useApi } from "../lib/api-context.tsx";
import { useAgents } from "../lib/agents-context.tsx";
import { useToast } from "../components/Toast.tsx";
import { persistAgentModelDefaults } from "../lib/agent-model-defaults.ts";
import { filesFromDataTransfer, hasDraggedFiles, localPathsFromDataTransfer } from "../lib/drag-drop.ts";
import { takePendingComposer } from "../lib/pending-composer.ts";
import { setPendingImages, setPendingAgent, setPendingRefs } from "../lib/pending-brief.ts";
import { fetchProjectArtifact, toBase64 } from "../lib/project-ref.ts";
import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import type { DesignSystemCard, Project, ProjectMode, Settings, SkillCard } from "../lib/api.ts";

const DEFAULT_SKILL = "frontend-design";
const DEFAULT_DS = "modern-minimal";
const HOME_COMPOSER_KEY = "dezin.home.composer";

interface HomeComposerPrefs {
  skillId?: string;
  designSystemId?: string;
  mode?: ProjectMode;
}

function isProjectMode(value: unknown): value is ProjectMode {
  return value === "prototype" || value === "standard";
}

function readHomeComposerPrefs(): HomeComposerPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(HOME_COMPOSER_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      skillId: typeof record.skillId === "string" ? record.skillId : undefined,
      designSystemId: typeof record.designSystemId === "string" ? record.designSystemId : undefined,
      mode: isProjectMode(record.mode) ? record.mode : undefined,
    };
  } catch {
    return {};
  }
}

function writeHomeComposerPrefs(patch: HomeComposerPrefs): void {
  try {
    const next = { ...readHomeComposerPrefs(), ...patch };
    localStorage.setItem(HOME_COMPOSER_KEY, JSON.stringify(next));
  } catch {
    /* localStorage may be unavailable */
  }
}

interface Template {
  label: string;
  brief: string;
  skillId: string;
  designSystemId: string;
}
const TEMPLATES: Template[] = [
  {
    label: "SaaS pricing",
    brief: "A SaaS pricing page with three plans, the middle one recommended, monthly/annual toggle.",
    skillId: "frontend-design",
    designSystemId: "stripe",
  },
  {
    label: "Dev-tool landing",
    brief: "A developer-tool landing page: hero with a code sample, a feature grid, and one CTA.",
    skillId: "frontend-design",
    designSystemId: "vercel",
  },
  {
    label: "Analytics dashboard",
    brief: "An analytics dashboard with four KPI cards, a line chart, and a recent-activity table.",
    skillId: "frontend-design",
    designSystemId: "linear",
  },
  {
    label: "Pitch deck cover",
    brief: "A pitch deck cover slide: a bold product title, a one-line subhead, and a subtle backdrop.",
    skillId: "deck",
    designSystemId: "editorial",
  },
];

/**
 * The project cover: a real screenshot of the design when one exists, else a clean
 * placeholder (no abstract swatch art, no glyph overlay).
 */
function ActiveRunBadge({ status }: { status?: Project["runStatus"] }) {
  if (status !== "running" && status !== "pending") return null;
  const label = status === "pending" ? "Queued" : "Generating";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/90 px-1.5 py-0.5 text-[11px] font-medium text-foreground backdrop-blur">
      <span className="size-1.5 rounded-full bg-primary" aria-hidden />
      <span className={status === "running" ? "shiny-text" : undefined}>{label}</span>
    </span>
  );
}

function formatUpdatedAt(value: number): string {
  const diff = Math.max(0, Date.now() - value);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "Updated just now";
  if (diff < hour) return `Updated ${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `Updated ${Math.floor(diff / hour)}h ago`;
  return `Updated ${Math.floor(diff / day)}d ago`;
}

function ProjectThumb({ coverUrl, runStatus }: { coverUrl?: string | null; runStatus?: Project["runStatus"] }) {
  return (
    <div className="relative aspect-[16/10] overflow-hidden border-b border-border bg-surface-2">
      {coverUrl ? (
        <img src={coverUrl} alt="" loading="lazy" className="h-full w-full object-cover object-top" />
      ) : (
        <div className="dz-canvas grid h-full w-full place-items-center text-muted-foreground/40">
          <ImageIcon size={22} strokeWidth={1.5} />
        </div>
      )}
      <div className="absolute left-2 top-2">
        <ActiveRunBadge status={runStatus} />
      </div>
    </div>
  );
}

export function HomeScreen({
  projects: projectsOverride,
  onNewProject,
  onOpenProject,
}: {
  projects?: Project[];
  onNewProject?: (brief: string, skillId: string, designSystemId: string, mode: ProjectMode) => void;
  onOpenProject?: (id: string) => void;
}) {
  const api = useApi();
  const { toast } = useToast();
  const [initialComposerPrefs] = useState<HomeComposerPrefs>(() => readHomeComposerPrefs());
  const [brief, setBrief] = useState("");
  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
  const [optimizedOriginalPrompt, setOptimizedOriginalPrompt] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [skillId, setSkillIdState] = useState(initialComposerPrefs.skillId ?? DEFAULT_SKILL);
  const [systems, setSystems] = useState<DesignSystemCard[]>([]);
  const { agents, rescan: rescanAgents } = useAgents();
  const [settingsAgent, setSettingsAgent] = useState<string | null>(null); // null = settings not loaded yet
  const [settingsModel, setSettingsModel] = useState("");
  const [homeAgent, setHomeAgent] = useState("");
  const [homeModel, setHomeModel] = useState("");
  const [designSystemId, setDesignSystemIdState] = useState(initialComposerPrefs.designSystemId ?? DEFAULT_DS);
  const [mode, setModeState] = useState<ProjectMode>(initialComposerPrefs.mode ?? "prototype");
  const [projects, setProjects] = useState<Project[]>(projectsOverride ?? []);
  const [loading, setLoading] = useState(!projectsOverride);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "name" | "oldest">("recent");
  const [view, setView] = useState<"active" | "archived">("active");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [images, setImages] = useState<{ name: string; base64: string; preview: string }[]>([]);
  const [refs, setRefs] = useState<{ id: string; name: string; base64: string }[]>([]);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const setSkillId = useCallback((value: string) => {
    setSkillIdState(value);
    writeHomeComposerPrefs({ skillId: value });
  }, []);

  const setDesignSystemId = useCallback((value: string) => {
    setDesignSystemIdState(value);
    writeHomeComposerPrefs({ designSystemId: value });
  }, []);

  const setMode = useCallback((value: ProjectMode) => {
    setModeState(value);
    writeHomeComposerPrefs({ mode: value });
  }, []);

  const refresh = useCallback(() => {
    if (projectsOverride) return;
    api
      .listProjects()
      .then(setProjects)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [api, projectsOverride]);

  useEffect(() => {
    if (projectsOverride) setProjects(projectsOverride);
    else refresh();
  }, [projectsOverride, refresh]);

  // Consume a one-shot prefill from "remix" / template gallery.
  useEffect(() => {
    const p = takePendingComposer();
    if (!p) return;
    if (p.brief !== undefined) setBrief(p.brief);
    if (p.skillId) setSkillId(p.skillId);
    if (p.designSystemId) setDesignSystemId(p.designSystemId);
  }, []);

  // Consume a one-shot capture handed off by the browser extension. Polled on mount and
  // whenever the window regains focus, so an already-open Dezin picks up an Import even
  // while it was in the background.
  useEffect(() => {
    if (projectsOverride) return;
    // Capture consumption is explicit (POST /consume), so passive GETs/prefetches cannot clear
    // the handoff. StrictMode can still double-invoke this, but whichever consume wins applies it.
    const pull = () => {
      void api
        .getCapture()
        .then((cap) => {
          if (!cap.images.length) return;
          setImages((cur) => [...cur, ...cap.images.map((i) => ({ name: i.name, base64: i.base64, preview: `data:image/png;base64,${i.base64}` }))]);
          if (cap.note) setBrief((b) => (b.trim() ? b : cap.note));
          toast(`Imported ${cap.images.length} reference${cap.images.length === 1 ? "" : "s"} from ${cap.source}.`);
        })
        .catch(() => {});
    };
    const onVisible = () => {
      if (!document.hidden) pull();
    };
    pull();
    window.addEventListener("focus", pull);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", pull);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [api, projectsOverride, toast]);

  useEffect(() => {
    let alive = true;
    api
      .listSkills()
      .then((s) => {
        if (!alive) return;
        setSkills(s);
        if (s.length && !s.some((x) => x.id === DEFAULT_SKILL)) setSkillId(s[0]!.id);
      })
      .catch(() => {});
    api
      .listDesignSystems()
      .then((d) => {
        if (!alive) return;
        setSystems(d);
        if (d.length && !d.some((x) => x.id === DEFAULT_DS)) setDesignSystemId(d[0]!.id);
      })
      .catch(() => {});
    void api
      .getSettings()
      .then((s) => {
        if (!alive) return;
        setSettingsAgent(s?.agentCommand ?? "");
        setSettingsModel(s?.model ?? "");
      })
      .catch(() => alive && setSettingsAgent(""));
    return () => {
      alive = false;
    };
  }, [api]);

  // Default the composer to the saved agent + model — but only once settings have loaded, so
  // the scan resolving first doesn't lock it onto the first available agent. A manual pick
  // (homeAgent already set) is preserved.
  useEffect(() => {
    if (settingsAgent === null) return;
    const avail = agents.filter((a) => a.available);
    if (!avail.length) return;
    const useSaved = settingsAgent !== "" && avail.some((a) => a.command === settingsAgent);
    setHomeAgent((cur) => cur || (useSaved ? settingsAgent : avail[0]!.command));
    if (useSaved && settingsModel) setHomeModel((cur) => cur || settingsModel);
  }, [agents, settingsAgent, settingsModel]);

  const saveAgentModelDefaults = useCallback(
    (patch: Pick<Settings, "agentCommand" | "model">) => {
      persistAgentModelDefaults(api, patch, () => toast("Couldn't save settings.", { variant: "error" }));
    },
    [api, toast],
  );

  const changeHomeAgent = useCallback(
    (command: string) => {
      setHomeAgent(command);
      setHomeModel("");
      setSettingsAgent(command);
      setSettingsModel("");
      saveAgentModelDefaults({ agentCommand: command, model: "" });
    },
    [saveAgentModelDefaults],
  );

  const changeHomeModel = useCallback(
    (model: string) => {
      setHomeModel(model);
      setSettingsModel(model);
      if (homeAgent) saveAgentModelDefaults({ agentCommand: homeAgent, model });
    },
    [homeAgent, saveAgentModelDefaults],
  );

  const addImages = async (files: FileList | File[] | null): Promise<void> => {
    if (!files) return;
    for (const file of Array.from(files).filter((f) => f.type.startsWith("image/"))) {
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        setImages((cur) => [...cur, { name: file.name, base64: dataUrl.split(",")[1] ?? "", preview: dataUrl }]);
      } catch {
        toast("Couldn't read that image.", { variant: "error" });
      }
    }
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
      setBrief((current) => `${current}${current.trim() ? "\n\n" : ""}Use these local paths as reference: ${paths.join(", ")}`);
    }
    void filesFromDataTransfer(dataTransfer).then(addImages);
  };

  const referenceProject = async (project: Project): Promise<void> => {
    if (refs.some((r) => r.id === project.id)) return;
    try {
      const html = await fetchProjectArtifact(api, project.id);
      if (!html) {
        toast("That project has no design to reference yet.", { variant: "error" });
        return;
      }
      setRefs((cur) => [...cur, { id: project.id, name: project.name, base64: toBase64(html) }]);
    } catch {
      toast("Couldn't reference that project.", { variant: "error" });
    }
  };

  const submit = () => {
    const text =
      brief.trim() ||
      (images.length ? "Recreate the reference screenshot faithfully." : refs.length ? "Build on the referenced design." : "");
    if (!text) return;
    if (images.length) setPendingImages(images.map((i) => ({ name: i.name, base64: i.base64 })));
    if (refs.length) setPendingRefs(refs.map((r) => ({ name: r.name, base64: r.base64 })));
    if (homeAgent) setPendingAgent(homeAgent, homeModel || undefined);
    onNewProject?.(text, skillId, designSystemId, mode);
  };

  const updateBrief = (value: string): void => {
    setBrief(value);
    if (optimizedOriginalPrompt !== null) setOptimizedOriginalPrompt(null);
  };

  const optimizeCurrentPrompt = async (): Promise<void> => {
    const original = brief.trim();
    if (!original || optimizingPrompt) return;
    setOptimizingPrompt(true);
    try {
      const result = await api.optimizePrompt({
        prompt: original,
        agentCommand: homeAgent || undefined,
        model: homeModel || undefined,
        mode,
        skillId,
        designSystemId,
      });
      const next = result.prompt.trim();
      if (!next) throw new Error("empty optimized prompt");
      setBrief(next);
      setOptimizedOriginalPrompt(original);
    } catch {
      toast("Couldn't optimize that prompt.", { variant: "error" });
    } finally {
      setOptimizingPrompt(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this project permanently? This can't be undone.")) return;
    try {
      await api.deleteProject(id);
      refresh();
    } catch {
      toast("Couldn't delete the project.", { variant: "error" });
    }
  };
  const archive = async (id: string) => {
    try {
      await api.patchProject(id, { archived: true });
      refresh();
      toast("Project archived.");
    } catch {
      toast("Couldn't archive the project.", { variant: "error" });
    }
  };
  const restore = async (id: string) => {
    try {
      await api.patchProject(id, { archived: false });
      refresh();
    } catch {
      toast("Couldn't restore the project.", { variant: "error" });
    }
  };
  const importProject = async (files: FileList | null): Promise<void> => {
    const file = files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const project = await api.importProject(file);
      refresh();
      toast(`Imported ${project.name}.`);
    } catch {
      toast("Couldn't import that project.", { variant: "error" });
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const startRename = (p: Project) => {
    setEditingId(p.id);
    setDraft(p.name);
  };
  const commitRename = async (id: string) => {
    const name = draft.trim();
    setEditingId(null);
    if (!name) return;
    try {
      await api.patchProject(id, { name });
      refresh();
    } catch {
      toast("Couldn't rename the project.", { variant: "error" });
    }
  };

  const skillName = (id?: string | null) => skills.find((s) => s.id === id)?.name;
  const dsName = (id?: string | null) => systems.find((s) => s.id === id)?.name ?? id ?? "";

  const archivedCount = projects.filter((p) => p.archivedAt).length;
  const activeCount = projects.length - archivedCount;


  // Hover actions for a project, shared by the grid and list views.
  const projectActions = (p: Project) =>
    view === "archived" ? (
      <>
        <IconButton aria-label={`Restore ${p.name}`} onClick={() => void restore(p.id)}>
          <ArchiveRestore size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton aria-label={`Delete ${p.name}`} className="hover:text-destructive" onClick={() => void remove(p.id)}>
          <Trash2 size={14} strokeWidth={1.75} />
        </IconButton>
      </>
    ) : (
      <>
        <IconButton aria-label={`Rename ${p.name}`} onClick={() => startRename(p)}>
          <Pencil size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton aria-label={`Archive ${p.name}`} onClick={() => void archive(p.id)}>
          <Archive size={14} strokeWidth={1.75} />
        </IconButton>
      </>
    );
  const visible = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const list = projects
      .filter((p) => (view === "archived" ? p.archivedAt : !p.archivedAt))
      .filter((p) => !ql || p.name.toLowerCase().includes(ql));
    const sorted = [...list];
    if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "oldest") sorted.sort((a, b) => a.createdAt - b.createdAt);
    else sorted.sort((a, b) => b.updatedAt - a.updatedAt);
    return sorted;
  }, [projects, q, sort, view]);

  // Five high-level template types (mapped to the underlying skills).
  const skillOptions: PickerOption[] = [
    { value: "frontend-design", label: "Design", icon: <Palette size={15} strokeWidth={1.75} /> },
    { value: "deck", label: "Slides", icon: <Presentation size={15} strokeWidth={1.75} /> },
    { value: "doc", label: "Document", icon: <FileText size={15} strokeWidth={1.75} /> },
    { value: "wireframe", label: "Wireframe", icon: <PenLine size={15} strokeWidth={1.75} /> },
    { value: "motion-landing", label: "Animation", icon: <Sparkles size={15} strokeWidth={1.75} /> },
  ];

  return (
    <div className="relative h-full w-full overflow-auto">
      {/* one restrained top glow — atmosphere, not a marketing mesh */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[36vh]"
        style={{ background: "radial-gradient(60% 100% at 30% 0%, color-mix(in oklch, var(--primary) 12%, transparent), transparent 70%)" }}
      />
      <div className="relative w-full px-7 pb-20 pt-10">
        <div className="mx-auto max-w-5xl">
          {/* Compact tool header */}
          <div className="max-w-2xl">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Start a design</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Describe what you want. Dezin builds a real, tasteful artifact, then lints it against its own anti-slop rules.
            </p>
          </div>

          <div
            aria-label="Design prompt dropzone"
            className="mt-5 w-full rounded-2xl border border-input bg-card/80 p-2.5 transition-[color,border-color,box-shadow] duration-150 hover:border-border-strong focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 focus-within:hover:border-ring"
            onDragEnter={handlePromptDragOver}
            onDragOver={handlePromptDragOver}
            onDrop={handlePromptDrop}
          >
            <div className="rounded-xl">
              <input
                ref={imgInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  void addImages(e.target.files);
                  e.target.value = "";
                }}
              />
              {images.length ? (
                <div className="flex flex-wrap gap-2 px-2 pb-1 pt-1.5">
                  {images.map((img, i) => (
                    <span key={`${img.name}-${i}`} className="group relative overflow-hidden rounded-lg border border-border">
                      <img src={img.preview} alt={img.name} className="h-16 w-16 object-cover" />
                      <button
                        type="button"
                        aria-label={`Remove ${img.name}`}
                        onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
                        className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-md bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                      >
                        <X size={12} strokeWidth={2} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              {refs.length ? (
                <div className="flex flex-wrap gap-1.5 px-2 pb-1 pt-1.5">
                  {refs.map((r) => (
                    <span
                      key={r.id}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2/60 py-1 pl-2 pr-1 text-xs"
                    >
                      <Layers size={12} strokeWidth={1.75} className="text-muted-foreground" />
                      <span className="max-w-[12rem] truncate font-medium">{r.name}</span>
                      <button
                        type="button"
                        aria-label={`Remove reference ${r.name}`}
                        onClick={() => setRefs((cur) => cur.filter((x) => x.id !== r.id))}
                        className="grid size-4 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <X size={11} strokeWidth={2} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="relative">
                {optimizingPrompt ? (
                  <div
                    aria-hidden
                    className="prompt-loading-gradient motion-safe:animate-prompt-loading-gradient pointer-events-none absolute inset-x-2 bottom-0 top-0 rounded-xl opacity-70"
                  />
                ) : null}
                <textarea
                  aria-label="Describe your design"
                  value={brief}
                  disabled={optimizingPrompt}
                  onChange={(e) => updateBrief(e.target.value)}
                  placeholder={images.length ? "Add notes, or just build to recreate the screenshot…" : "A pricing page with three plans, the middle one recommended…"}
                  rows={3}
                  className="field-sizing-content max-h-64 min-h-[92px] w-full resize-none bg-transparent px-3 py-2.5 pr-12 text-base leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-wait disabled:opacity-70"
                />
                {brief.trim().length > 0 ? (
                  <TooltipProvider delayDuration={120}>
                    <div className="absolute bottom-2 right-2 flex items-center gap-1">
                      {optimizedOriginalPrompt !== null && !optimizingPrompt ? (
                        <>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <IconButton
                                aria-label="Reject optimized prompt"
                                className="h-7 w-7 rounded-md bg-background/80 shadow-sm backdrop-blur"
                                onClick={() => {
                                  setBrief(optimizedOriginalPrompt);
                                  setOptimizedOriginalPrompt(null);
                                }}
                              >
                                <X size={13} strokeWidth={2} />
                              </IconButton>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={2}>Reject optimized prompt</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <IconButton
                                aria-label="Accept optimized prompt"
                                className="h-7 w-7 rounded-md bg-background/80 text-foreground shadow-sm backdrop-blur"
                                onClick={() => setOptimizedOriginalPrompt(null)}
                              >
                                <Check size={13} strokeWidth={2} />
                              </IconButton>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={2}>Accept optimized prompt</TooltipContent>
                          </Tooltip>
                        </>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <IconButton
                              aria-label="Optimize prompt"
                              disabled={optimizingPrompt}
                              className="h-7 w-7 rounded-md bg-background/80 shadow-sm backdrop-blur"
                              onClick={() => void optimizeCurrentPrompt()}
                            >
                              {optimizingPrompt ? <Spinner size={13} /> : <Sparkles size={13} strokeWidth={1.8} />}
                            </IconButton>
                          </TooltipTrigger>
                          <TooltipContent sideOffset={2}>Optimize prompt</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </TooltipProvider>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 px-1 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <AttachMenu
                    onAttachFile={() => imgInputRef.current?.click()}
                    onPickPaths={(paths) => setBrief((b) => `${b}${b.trim() ? "\n\n" : ""}Use these local paths as reference: ${paths.join(", ")}`)}
                    onContext={(text) => setBrief((b) => `${b}${b.trim() ? "\n\n" : ""}${text}`)}
                    onReference={(p) => void referenceProject(p)}
                  />
                  <FieldSelect label="Template" value={skillId} options={skillOptions} onChange={setSkillId} />
                  <DesignSystemSelect systems={systems} value={designSystemId} onChange={setDesignSystemId} defaultId={DEFAULT_DS} />
                  <FieldSelect
                    label="Mode"
                    value={mode}
                    onChange={setMode}
                    options={[
                      {
                        value: "prototype",
                        label: "Prototype",
                        icon: <Zap size={15} strokeWidth={1.75} />,
                        description: "One self-contained HTML file — fastest to iterate.",
                      },
                      {
                        value: "standard",
                        label: "Standard",
                        icon: <Boxes size={15} strokeWidth={1.75} />,
                        description: "A real Vite + React project with components and routing.",
                      },
                    ]}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <AgentModelSelect
                    agents={agents}
                    agent={homeAgent}
                    model={homeModel}
                    onAgentChange={changeHomeAgent}
                    onModelChange={changeHomeModel}
                    onRescan={rescanAgents}
                  />
                  <Button
                    size="lg"
                    onClick={submit}
                    disabled={optimizingPrompt || (brief.trim().length === 0 && images.length === 0)}
                    aria-label="Build"
                    className="px-6 shadow-[0_8px_24px_-8px_color-mix(in_oklch,var(--primary)_60%,transparent)]"
                  >
                    Build
                    <ArrowRight size={16} strokeWidth={2} />
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <span className="label-mono">Start from</span>
            {TEMPLATES.map((t) => (
              <button
                key={t.label}
                type="button"
                onClick={() => {
                  updateBrief(t.brief);
                  setSkillId(t.skillId);
                  setDesignSystemId(t.designSystemId);
                }}
                className="rounded-full border border-border bg-card/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Project gallery */}
        <div className="mt-14">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept=".zip,application/zip"
            aria-label="Import project zip"
            className="hidden"
            onChange={(e) => void importProject(e.target.files)}
          />
          <Tabs
            aria-label="Project view"
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
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  aria-label="Import full project ZIP"
                  disabled={importing}
                  onClick={() => importInputRef.current?.click()}
                >
                  <FolderInput size={14} strokeWidth={1.75} />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent sideOffset={2}>Import full project ZIP</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <div className="ml-auto flex items-center gap-1.5">
            <Picker
              ariaLabel="Sort projects"
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
            <SearchInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              aria-label="Search projects"
              className="w-32 sm:w-44"
            />
          </div>
        </div>

        {loading ? (
          <Loading label="Loading projects…" />
        ) : visible.length === 0 ? (
          <div className="mt-5 grid min-h-[340px] place-items-center rounded-2xl border border-dashed border-border dz-canvas">
            <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
              <span className="grid size-14 place-items-center rounded-2xl border border-border bg-card text-muted-foreground">
                {view === "archived" ? <Archive size={24} strokeWidth={1.5} /> : <Sparkles size={24} strokeWidth={1.5} />}
              </span>
              <p className="text-base font-medium text-foreground">
                {q.trim() ? "No matches" : view === "archived" ? "Nothing archived" : "No projects yet"}
              </p>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {q.trim()
                  ? "No projects match your search. Try a different term."
                  : view === "archived"
                    ? "Projects you archive will show up here — restore them any time."
                    : "Describe a design in the box above and hit Build to create your first project."}
              </p>
            </div>
          </div>
        ) : layout === "grid" ? (
          <Stagger as="ul" className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visible.map((p) => (
              <StaggerItem as="li" key={p.id}>
                <Card
                  className="group cursor-pointer gap-0 overflow-hidden p-0 transition-all duration-150 ease-[var(--ease-out)] hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop"
                  onClick={() => onOpenProject?.(p.id)}
                >
                  <ProjectThumb coverUrl={p.coverUrl} runStatus={p.runStatus} />
                  <div className="p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                        <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                          <span className="truncate">{dsName(p.designSystemId)}</span>
                          {skillName(p.skillId) ? (
                            <>
                              <span className="text-border-strong">·</span>
                              <span className="truncate">{skillName(p.skillId)}</span>
                            </>
                          ) : null}
                        </p>
                      </div>
                      <div
                        className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {projectActions(p)}
                      </div>
                    </div>
                  </div>
                </Card>
              </StaggerItem>
            ))}
          </Stagger>
        ) : (
          <div data-testid="project-list-view" data-staggered="true">
            <Stagger as="ul" className="mt-5 overflow-hidden rounded-xl border border-border">
              {visible.map((p) => (
                <StaggerItem as="li" key={p.id} className="border-b border-border last:border-0">
                  <div
                    onClick={() => onOpenProject?.(p.id)}
                    className="group flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-2/50"
                  >
                    <div className="h-9 w-12 shrink-0 overflow-hidden rounded-md border border-border bg-surface-2">
                      {p.coverUrl ? (
                        <img src={p.coverUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="dz-canvas grid h-full w-full place-items-center">
                          <ImageIcon size={13} strokeWidth={1.5} className="text-muted-foreground/60" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                        <ActiveRunBadge status={p.runStatus} />
                      </div>
                      <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                        <span className="truncate">{dsName(p.designSystemId)}</span>
                        {skillName(p.skillId) ? (
                          <>
                            <span className="text-border-strong">·</span>
                            <span className="truncate">{skillName(p.skillId)}</span>
                          </>
                        ) : null}
                      </p>
                    </div>
                    <div className="relative flex min-w-[7rem] shrink-0 justify-end" onClick={(e) => e.stopPropagation()}>
                      <span className="text-xs text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                        {formatUpdatedAt(p.updatedAt)}
                      </span>
                      <div
                        data-testid={`project-list-actions-${p.id}`}
                        className="absolute right-0 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
                      >
                        {projectActions(p)}
                      </div>
                    </div>
                  </div>
                </StaggerItem>
              ))}
            </Stagger>
          </div>
        )}
        </div>
      </div>

      <Dialog open={editingId !== null} onClose={() => setEditingId(null)} label="Rename project" className="max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (editingId) void commitRename(editingId);
          }}
          className="p-5"
        >
          <h2 className="text-base font-semibold tracking-tight">Rename project</h2>
          <Input
            aria-label="Project name"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Project name"
            className="mt-3"
          />
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditingId(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={draft.trim().length === 0}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
