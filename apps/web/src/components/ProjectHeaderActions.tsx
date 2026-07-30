import {
  Download,
  MoreHorizontal,
  PanelRightOpen,
  Settings,
} from "lucide-react";
import { useState, type ReactNode, type Ref } from "react";

import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/index.ts";
import type { ApiClient, Project } from "../lib/api.ts";
import { native } from "../lib/native.ts";

function HeaderTooltip({
  label,
  children,
  sideOffset = 6,
}: {
  label: string;
  children: ReactNode;
  sideOffset?: number;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={sideOffset}>{label}</TooltipContent>
    </Tooltip>
  );
}

function ProjectHeaderMenu({
  label,
  icon,
  contentClassName,
  sideOffset,
  children,
}: {
  label: string;
  icon: ReactNode;
  contentClassName: string;
  sideOffset?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <HeaderTooltip label={label} sideOffset={sideOffset}>
        <DropdownMenuTrigger asChild>
          <IconButton aria-label={label} onClick={() => setOpen(true)}>
            {icon}
          </IconButton>
        </DropdownMenuTrigger>
      </HeaderTooltip>
      <DropdownMenuContent align="end" className={contentClassName}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ProjectActionApi = Pick<ApiClient, "patchProject" | "deleteProject">;
type ProjectActionToast = (message: string, options?: { variant?: "error" | "info" }) => void;

export function useProjectHeaderActions({
  api,
  projectId,
  projectName,
  projectPath,
  analysisPrompt,
  enabled = true,
  onRenamed,
  onDeleted,
  toast,
}: {
  api: ProjectActionApi;
  projectId: string;
  projectName: string;
  projectPath?: string;
  analysisPrompt?: string | null;
  enabled?: boolean;
  onRenamed: (project: Project) => void;
  onDeleted: () => void;
  toast: ProjectActionToast;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const closeRename = (): void => {
    if (!renameSaving) setRenameOpen(false);
  };
  const startRename = (): void => {
    if (!enabled) return;
    setRenameDraft(projectName);
    setRenameOpen(true);
  };
  const commitRename = async (): Promise<void> => {
    const name = renameDraft.trim();
    if (!enabled || !name || renameSaving) return;
    setRenameSaving(true);
    try {
      const project = await api.patchProject(projectId, { name });
      setRenameOpen(false);
      setRenameDraft("");
      onRenamed(project);
    } catch {
      toast("Couldn't rename the project.", { variant: "error" });
    } finally {
      setRenameSaving(false);
    }
  };
  const openInFinder = async (): Promise<void> => {
    if (!projectPath || !native?.openPath) {
      toast("Finder is available in the desktop app.", { variant: "error" });
      return;
    }
    if (!await native.openPath(projectPath)) {
      toast("Couldn't open the project folder.", { variant: "error" });
    }
  };
  const copyAnalysisPrompt = async (): Promise<void> => {
    if (!analysisPrompt) return;
    try {
      await navigator.clipboard.writeText(analysisPrompt);
      toast("Copied analysis prompt.");
    } catch {
      toast("Couldn't copy the analysis prompt.", { variant: "error" });
    }
  };
  const deleteProject = async (): Promise<void> => {
    if (!enabled || !window.confirm("Delete this project permanently? This can't be undone.")) return;
    try {
      await api.deleteProject(projectId);
      onDeleted();
    } catch {
      toast("Couldn't delete the project.", { variant: "error" });
    }
  };
  return {
    renameOpen,
    renameDraft,
    renameSaving,
    setRenameDraft,
    closeRename,
    startRename,
    commitRename,
    openInFinder,
    copyAnalysisPrompt,
    deleteProject,
    canOpenInFinder: Boolean(enabled && projectPath && native?.openPath),
  };
}

export type ProjectHeaderActionsController = ReturnType<typeof useProjectHeaderActions>;

export function ProjectRenameDialog({ controller }: { controller: ProjectHeaderActionsController }) {
  if (!controller.renameOpen) return null;
  return (
    <Dialog
      open
      onClose={controller.closeRename}
      label="Rename project"
      className="sm:max-w-md"
      showClose
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void controller.commitRename();
        }}
      >
        <Input
          aria-label="Project name"
          autoFocus
          value={controller.renameDraft}
          disabled={controller.renameSaving}
          onChange={(event) => controller.setRenameDraft(event.target.value)}
        />
        <div>
          <Button
            type="button"
            variant="ghost"
            disabled={controller.renameSaving}
            onClick={controller.closeRename}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!controller.renameDraft.trim() || controller.renameSaving}>
            {controller.renameSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export type ProjectActionsMenuProps = {
  canOpenInFinder: boolean;
  onRename: () => void;
  onOpenInFinder: () => void;
  onDelete: () => void;
  onCopyAnalysisPrompt: () => void;
};

export function ProjectActionsMenu({
  canOpenInFinder,
  onRename,
  onOpenInFinder,
  onDelete,
  onCopyAnalysisPrompt,
}: ProjectActionsMenuProps) {
  return (
    <ProjectHeaderMenu
      label="Project actions"
      icon={<MoreHorizontal aria-hidden size={15} strokeWidth={1.75} />}
      contentClassName="w-56"
      sideOffset={2}
    >
      <DropdownMenuItem onClick={onRename}>
        Rename project
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!canOpenInFinder} onClick={canOpenInFinder ? onOpenInFinder : undefined}>
        Open in Finder
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        Delete project
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onCopyAnalysisPrompt}>
        Copy Analysis Prompt
      </DropdownMenuItem>
    </ProjectHeaderMenu>
  );
}

export function ProjectPanelToggleButton({
  open,
  onToggle,
  controls,
  label = "build plan",
  buttonRef,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  label?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const action = open ? `Hide ${label}` : `Show ${label}`;
  return (
    <HeaderTooltip label={action}>
      <IconButton
        ref={buttonRef}
        aria-label={action}
        aria-controls={controls}
        aria-expanded={open}
        aria-pressed={open}
        onClick={onToggle}
      >
        <PanelRightOpen aria-hidden size={15} strokeWidth={1.75} />
      </IconButton>
    </HeaderTooltip>
  );
}

export function ProjectExportMenu({
  sourceUrl,
  fullUrl,
}: {
  sourceUrl: string;
  fullUrl: string;
}) {
  return (
    <ProjectHeaderMenu
      label="Export project"
      icon={<Download aria-hidden size={15} strokeWidth={1.75} />}
      contentClassName="w-48"
    >
      <DropdownMenuItem asChild>
        <a href={sourceUrl} download>Source ZIP</a>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <a href={fullUrl} download>Full project ZIP</a>
      </DropdownMenuItem>
    </ProjectHeaderMenu>
  );
}

export function ProjectSettingsButton({
  onOpen,
}: {
  onOpen: () => void;
}) {
  return (
    <HeaderTooltip label="Settings">
      <IconButton aria-label="Settings" onClick={onOpen}>
        <Settings aria-hidden size={15} strokeWidth={1.75} />
      </IconButton>
    </HeaderTooltip>
  );
}
