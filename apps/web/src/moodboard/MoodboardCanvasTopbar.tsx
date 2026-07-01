import { Settings } from "lucide-react";
import { IconButton, Tabs, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/index.ts";

const MOODBOARD_CANVAS_TAB_ITEMS = [{ value: "Canvas", label: "Canvas" }];

export function MoodboardCanvasTopbar({
  loading = false,
  nodeCount = 0,
  selectedCount = 0,
  onOpenModelSettings,
}: {
  loading?: boolean;
  nodeCount?: number;
  selectedCount?: number;
  onOpenModelSettings?: () => void;
}) {
  return (
    <div className="app-drag flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-1">
      {loading ? (
        <div className="flex items-center gap-1.5 px-1.5">
          <div className="h-7 w-20 rounded-md bg-surface-2" />
          <div className="h-5 w-24 rounded bg-surface-2/70" />
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          <Tabs
            aria-label="Moodboard views"
            className="[&_[role=tab]]:px-2.5"
            items={MOODBOARD_CANVAS_TAB_ITEMS}
            value="Canvas"
            onChange={() => {}}
            variant="plain"
          />
          <span className="app-no-drag truncate px-1 text-[11px] text-muted-foreground">
            {nodeCount === 1 ? "1 item" : `${nodeCount} items`}
            {selectedCount > 0 ? ` · ${selectedCount} selected` : ""}
          </span>
        </div>
      )}
      <TooltipProvider delayDuration={120}>
        <div className="app-no-drag flex items-center gap-1">
          {loading ? (
            <div className="h-8 w-8 rounded-lg bg-surface-2" />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton aria-label="Open model settings" onClick={onOpenModelSettings}>
                  <Settings size={15} strokeWidth={1.75} />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent sideOffset={2}>Model settings</TooltipContent>
            </Tooltip>
          )}
        </div>
      </TooltipProvider>
    </div>
  );
}
