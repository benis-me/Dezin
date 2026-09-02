import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Boxes,
  Check,
  FileText,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
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
  Stagger,
  StaggerItem,
  Tabs,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/index.ts";
import { AttachMenu } from "../components/AttachMenu.tsx";
import {
  AgentComposerContextCards,
  type AgentComposerContextItem,
} from "../components/AgentComposerContext.tsx";
import { useApi } from "../lib/api-context.tsx";
import { useAgents } from "../lib/agents-context.tsx";
import { useToast } from "../components/Toast.tsx";
import { persistAgentModelDefaults } from "../lib/agent-model-defaults.ts";
import {
  agentAvailabilityReason,
  normalizeAgentModel,
  selectableAgents,
} from "../lib/agent-availability.ts";
import { isCloneUrl } from "../lib/clone-url.ts";
import sharinganEyeUrl from "../assets/sharingan-eye.png";
import { filesFromDataTransfer, hasDraggedFiles } from "../lib/drag-drop.ts";
import { native } from "../lib/native.ts";
import { takePendingComposer } from "../lib/pending-composer.ts";
import {
  type DesignProjectAttachments,
  type DesignProjectReferenceIdentity,
} from "../lib/design-attachments.ts";
import { publishSettingsUpdated, SETTINGS_UPDATED_EVENT } from "../lib/settings-events.ts";
import { useAutoRefresh } from "../lib/use-auto-refresh.ts";
import { cn } from "../lib/utils.ts";
import { beginResourceLoad, idleResource, readyResource, rejectResource, resolveResource } from "../lib/async-resource.ts";
import type { DesignCanvas, DesignNodeKind } from "../design-canvas/types.ts";
import {
  type Project,
  type Settings,
} from "../lib/api.ts";

const MAX_HOME_IMAGE_ATTACHMENTS = 2;
const MAX_HOME_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_HOME_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_HOME_CONTEXT_ITEMS = 32;
const AgentModelSelect = lazy(() => import("../components/AgentModelSelect.tsx").then((module) => ({
  default: module.AgentModelSelect,
})));

type HomeImageMimeType = "image/png" | "image/jpeg";
type HomeImageAttachment = {
  name: string;
  base64: string;
  preview: string;
  mimeType: HomeImageMimeType;
  byteSize: number;
};
type HomeProjectReference = {
  id: string;
  projectId: string;
  name: string;
  base64: string;
  projectReference?: DesignProjectReferenceIdentity;
};

interface HomeAttachments {
  images: HomeImageAttachment[];
  refs: HomeProjectReference[];
}

interface ExactCanvasProjectReferenceSelection {
  identity: DesignProjectReferenceIdentity;
  nodeName: string;
  nodeKind: DesignNodeKind;
}

function exactCanvasProjectReferences(
  projectId: string,
  canvas: DesignCanvas,
): ExactCanvasProjectReferenceSelection[] {
  if (canvas.projectId !== projectId) return [];
  return canvas.nodes
    .filter((node) => node.currentVersionId !== null)
    .sort((left, right) => {
      const kind = Number(left.kind !== "page") - Number(right.kind !== "page");
      return kind || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
    })
    .flatMap((node): ExactCanvasProjectReferenceSelection[] => {
      if (!node.currentVersionId) return [];
      return [{
        identity: {
          sourceProjectId: projectId,
          sourceNodeId: node.id,
          sourceVersionId: node.currentVersionId,
        },
        nodeName: node.name,
        nodeKind: node.kind,
      }];
    });
}

function exactHomeImageMimeType(file: File): HomeImageMimeType | null {
  const normalizedType = file.type.trim().toLowerCase();
  return normalizedType === "image/png" || normalizedType === "image/jpeg"
    ? normalizedType
    : null;
}

function decodedHomeImage(
  dataUrl: string,
  expectedMimeType: HomeImageMimeType,
): { base64: string; byteSize: number } | null {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || match[1] !== expectedMimeType) return null;
  let bytes: string;
  try {
    bytes = atob(match[2]!);
  } catch {
    return null;
  }
  if (bytes.length <= 0 || bytes.length > MAX_HOME_IMAGE_BYTES) return null;
  const valid = expectedMimeType === "image/png"
    ? bytes.length >= 8
      && bytes.charCodeAt(0) === 0x89
      && bytes.slice(1, 4) === "PNG"
      && bytes.charCodeAt(4) === 0x0d
      && bytes.charCodeAt(5) === 0x0a
      && bytes.charCodeAt(6) === 0x1a
      && bytes.charCodeAt(7) === 0x0a
    : bytes.length >= 4
      && bytes.charCodeAt(0) === 0xff
      && bytes.charCodeAt(1) === 0xd8
      && bytes.charCodeAt(bytes.length - 2) === 0xff
      && bytes.charCodeAt(bytes.length - 1) === 0xd9;
  return valid ? { base64: match[2]!, byteSize: bytes.length } : null;
}

