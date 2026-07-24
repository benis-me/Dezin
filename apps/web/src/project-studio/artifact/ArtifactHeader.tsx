import {
  ArrowLeft,
  Ellipsis,
  Focus,
  History,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  ScanSearch,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/index.ts";
import type { WorkspaceArtifact, WorkspaceRenderFrameSpec } from "../../lib/api.ts";

function HeaderTool({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton className="artifact-tool app-no-drag" aria-label={label} onClick={onClick}>
          {children}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent className="z-[90]">
        {label === "Back to workspace canvas" ? "Back to workspace" : label}
      </TooltipContent>
    </Tooltip>
  );
}

export function ArtifactHeader({
  artifact,
  artifactId,
  revisionSequence,
  frames,
  activeFrameId,
  zoom,
  readOnly,
  presentation,
  previewReady,
  onBack,
  onFrameChange,
  onZoomChange,
  onFitPreview,
  onTogglePresentation,
  pinnedRevisionId,
  onOpenVersions,
  onOpenCompare,
  onReturnToHead,
}: {
  artifact: WorkspaceArtifact | null;
  artifactId: string | null;
  revisionSequence: number | null;
  frames: WorkspaceRenderFrameSpec[];
  activeFrameId: string;
  zoom: number;
  readOnly: boolean;
  presentation: boolean;
  previewReady: boolean;
  onBack: () => void;
  onFrameChange: (frameId: string) => void;
  onZoomChange: (zoom: number) => void;
  onFitPreview: () => void;
  onTogglePresentation: () => void;
  pinnedRevisionId: string | null;
  onOpenVersions: () => void;
  onOpenCompare: () => void;
  onReturnToHead: () => void;
}) {
  const name = artifact?.name ?? "Artifact unavailable";
  return (
    <TooltipProvider delayDuration={120}>
      <header className="artifact-header app-drag">
        <div className="artifact-header__identity">
          <HeaderTool label="Back to workspace canvas" onClick={onBack}>
            <ArrowLeft aria-hidden size={15} strokeWidth={1.8} />
          </HeaderTool>
          <span className="artifact-header__rule" aria-hidden />
          <div className="artifact-header__title">
            <h1>{name}</h1>
            <div className="artifact-header__metadata">
              <span>{artifact?.kind === "component" ? "Component master" : "Page design"}</span>
              <span aria-hidden>·</span>
              {artifactId ? <span title={artifactId}>{artifactId.length > 18 ? artifactId.slice(0, 8) : artifactId}</span> : null}
              {artifactId ? <span aria-hidden>·</span> : null}
              <span>{revisionSequence === null ? "No revision" : `Revision ${revisionSequence}`}</span>
              {pinnedRevisionId ? <strong>Pinned Revision · read-only</strong> : readOnly ? <strong>Read-only preview</strong> : <strong>Current Head</strong>}
            </div>
          </div>
        </div>

        <div className="artifact-header__controls app-no-drag">
          <Select value={activeFrameId} onValueChange={onFrameChange}>
            <SelectTrigger
              size="sm"
              className="artifact-frame-select"
              aria-label="Preview frame"
              data-frame-id={activeFrameId}
            >
              <SelectValue placeholder="Frame" />
            </SelectTrigger>
            <SelectContent align="end" className="z-[90]">
              {frames.map((frame) => <SelectItem key={frame.id} value={frame.id}>{frame.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div
            className="artifact-tool-group artifact-tool-group--desktop"
            aria-label="Preview zoom controls"
            role="group"
          >
            <HeaderTool label="Zoom out" onClick={() => onZoomChange(Math.max(0.25, zoom - 0.1))}>
              <Minus aria-hidden size={14} />
            </HeaderTool>
            <output aria-label="Preview zoom">{Math.round(zoom * 100)}%</output>
            <HeaderTool label="Zoom in" onClick={() => onZoomChange(Math.min(1.5, zoom + 0.1))}>
              <Plus aria-hidden size={14} />
            </HeaderTool>
            <HeaderTool label="Fit preview" onClick={onFitPreview}>
              <Focus aria-hidden size={14} strokeWidth={1.7} />
            </HeaderTool>
          </div>
          {pinnedRevisionId ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="artifact-action artifact-action--return"
                  aria-label="Return to Head"
                  onClick={onReturnToHead}
                >
                  <ArrowLeft aria-hidden size={14} />
                  <span className="artifact-action__label">Return to Head</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="z-[90]">Return to Head</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="artifact-action artifact-action--secondary"
                aria-label="Versions"
                disabled={presentation || !artifactId}
                onClick={onOpenVersions}
              >
                <History aria-hidden size={14} />
                <span className="artifact-action__label">Versions</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent className="z-[90]">Versions</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="artifact-action artifact-action--secondary"
                aria-label="Compare"
                disabled={presentation || !artifactId}
                onClick={onOpenCompare}
              >
                <ScanSearch aria-hidden size={14} />
                <span className="artifact-action__label">Compare</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent className="z-[90]">Compare</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                className="artifact-tool artifact-more app-no-drag"
                aria-label="More artifact controls"
              >
                <Ellipsis aria-hidden size={15} strokeWidth={1.8} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="artifact-more__content z-[90]">
              <DropdownMenuLabel className="artifact-more__label">
                Preview
                <span>{Math.round(zoom * 100)}%</span>
              </DropdownMenuLabel>
              <DropdownMenuItem
                className="artifact-more__item"
                aria-label="Zoom out"
                onSelect={() => onZoomChange(Math.max(0.25, zoom - 0.1))}
              >
                <Minus aria-hidden />
                Zoom out
              </DropdownMenuItem>
              <DropdownMenuItem
                className="artifact-more__item"
                aria-label="Zoom in"
                onSelect={() => onZoomChange(Math.min(1.5, zoom + 0.1))}
              >
                <Plus aria-hidden />
                Zoom in
              </DropdownMenuItem>
              <DropdownMenuItem
                className="artifact-more__item"
                aria-label="Fit preview"
                onSelect={onFitPreview}
              >
                <Focus aria-hidden />
                Fit preview
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="artifact-more__item"
                aria-label="Versions"
                disabled={presentation || !artifactId}
                onSelect={onOpenVersions}
              >
                <History aria-hidden />
                Versions
              </DropdownMenuItem>
              <DropdownMenuItem
                className="artifact-more__item"
                aria-label="Compare"
                disabled={presentation || !artifactId}
                onSelect={onOpenCompare}
              >
                <ScanSearch aria-hidden />
                Compare
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant={presentation ? "outline" : "default"}
                className="artifact-action artifact-action--primary"
                aria-label={presentation ? "Exit present" : "Present"}
                aria-pressed={presentation}
                disabled={!presentation && !previewReady}
                onClick={onTogglePresentation}
              >
                {presentation ? <Minimize2 aria-hidden size={14} /> : <Maximize2 aria-hidden size={14} />}
                <span className="artifact-action__label">{presentation ? "Exit present" : "Present"}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent className="z-[90]">{presentation ? "Exit present" : "Present"}</TooltipContent>
          </Tooltip>
        </div>
      </header>
    </TooltipProvider>
  );
}
