import { useEffect, useRef, useState } from "react";
import { FileUp, FolderGit2, FolderPlus, Images, Layers, Paperclip, Plus, Sparkles } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/index.ts";
import { useToast } from "./Toast.tsx";
import { useApi } from "../lib/api-context.tsx";
import { native } from "../lib/native.ts";
import type { EffectCard, Moodboard, Project } from "../lib/api.ts";

/**
 * The "+" add menu on a composer — Files / Code / Designs. In Electron, file/folder
 * items open native dialogs and hand back local paths (the local agent reads them); in
 * a plain browser, "Attach file" uses the file input. "Upload .fig" parses a Figma file
 * into a design brief that gets inserted as context.
 */
export function AttachMenu({
  fileActionLabel = "Attach file",
  onAttachFile,
  onPickPaths,
  onContext,
  onReference,
  onReferenceMoodboard,
  onReferenceEffect,
  workspaceReferences = [],
  onReferenceWorkspaceItem,
  allowLocalPaths = true,
  allowProjectReference = true,
  allowFigImport = true,
}: {
  fileActionLabel?: string;
  onAttachFile?: () => void;
  onPickPaths?: (paths: string[]) => void;
  onContext?: (text: string) => void;
  onReference?: (project: Project) => void;
  onReferenceMoodboard?: (board: Moodboard) => void;
  onReferenceEffect?: (effect: EffectCard) => void;
  workspaceReferences?: Array<{ id: string; label: string; detail?: string }>;
  onReferenceWorkspaceItem?: (id: string) => void;
  allowLocalPaths?: boolean;
  allowProjectReference?: boolean;
  allowFigImport?: boolean;
}) {
  const { toast } = useToast();
  const api = useApi();
  const figInputRef = useRef<HTMLInputElement>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [moodboards, setMoodboards] = useState<Moodboard[]>([]);
  const [effects, setEffects] = useState<EffectCard[]>([]);
  const loadProjectReferences = allowProjectReference && onReference !== undefined;
  useEffect(() => {
    if (!loadProjectReferences) return;
    let alive = true;
    void Promise.resolve()
      .then(() => api.listProjects())
      .then((p) => alive && setProjects(p.filter((x) => !x.archivedAt)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, loadProjectReferences]);
  useEffect(() => {
    let alive = true;
    void api
      .listMoodboards()
      .then((boards) => alive && setMoodboards(boards.filter((board) => !board.archivedAt)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);
  useEffect(() => {
    if (!onReferenceEffect) return;
    let alive = true;
    void api
      .listEffects()
      .then((items) => alive && setEffects(items))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, onReferenceEffect]);
  const pick = async (kind: "files" | "folder", label: string): Promise<void> => {
    if (!native) {
      if (kind === "files" && onAttachFile) onAttachFile();
      else toast(`${label} is available in the desktop app.`);
      return;
    }
    const paths = kind === "files" ? await native.pickFiles() : await native.pickFolder();
    if (paths.length) onPickPaths?.(paths);
  };
  const onFigChosen = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    toast(`Reading ${file.name}…`);
    try {
      const { summary } = await api.parseFig(file, file.name);
      if (summary.trim()) {
        onContext?.(summary);
        toast(`Imported ${file.name}.`);
      } else {
        toast("Couldn't extract a design from that .fig.", { variant: "error" });
      }
    } catch (error) {
      const message = error instanceof Error && error.message.trim() ? error.message : `Couldn't read ${file.name}.`;
      toast(message, { variant: "error" });
    }
  };
  return (
    <DropdownMenu>
      <input ref={figInputRef} type="file" accept=".fig" className="hidden" onChange={(e) => void onFigChosen(e)} />
      <DropdownMenuTrigger
        aria-label="Add files and context"
        title="Add files and context"
        className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-surface-2 data-[state=open]:text-foreground"
      >
        <Plus size={16} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Files</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => void pick("files", fileActionLabel)}>
          <Paperclip size={15} strokeWidth={1.75} />
          {fileActionLabel}
        </DropdownMenuItem>
        {allowLocalPaths ? (
          <DropdownMenuItem onClick={() => void pick("folder", "Attach folder")}>
            <FolderPlus size={15} strokeWidth={1.75} />
            Attach folder
          </DropdownMenuItem>
        ) : null}
        {allowProjectReference ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="whitespace-nowrap">
              <Layers size={15} strokeWidth={1.75} />
              Reference a project
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
              {projects.length === 0 ? (
                <DropdownMenuItem disabled>No other projects</DropdownMenuItem>
              ) : (
                projects.map((p) => (
                  <DropdownMenuItem key={p.id} onClick={() => onReference?.(p)}>
                    <span className="truncate">{p.name}</span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {allowLocalPaths ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Code</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => void pick("folder", "Link local code")}>
              <FolderGit2 size={15} strokeWidth={1.75} />
              Link local code…
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Designs</DropdownMenuLabel>
        {onReferenceWorkspaceItem ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="whitespace-nowrap">
              <Layers size={15} strokeWidth={1.75} />
              Reference a workspace item
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-64 overflow-y-auto">
              {workspaceReferences.length === 0 ? (
                <DropdownMenuItem disabled>No versioned workspace items</DropdownMenuItem>
              ) : workspaceReferences.map((item) => (
                <DropdownMenuItem key={item.id} onClick={() => onReferenceWorkspaceItem(item.id)}>
                  <span className="min-w-0">
                    <span className="block truncate">{item.label}</span>
                    {item.detail ? <span className="block truncate text-[10px] text-muted-foreground">{item.detail}</span> : null}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {onReferenceMoodboard ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="whitespace-nowrap">
              <Images size={15} strokeWidth={1.75} />
              Reference a moodboard
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
              {moodboards.length === 0 ? (
                <DropdownMenuItem disabled>No moodboards</DropdownMenuItem>
              ) : (
                moodboards.map((board) => (
                  <DropdownMenuItem key={board.id} onClick={() => onReferenceMoodboard(board)}>
                    <span className="truncate">{board.name}</span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {onReferenceEffect ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="whitespace-nowrap">
              <Sparkles size={15} strokeWidth={1.75} />
              Reference an effect
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
              {effects.length === 0 ? (
                <DropdownMenuItem disabled>No effects</DropdownMenuItem>
              ) : (
                effects.map((effect) => (
                  <DropdownMenuItem key={effect.id} onClick={() => onReferenceEffect(effect)}>
                    <span className="truncate">{effect.name}</span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {allowFigImport ? (
          <DropdownMenuItem onClick={() => figInputRef.current?.click()}>
            <FileUp size={15} strokeWidth={1.75} />
            Upload .fig file
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
