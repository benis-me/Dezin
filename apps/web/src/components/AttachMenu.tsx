import { useEffect, useRef, useState } from "react";
import { FileUp, FolderGit2, FolderPlus, Layers, Paperclip, Plus } from "lucide-react";
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
import type { Project } from "../lib/api.ts";

/**
 * The "+" add menu on a composer — Files / Code / Designs. In Electron, file/folder
 * items open native dialogs and hand back local paths (the local agent reads them); in
 * a plain browser, "Attach file" uses the file input. "Upload .fig" parses a Figma file
 * into a design brief that gets inserted as context.
 */
export function AttachMenu({
  onAttachFile,
  onPickPaths,
  onContext,
  onReference,
}: {
  onAttachFile?: () => void;
  onPickPaths?: (paths: string[]) => void;
  onContext?: (text: string) => void;
  onReference?: (project: Project) => void;
}) {
  const { toast } = useToast();
  const api = useApi();
  const figInputRef = useRef<HTMLInputElement>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    let alive = true;
    void api.listProjects().then((p) => alive && setProjects(p.filter((x) => !x.archivedAt))).catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);
  const soon = (what: string) => toast(`${what} isn't available yet.`);
  const pick = async (kind: "files" | "folder", label: string): Promise<void> => {
    if (!native) return onAttachFile ? onAttachFile() : soon(label);
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
    } catch {
      toast(`Couldn't read ${file.name}.`, { variant: "error" });
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
        <DropdownMenuItem onClick={() => void pick("files", "Attach file")}>
          <Paperclip size={15} strokeWidth={1.75} />
          Attach file
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void pick("folder", "Attach folder")}>
          <FolderPlus size={15} strokeWidth={1.75} />
          Attach folder
        </DropdownMenuItem>
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
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Code</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => void pick("folder", "Link local code")}>
          <FolderGit2 size={15} strokeWidth={1.75} />
          Link local code…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Designs</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => figInputRef.current?.click()}>
          <FileUp size={15} strokeWidth={1.75} />
          Upload .fig file
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