/**
 * The project cover: a real screenshot of the design when one exists, else a clean
 * placeholder (no abstract swatch art, no glyph overlay).
 */
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

function ProjectThumb({ coverUrl }: { coverUrl?: string | null }) {
  return (
    <div className="relative aspect-[16/10] overflow-hidden border-b border-border bg-surface-2">
      {coverUrl ? (
        <img src={coverUrl} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover object-top" />
      ) : (
        <div className="dz-canvas grid h-full w-full place-items-center text-muted-foreground/40">
          <ImageIcon size={22} strokeWidth={1.5} />
        </div>
      )}
    </div>
  );
}

export function HomeScreen({
  projects: projectsOverride,
  onNewProject,
  onOpenProject,
}: {
  projects?: Project[];
  onNewProject?: (
    brief: string,
    sharingan?: { sourceUrl: string },
    agentSelection?: { agentCommand: string; model?: string },
    attachments?: DesignProjectAttachments,
  ) => void | Promise<void>;
  onOpenProject?: (id: string) => void;
}) {
  const api = useApi();
  const { toast } = useToast();
  const [brief, setBrief] = useState("");
  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
  const [optimizedOriginalPrompt, setOptimizedOriginalPrompt] = useState<string | null>(null);
  const { agents, loading: agentsLoading, rescan: rescanAgents } = useAgents();
  const [settingsAgent, setSettingsAgent] = useState<string | null>(null); // null = settings not loaded yet
  const [settingsModel, setSettingsModel] = useState("");
  const [homeAgent, setHomeAgent] = useState("");
  const [homeModel, setHomeModel] = useState("");
  const selectedHomeAgent = agents.find((candidate) => candidate.command === homeAgent);
  const homeAgentBlockedReason = homeAgent
    ? agentAvailabilityReason(selectedHomeAgent)
    : null;
  // Sharingan: clone-from-URL mode. Toggled by double-clicking the heading and swaps the
  // composer's textarea for a URL input (desktop-only entry).
  const [sharingan, setSharingan] = useState(false);
  // First-run authorized-use affirmation: gates the very first Sharingan submit until the user
  // confirms they have the right to reproduce the target site. Persisted in Settings so it only
  // ever prompts once per install.
  const [affirmed, setAffirmed] = useState(false);
  const [affirmPending, setAffirmPending] = useState<null | { url: string }>(null);
  const [projectsResource, setProjectsResource] = useState(() =>
    projectsOverride ? readyResource(projectsOverride) : idleResource<Project[]>(),
  );
  const projectRequestRef = useRef(0);
  const projects = projectsResource.data ?? [];
  const loading = projectsResource.status === "idle" || projectsResource.status === "loading";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "name" | "oldest">("recent");
  const [view, setView] = useState<"active" | "archived">("active");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [homeAttachments, setHomeAttachments] = useState<HomeAttachments>({ images: [], refs: [] });
  const [canvasReferencePicker, setCanvasReferencePicker] = useState<{
    project: Project;
    selections: ExactCanvasProjectReferenceSelection[];
  } | null>(null);
  const homeAttachmentsRef = useRef(homeAttachments);
  const homeAttachmentReservationsRef = useRef(0);
  const homeImageReservationsRef = useRef(0);
  const homeImageByteReservationsRef = useRef(0);
  const homeReferenceReservationsRef = useRef(new Set<string>());
  const pendingAttachmentOperationsRef = useRef(0);
  const [pendingAttachmentOperations, setPendingAttachmentOperations] = useState(0);
  const images = homeAttachments.images;
  const refs = homeAttachments.refs;
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);

  const commitHomeAttachments = useCallback((next: HomeAttachments): void => {
    homeAttachmentsRef.current = next;
    setHomeAttachments(next);
  }, []);

  const reserveHomeAttachmentSlots = useCallback((requested: number): number => {
    const current = homeAttachmentsRef.current;
    const available = Math.max(
      0,
      MAX_HOME_CONTEXT_ITEMS
        - current.images.length
        - current.refs.length
        - homeAttachmentReservationsRef.current,
    );
    const reserved = Math.min(Math.max(0, requested), available);
    homeAttachmentReservationsRef.current += reserved;
    return reserved;
  }, []);

  const releaseHomeAttachmentSlots = useCallback((reserved: number): void => {
    homeAttachmentReservationsRef.current = Math.max(0, homeAttachmentReservationsRef.current - reserved);
  }, []);

  const beginAttachmentOperation = useCallback((): (() => void) => {
    pendingAttachmentOperationsRef.current += 1;
    setPendingAttachmentOperations(pendingAttachmentOperationsRef.current);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      pendingAttachmentOperationsRef.current = Math.max(0, pendingAttachmentOperationsRef.current - 1);
      setPendingAttachmentOperations(pendingAttachmentOperationsRef.current);
    };
  }, []);

  const notifyHomeAttachmentLimit = useCallback(
    (omitted: number): void => {
      if (omitted <= 0) return;
      toast(
        `You can attach up to ${MAX_HOME_CONTEXT_ITEMS} images and project references. ${omitted} ${
          omitted === 1 ? "item was" : "items were"
        } not added.`,
        { variant: "error" },
      );
    },
    [toast],
  );

  const notifyHomeImageLimit = useCallback(
    (omitted: number): void => {
      if (omitted <= 0) return;
      toast(
        `You can attach up to ${MAX_HOME_IMAGE_ATTACHMENTS} PNG or JPEG images. ${omitted} ${
          omitted === 1 ? "image was" : "images were"
        } not added.`,
        { variant: "error" },
      );
    },
    [toast],
  );

  const appendHomeImages = useCallback(
    (incoming: HomeImageAttachment[], notifyLimit = true): { added: number; omitted: number } => {
      if (!incoming.length) return { added: 0, omitted: 0 };
      const current = homeAttachmentsRef.current;
      const availableItems = Math.max(
        0,
        MAX_HOME_CONTEXT_ITEMS
          - current.images.length
          - current.refs.length
          - homeAttachmentReservationsRef.current,
      );
      const availableImages = Math.max(
        0,
        MAX_HOME_IMAGE_ATTACHMENTS - current.images.length - homeImageReservationsRef.current,
      );
      let availableBytes = Math.max(
        0,
        MAX_HOME_TOTAL_IMAGE_BYTES
          - current.images.reduce((total, image) => total + image.byteSize, 0)
          - homeImageByteReservationsRef.current,
      );
      const accepted: HomeImageAttachment[] = [];
      for (const image of incoming) {
        if (accepted.length >= Math.min(availableItems, availableImages) || image.byteSize > availableBytes) continue;
        accepted.push(image);
        availableBytes -= image.byteSize;
      }
      const omitted = incoming.length - accepted.length;
      if (accepted.length) {
        commitHomeAttachments({ ...current, images: [...current.images, ...accepted] });
      }
      if (notifyLimit) notifyHomeImageLimit(omitted);
      return { added: accepted.length, omitted };
    },
    [commitHomeAttachments, notifyHomeImageLimit],
  );

  const appendHomeProjectReference = useCallback(
    (incoming: HomeProjectReference): boolean => {
      const current = homeAttachmentsRef.current;
      if (current.refs.some((ref) => ref.id === incoming.id)) return false;
      if (
        current.images.length + current.refs.length + homeAttachmentReservationsRef.current
        >= MAX_HOME_CONTEXT_ITEMS
      ) {
        notifyHomeAttachmentLimit(1);
        return false;
      }
      commitHomeAttachments({ ...current, refs: [...current.refs, incoming] });
      return true;
    },
    [commitHomeAttachments, notifyHomeAttachmentLimit],
  );

  const homeDisplayItems = useMemo<AgentComposerContextItem[]>(
    () => [
      ...images.map((image, index) => ({
        id: `home-image:${image.name}:${index}`,
        type: "file" as const,
        title: image.name,
        name: image.name,
        path: image.name,
        previewUrl: image.preview,
        mimeType: image.mimeType,
      })),
      ...refs.map((ref) => ({
        id: `project:${ref.id}`,
        type: "project" as const,
        title: ref.name,
        subtitle: "Project",
        projectId: ref.projectId,
        name: ref.name,
      })),
    ],
    [images, refs],
  );

  // Sharingan is desktop-only (it drives a real browser session in the Electron main process).
  const toggleSharingan = useCallback(() => {
    if (sharingan) {
      setSharingan(false);
      return;
    }
    if (!native?.isElectron) {
      toast("Sharingan (clone from a URL) requires the desktop app.", { variant: "error" });
      return;
    }
    setSharingan(true);
  }, [sharingan, toast]);

  const refresh = useCallback(() => {
    if (projectsOverride) return;
    const request = ++projectRequestRef.current;
    setProjectsResource((current) => beginResourceLoad(current));
    api
      .listProjects()
      .then((next) => {
        if (request === projectRequestRef.current) setProjectsResource(resolveResource(next));
      })
      .catch((error) => {
        if (request === projectRequestRef.current) setProjectsResource((current) => rejectResource(current, error));
      });
  }, [api, projectsOverride]);

  // Reflect Sharingan authorization changes made from another settings surface.
  useEffect(() => {
    const onSettings = (e: Event): void => {
      const s = (e as CustomEvent<Settings>).detail;
      if (!s) return;
      setAffirmed(!!s.sharinganAffirmed);
    };
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettings);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettings);
  }, []);

  useEffect(() => {
    if (projectsOverride) {
      projectRequestRef.current += 1;
      setProjectsResource(readyResource(projectsOverride));
    }
    else refresh();
  }, [projectsOverride, refresh]);

  // Keep the project list live — pick up run-status/cover changes without a manual reload.
  useAutoRefresh(refresh, { enabled: !projectsOverride });

  // Consume a one-shot prefill from "remix" / template gallery.
  useEffect(() => {
    const p = takePendingComposer();
    if (!p) return;
    if (p.brief !== undefined) setBrief(p.brief);
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
          const decoded = cap.images.flatMap((image): HomeImageAttachment[] => {
            const preview = `data:image/png;base64,${image.base64}`;
            const verified = decodedHomeImage(preview, "image/png");
            return verified === null
              ? []
              : [{
                  name: image.name.toLowerCase().endsWith(".png") ? image.name : `${image.name}.png`,
                  base64: verified.base64,
                  preview,
                  mimeType: "image/png",
                  byteSize: verified.byteSize,
                }];
          });
          const invalid = cap.images.length - decoded.length;
          if (invalid) {
            toast(
              `${invalid} browser ${invalid === 1 ? "capture was" : "captures were"} invalid or exceeded the 8 MiB image limit.`,
              { variant: "error" },
            );
          }
          const { added } = appendHomeImages(
            decoded,
          );
          if (cap.note) setBrief((b) => (b.trim() ? b : cap.note));
          if (added) toast(`Imported ${added} reference${added === 1 ? "" : "s"} from ${cap.source}.`);
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
  }, [api, appendHomeImages, projectsOverride, toast]);

  useEffect(() => {
    let alive = true;
    void api
      .getSettings()
      .then((s) => {
        if (!alive) return;
        setSettingsAgent(s?.agentCommand ?? "");
        setSettingsModel(s?.model ?? "");
        setAffirmed(!!s?.sharinganAffirmed);
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
    const selectable = selectableAgents(agents);
    const ready = agents.filter((candidate) => candidate.available);
    if (!selectable.length && !ready.length) return;
    const useSaved = settingsAgent !== "" && selectable.some((candidate) => candidate.command === settingsAgent);
    setHomeAgent((cur) => cur || (useSaved ? settingsAgent : ready[0]?.command ?? selectable[0]!.command));
    if (useSaved && settingsModel) setHomeModel((cur) => cur || settingsModel);
  }, [agents, settingsAgent, settingsModel]);

  useEffect(() => {
    if (agentsLoading || !homeAgent) return;
    const selected = agents.find((candidate) => candidate.command === homeAgent);
    setHomeModel((current) => normalizeAgentModel(selected, current));
  }, [agents, agentsLoading, homeAgent]);

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
    const supplied = Array.from(files);
    const typed = supplied.flatMap((file): Array<{ file: File; mimeType: HomeImageMimeType }> => {
      const mimeType = exactHomeImageMimeType(file);
      return mimeType === null ? [] : [{ file, mimeType }];
    });
    const unsupported = supplied.filter((file) => (
      file.type.startsWith("image/")
      || /\.(?:png|jpe?g|gif|webp|svg|avif|heic|heif)$/iu.test(file.name)
    )).length - typed.length;
    if (unsupported > 0) {
      toast(
        `Only PNG and JPEG images are supported. ${unsupported} ${
          unsupported === 1 ? "file was" : "files were"
        } not added.`,
        { variant: "error" },
      );
    }

    const current = homeAttachmentsRef.current;
    const availableImageCount = Math.max(
      0,
      MAX_HOME_IMAGE_ATTACHMENTS - current.images.length - homeImageReservationsRef.current,
    );
    let availableImageBytes = Math.max(
      0,
      MAX_HOME_TOTAL_IMAGE_BYTES
        - current.images.reduce((total, image) => total + image.byteSize, 0)
        - homeImageByteReservationsRef.current,
    );
    const candidates: Array<{ file: File; mimeType: HomeImageMimeType }> = [];
    let individualLimitOmissions = 0;
    let aggregateLimitOmissions = 0;
    let countLimitOmissions = 0;
    for (const candidate of typed) {
      if (candidate.file.size <= 0 || candidate.file.size > MAX_HOME_IMAGE_BYTES) {
        individualLimitOmissions += 1;
        continue;
      }
      if (candidates.length >= availableImageCount) {
        countLimitOmissions += 1;
        continue;
      }
      if (candidate.file.size > availableImageBytes) {
        aggregateLimitOmissions += 1;
        continue;
      }
      candidates.push(candidate);
      availableImageBytes -= candidate.file.size;
    }
    if (individualLimitOmissions > 0) {
      toast(
        `Each PNG or JPEG image must be 8 MiB or smaller. ${individualLimitOmissions} ${
          individualLimitOmissions === 1 ? "image was" : "images were"
        } not added.`,
        { variant: "error" },
      );
    }
    if (aggregateLimitOmissions > 0) {
      toast(
        `PNG and JPEG attachments can use up to 12 MiB in total. ${aggregateLimitOmissions} ${
          aggregateLimitOmissions === 1 ? "image was" : "images were"
        } not added.`,
        { variant: "error" },
      );
    }
    notifyHomeImageLimit(countLimitOmissions);

    const reserved = reserveHomeAttachmentSlots(candidates.length);
    const filesToRead = candidates.slice(0, reserved);
    const omittedByContextLimit = candidates.length - filesToRead.length;
    const reservedImageBytes = filesToRead.reduce((total, candidate) => total + candidate.file.size, 0);
    homeImageReservationsRef.current += filesToRead.length;
    homeImageByteReservationsRef.current += reservedImageBytes;
    const finishAttachmentOperation = filesToRead.length > 0 ? beginAttachmentOperation() : null;
    const incoming: HomeImageAttachment[] = [];
    try {
      for (const { file, mimeType } of filesToRead) {
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          const verified = decodedHomeImage(dataUrl, mimeType);
          if (verified === null) {
            toast(`${file.name || "That image"} is not a valid ${mimeType === "image/png" ? "PNG" : "JPEG"} image.`, {
              variant: "error",
            });
            continue;
          }
          incoming.push({
            name: file.name || (mimeType === "image/png" ? "image.png" : "image.jpg"),
            base64: verified.base64,
            preview: dataUrl,
            mimeType,
            byteSize: verified.byteSize,
          });
        } catch {
          toast("Couldn't read that image.", { variant: "error" });
        }
      }
    } finally {
      releaseHomeAttachmentSlots(reserved);
      homeImageReservationsRef.current = Math.max(0, homeImageReservationsRef.current - filesToRead.length);
      homeImageByteReservationsRef.current = Math.max(
        0,
        homeImageByteReservationsRef.current - reservedImageBytes,
      );
      try {
        const { omitted: omittedAfterRead } = appendHomeImages(incoming, false);
        notifyHomeAttachmentLimit(omittedByContextLimit);
        notifyHomeImageLimit(omittedAfterRead);
      } finally {
        finishAttachmentOperation?.();
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
    const finishAttachmentOperation = beginAttachmentOperation();
    void filesFromDataTransfer(dataTransfer)
      .then(addImages)
      .catch(() => {
        toast("Couldn't read the dropped context.", { variant: "error" });
      })
      .finally(finishAttachmentOperation);
  };

  const focusPromptEnd = useCallback(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }, []);

  const removeHomeDisplayItem = (id: string): void => {
    if (id.startsWith("home-image:")) {
      const current = homeAttachmentsRef.current;
      const nextImages = current.images.filter((image, index) => `home-image:${image.name}:${index}` !== id);
      if (nextImages.length !== current.images.length) commitHomeAttachments({ ...current, images: nextImages });
    } else if (id.startsWith("project:")) {
      const projectId = id.slice("project:".length);
      const current = homeAttachmentsRef.current;
      const nextRefs = current.refs.filter((ref) => ref.id !== projectId);
      if (nextRefs.length !== current.refs.length) commitHomeAttachments({ ...current, refs: nextRefs });
    }
    window.requestAnimationFrame(focusPromptEnd);
  };

  const referenceProject = async (project: Project): Promise<void> => {
    const current = homeAttachmentsRef.current;
    if (
      current.refs.some((ref) => ref.id === project.id)
      || homeReferenceReservationsRef.current.has(project.id)
    ) return;
    const reserved = reserveHomeAttachmentSlots(1);
    if (!reserved) {
      notifyHomeAttachmentLimit(1);
      return;
    }
    homeReferenceReservationsRef.current.add(project.id);
    const finishAttachmentOperation = beginAttachmentOperation();
    let reservationHeld = true;
    try {
      const selections = exactCanvasProjectReferences(project.id, await api.getDesignCanvas(project.id));
      if (selections.length === 0) {
        toast("That project has no generated Node version to reference yet.", { variant: "error" });
        return;
      }
      setCanvasReferencePicker({ project, selections });
      return;
    } catch {
      toast("Couldn't reference that project.", { variant: "error" });
    } finally {
      if (reservationHeld) releaseHomeAttachmentSlots(reserved);
      homeReferenceReservationsRef.current.delete(project.id);
      finishAttachmentOperation();
    }
  };

  const attachCanvasProjectReference = (
    project: Project,
    selection: ExactCanvasProjectReferenceSelection,
  ): void => {
    const attached = appendHomeProjectReference({
      id: `${project.id}:${selection.identity.sourceNodeId}:${selection.identity.sourceVersionId}`,
      projectId: project.id,
      name: `${project.name} / ${selection.nodeName}`,
      base64: "",
      projectReference: selection.identity,
    });
    if (attached) setCanvasReferencePicker(null);
  };

  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  // Guard against a double-click creating two projects (one empty orphan): the ref blocks a same-tick
  // second click synchronously; `creating` disables the button and is reset when the create settles.
  const startCreate = async (text: string, sharinganArg?: { sourceUrl: string }) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const currentAttachments = homeAttachmentsRef.current;
      const attachments: DesignProjectAttachments | undefined = currentAttachments.images.length || currentAttachments.refs.length
        ? {
            images: currentAttachments.images.map(({ name, base64, mimeType }) => ({ name, base64, mimeType })),
            refs: currentAttachments.refs.map(({ name, base64, projectReference }) => ({
              name,
              base64,
              ...(projectReference === undefined ? {} : { projectReference }),
            })),
          }
        : undefined;
      const agentSelection = homeAgent
        ? { agentCommand: homeAgent, ...(homeModel ? { model: homeModel } : {}) }
        : undefined;
      await onNewProject?.(text, sharinganArg, agentSelection, attachments);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const startBlankCanvas = async (): Promise<void> => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      await onNewProject?.("");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const submit = () => {
    if (pendingAttachmentOperationsRef.current > 0) {
      toast("Wait for attached context to finish loading.", { variant: "error" });
      return;
    }
    if (homeAgentBlockedReason) {
      toast(homeAgentBlockedReason, { variant: "error" });
      return;
    }
    const base =
      brief.trim() ||
      (images.length
        ? "Recreate the reference screenshot faithfully."
        : refs.length
          ? "Build on the referenced design."
          : "Use the attached context to create Canvas Nodes.");
    const text = sharingan ? brief.trim() : base;
    if (sharingan) {
      if (!isCloneUrl(text)) {
        toast("Enter a valid http(s) URL to clone.", { variant: "error" });
        return;
      }
      if (!affirmed) {
        setAffirmPending({ url: text });
        return;
      }
      void startCreate(text, { sourceUrl: text });
      return;
    }
    if (!text) return;
    void startCreate(text);
  };

  // Confirms the one-time authorized-use affirmation for Sharingan, persists it so it never
  // prompts again on this install, and then proceeds with the deferred clone run.
  const confirmAffirmation = useCallback(() => {
    const pending = affirmPending;
    if (!pending) return;
    setAffirmed(true);
    setAffirmPending(null);
    api
      .updateSettings({ sharinganAffirmed: true })
      .then((s) => publishSettingsUpdated(s))
      .catch(() => {});
    void startCreate(pending.url, { sourceUrl: pending.url }); // same double-submit guard as the Build button
  }, [affirmPending, api, startCreate]);

  const updateBrief = (value: string): void => {
    setBrief(value);
    if (optimizedOriginalPrompt !== null) setOptimizedOriginalPrompt(null);
  };

  const optimizeCurrentPrompt = async (): Promise<void> => {
    const original = brief.trim();
    if (!original || optimizingPrompt) return;
    if (homeAgentBlockedReason) {
      toast(homeAgentBlockedReason, { variant: "error" });
      return;
    }
    setOptimizingPrompt(true);
    try {
      const result = await api.optimizePrompt({
        prompt: original,
        agentCommand: homeAgent || undefined,
        model: homeModel || undefined,
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

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const remove = (id: string) => setPendingDelete(id);
  const confirmRemove = async () => {
    const id = pendingDelete;
    setPendingDelete(null);
    if (id === null) return;
    try {
      await api.deleteProject(id);
      refresh();
    } catch {
      toast("Couldn't delete the project.", { variant: "error" });
    }
  };
  const pendingDeleteName = projects.find((p) => p.id === pendingDelete)?.name ?? "this project";
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

  return (
    <div className="relative h-full w-full overflow-auto">
      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete "${pendingDeleteName}"?`}
        description="The project, its canvas history, generated versions, and exports are removed from this machine. This can't be undone."
        confirmLabel="Delete project"
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmRemove}
      />
      {/* one restrained top glow — atmosphere, not a marketing mesh */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[36vh]"
        style={{ background: "radial-gradient(60% 100% at 30% 0%, color-mix(in oklch, var(--primary) 12%, transparent), transparent 70%)" }}
      />
      <div className="relative w-full px-7 pb-20 pt-10">
        <div className="mx-auto max-w-5xl">
          {/* Compact tool header — feature toggles ride the far right of the sub-line. */}
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="w-full max-w-2xl">
              <div className="flex items-center gap-2.5">
                {sharingan && (
                  <span
                    aria-hidden
                    className="sharingan-eye h-7 w-7 shrink-0"
                    style={{ WebkitMaskImage: `url(${sharinganEyeUrl})`, maskImage: `url(${sharinganEyeUrl})` }}
                  />
                )}
                <h1
                  className={cn("text-2xl font-semibold tracking-tight transition-colors duration-300", sharingan ? "sharingan-title" : "text-foreground")}
                  title={sharingan ? "Double-click to exit Sharingan" : "Double-click for Sharingan: clone from a URL"}
                  onDoubleClick={toggleSharingan}
                >
                  {sharingan ? "Sharingan" : "Start a design"}
                </h1>
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {sharingan
                  ? "Paste a URL to clone it into an editable project."
                  : "Start empty or describe the system you need. Every reference, page, component, and decision stays visible on one canvas."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 pb-0.5 sm:shrink-0">
              {!sharingan && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={creating}
                  onClick={() => void startBlankCanvas()}
                  className="gap-1.5 rounded-full bg-background/70 px-3 shadow-none backdrop-blur"
                >
                  <Plus size={13} strokeWidth={1.9} />
                  Blank canvas
                </Button>
              )}
            </div>
          </div>

          <div
            aria-label="Design prompt dropzone"
            data-sharingan={sharingan}
            className={cn(
              "mt-5 w-full rounded-2xl border p-2.5 transition-[color,border-color,background-color,box-shadow] duration-150 hover:border-border-strong focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 focus-within:hover:border-ring",
              optimizingPrompt ? "border-border-strong bg-surface-2/80 shadow-inner" : "border-input bg-card/80",
            )}
            onDragEnter={handlePromptDragOver}
            onDragOver={handlePromptDragOver}
            onDrop={handlePromptDrop}
          >
            <div className="rounded-xl">
              <input
                ref={imgInputRef}
                type="file"
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                multiple
                className="hidden"
                onChange={(e) => {
                  void addImages(e.target.files);
                  e.target.value = "";
                }}
              />
              <AgentComposerContextCards
                items={homeDisplayItems}
                onChange={() => {}}
                onRemove={removeHomeDisplayItem}
                sortable={false}
                className="mx-1 mb-2"
              />
              <div className={cn("relative overflow-hidden rounded-xl transition-colors duration-150", optimizingPrompt && "bg-surface-2/80")}>
                {optimizingPrompt ? (
                  <div
                    aria-hidden
                    data-testid="prompt-loading-surface"
                    className="prompt-loading-gradient motion-safe:animate-prompt-loading-gradient pointer-events-none absolute inset-0 rounded-xl opacity-100"
                  />
                ) : null}
                <textarea
                  ref={promptRef}
                  aria-label="Describe your design"
                  value={brief}
                  disabled={optimizingPrompt}
                  onChange={(e) => updateBrief(e.target.value)}
                  placeholder={
                    sharingan
                      ? "Paste a URL to clone…"
                      : images.length
                        ? "Add notes, or just build to recreate the screenshot…"
                        : refs.length
                          ? "Add notes, or just build from the attached context…"
                          : "A pricing page with three plans, the middle one recommended…"
                  }
                  rows={3}
                  className="relative z-10 field-sizing-content max-h-64 min-h-[92px] w-full resize-none bg-transparent px-3 py-2.5 pr-12 text-base leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-wait disabled:opacity-75"
                />
                {brief.trim().length > 0 && !sharingan ? (
                  <TooltipProvider delayDuration={120}>
                    <div className="absolute bottom-2 right-2 z-20 flex items-center gap-1">
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
                                aria-label={optimizingPrompt ? "Optimizing prompt" : "Optimize prompt"}
                                aria-busy={optimizingPrompt}
                                disabled={optimizingPrompt || homeAgentBlockedReason !== null}
                                title={homeAgentBlockedReason ?? undefined}
                              className={cn(
                                "h-7 w-7 rounded-md bg-background/80 shadow-sm backdrop-blur",
                                optimizingPrompt && "bg-transparent text-foreground shadow-none disabled:opacity-100",
                              )}
                              onClick={() => void optimizeCurrentPrompt()}
                            >
                              <Sparkles size={13} strokeWidth={1.8} className={optimizingPrompt ? "motion-safe:animate-pulse" : undefined} />
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
                    onReference={(p) => void referenceProject(p)}
                    allowLocalPaths={false}
                    allowFigImport={false}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Suspense fallback={<div aria-hidden className="h-7 w-28 rounded-md bg-surface-2" />}>
                    <AgentModelSelect
                      agents={agents}
                      agent={homeAgent}
                      model={homeModel}
                      onAgentChange={changeHomeAgent}
                      onModelChange={changeHomeModel}
                      onRescan={rescanAgents}
                    />
                  </Suspense>
                  <Button
                    size="lg"
                    onClick={submit}
                    disabled={creating || optimizingPrompt || pendingAttachmentOperations > 0 || homeAgentBlockedReason !== null || (brief.trim().length === 0 && images.length === 0 && refs.length === 0)}
                    aria-busy={pendingAttachmentOperations > 0 || undefined}
                    aria-label="Design"
                    className="px-6 shadow-[0_8px_24px_-8px_color-mix(in_oklch,var(--primary)_60%,transparent)]"
                  >
                    Design
                    <ArrowRight size={16} strokeWidth={2} />
                  </Button>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* Project gallery */}
        <div className="mt-14">
        <div className="flex flex-wrap items-center gap-2">
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

        {projectsResource.status === "error" ? (
          <div role="alert" className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
            <span>{projectsResource.data ? "Couldn't refresh projects. Showing the last loaded list." : "Couldn't load projects."}</span>
            <Button variant="outline" size="sm" aria-label="Retry loading projects" onClick={refresh}>
              Retry
            </Button>
          </div>
        ) : null}

        {loading ? (
          <Loading label="Loading projects…" />
        ) : projectsResource.status === "error" && projectsResource.data === null ? null : visible.length === 0 ? (
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
                    ? "Projects you archive will show up here. Restore them any time."
                    : "Describe a design in the box above and hit Design to create your first project."}
              </p>
            </div>
          </div>
        ) : layout === "grid" ? (
          <Stagger as="ul" className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visible.map((p) => (
              <StaggerItem as="li" key={p.id}>
                <Card
                  className="group relative gap-0 overflow-hidden p-0 transition-all duration-150 ease-[var(--ease-out)] hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop"
                >
                  <a
                    href={`/projects/${encodeURIComponent(p.id)}`}
                    tabIndex={0}
                    aria-label={`Open ${p.name}`}
                    onClick={(event) => {
                      event.preventDefault();
                      onOpenProject?.(p.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onOpenProject?.(p.id);
                    }}
                    className="block rounded-[inherit] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                  >
                    <ProjectThumb coverUrl={p.coverUrl} />
                    <div className="min-w-0 p-3 pr-20">
                      <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">Design canvas</p>
                    </div>
                  </a>
                  <div className="absolute bottom-2 right-2 z-10 flex shrink-0 gap-0.5 rounded-md bg-card/90 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    {projectActions(p)}
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
                  <div className="group flex items-center hover:bg-surface-2/50">
                    <a
                      href={`/projects/${encodeURIComponent(p.id)}`}
                      tabIndex={0}
                      aria-label={`Open ${p.name}`}
                      onClick={(event) => {
                        event.preventDefault();
                        onOpenProject?.(p.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        onOpenProject?.(p.id);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                    >
                      <div className="h-9 w-12 shrink-0 overflow-hidden rounded-md border border-border bg-surface-2">
                        {p.coverUrl ? (
                          <img src={p.coverUrl} alt="" draggable={false} className="h-full w-full object-cover" />
                        ) : (
                          <div className="dz-canvas grid h-full w-full place-items-center">
                            <ImageIcon size={13} strokeWidth={1.5} className="text-muted-foreground/60" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">Design canvas</p>
                      </div>
                    </a>
                    <div className="relative mr-3 flex min-w-[7rem] shrink-0 justify-end">
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

      <Dialog
        open={canvasReferencePicker !== null}
        onClose={() => setCanvasReferencePicker(null)}
        label="Choose a Node version"
        className="max-w-lg"
      >
        <div className="p-5">
          <h2 className="text-base font-semibold tracking-tight">Choose a Node version</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            Select an exact generated Node from {canvasReferencePicker?.project.name ?? "this project"}.
            Dezin will pin its current immutable version.
          </p>
          <ul aria-label="Node versions" className="mt-4 grid max-h-80 gap-2 overflow-y-auto">
            {canvasReferencePicker?.selections.map((selection) => (
              <li key={`${selection.identity.sourceNodeId}:${selection.identity.sourceVersionId}`}>
                <button
                  type="button"
                  aria-label={`Reference ${selection.nodeName}`}
                  onClick={() => attachCanvasProjectReference(canvasReferencePicker.project, selection)}
                  className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3 py-3 text-left transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted-foreground">
                    {selection.nodeKind === "page"
                      ? <FileText size={16} strokeWidth={1.75} />
                      : <Boxes size={16} strokeWidth={1.75} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{selection.nodeName}</span>
                    <span className="mt-0.5 block text-xs capitalize text-muted-foreground">
                      {selection.nodeKind} · Current immutable version
                    </span>
                  </span>
                  <ArrowRight size={14} className="ml-auto shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Dialog>

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

      <Dialog open={affirmPending !== null} onClose={() => setAffirmPending(null)} label="Authorized use" className="max-w-md">
        <div className="p-5">
          <h2 className="text-base font-semibold tracking-tight">Confirm authorized use</h2>
          <p className="mt-3 text-sm text-muted-foreground">
            Sharingan reproduces a site (its structure, design, and imagery) as a new, editable project, including the source's
            real images and content. Only clone sites you own or are authorized to reproduce.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setAffirmPending(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={confirmAffirmation}>
              I have the right to reproduce this site
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
