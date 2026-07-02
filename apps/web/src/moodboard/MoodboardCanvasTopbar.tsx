import { Layers, Maximize2, Minus, Plus, Presentation, Settings } from "lucide-react";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";

export interface MoodboardCanvasTopbarControls {
  zoom: number;
  layersOpen: boolean;
  presentationMode: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFitView: () => void;
  onSetZoom: (zoom: number) => void;
  onToggleLayers: () => void;
  onTogglePresentation: () => void;
}

const ZOOM_PRESETS = [0.5, 1, 2];
const ACTIVE_TOOL_BUTTON_CLASS = "!bg-primary !text-primary-foreground hover:!bg-primary hover:!text-primary-foreground";

export function MoodboardCanvasTopbar({
  loading = false,
  controls = null,
  onOpenModelSettings,
}: {
  loading?: boolean;
  controls?: MoodboardCanvasTopbarControls | null;
  onOpenModelSettings?: () => void;
}) {
  return (
    <div className="app-drag flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-1">
      <div className="min-w-0 flex-1" />
      <TooltipProvider delayDuration={120}>
        <div className="app-no-drag flex items-center gap-0.5">
          {loading ? (
            <>
              <div className="h-8 w-8 rounded-lg bg-surface-2" />
              <div className="h-8 w-12 rounded-lg bg-surface-2" />
              <div className="h-8 w-8 rounded-lg bg-surface-2" />
              <div className="h-8 w-8 rounded-lg bg-surface-2" />
              <div className="h-8 w-8 rounded-lg bg-surface-2" />
              <div className="mx-1 h-5 w-px bg-border" />
              <div className="h-8 w-8 rounded-lg bg-surface-2" />
            </>
          ) : (
            <>
              <TopbarIcon label="Zoom out" disabled={!controls} onClick={() => controls?.onZoomOut()}>
                <Minus size={15} strokeWidth={1.75} />
              </TopbarIcon>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={!controls}
                  aria-label="Canvas zoom options"
                  className="h-8 min-w-12 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
                >
                  {controls ? `${Math.round(controls.zoom * 100)}%` : "100%"}
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end" className="w-36">
                  <DropdownMenuItem onClick={controls?.onFitView}>
                    <Maximize2 size={13} strokeWidth={1.75} />
                    Fit view
                  </DropdownMenuItem>
                  {ZOOM_PRESETS.map((preset) => (
                    <DropdownMenuItem key={preset} onClick={() => controls?.onSetZoom(preset)}>
                      {Math.round(preset * 100)}%
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <TopbarIcon label="Zoom in" disabled={!controls} onClick={() => controls?.onZoomIn()}>
                <Plus size={15} strokeWidth={1.75} />
              </TopbarIcon>
              <span className="mx-1 h-5 w-px bg-border" />
              <TopbarIcon label="Layers" active={controls?.layersOpen} disabled={!controls} onClick={() => controls?.onToggleLayers()}>
                <Layers size={15} strokeWidth={1.75} />
              </TopbarIcon>
              <TopbarIcon label="Presentation mode" active={controls?.presentationMode} disabled={!controls} onClick={() => controls?.onTogglePresentation()}>
                <Presentation size={15} strokeWidth={1.75} />
              </TopbarIcon>
              <span className="mx-1 h-5 w-px bg-border" />
              <TopbarIcon label="Open model settings" onClick={onOpenModelSettings}>
                <Settings size={15} strokeWidth={1.75} />
              </TopbarIcon>
            </>
          )}
        </div>
      </TooltipProvider>
    </div>
  );
}

function TopbarIcon({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton
          aria-label={label}
          aria-pressed={active}
          aria-disabled={disabled}
          onClick={disabled ? undefined : onClick}
          className={cn(active && ACTIVE_TOOL_BUTTON_CLASS, disabled && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground")}
        >
          {children}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent sideOffset={2}>{label}</TooltipContent>
    </Tooltip>
  );
}
