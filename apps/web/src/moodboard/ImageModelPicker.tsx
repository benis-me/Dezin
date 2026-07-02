import { useState } from "react";
import { Check, ChevronDown, WandSparkles } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";

export function ImageModelPicker({
  model,
  options,
  disabled = false,
  onModelChange,
}: {
  model: string;
  options: string[];
  disabled?: boolean;
  onModelChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = model || options[0] || "";
  return (
    <Popover open={disabled ? false : open} onOpenChange={(next) => !disabled && setOpen(next)} modal={false}>
      <PopoverTrigger
        aria-label="Image generation model"
        disabled={disabled}
        className="flex h-7 min-w-0 max-w-[21rem] items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-surface-2 data-[state=open]:text-foreground"
      >
        <WandSparkles size={13} strokeWidth={1.75} className="shrink-0 text-primary" />
        <span className="shrink-0 font-medium text-foreground">Image</span>
        {selected ? <span className="min-w-0 truncate text-muted-foreground">· {selected}</span> : null}
        <ChevronDown size={13} strokeWidth={2} className="shrink-0" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-2">
        <p className="label-mono px-0.5 pb-1.5">Image model</p>
        {options.length ? (
          <div className="flex max-h-44 flex-wrap gap-1 overflow-y-auto pr-0.5">
            {options.map((option) => {
              const active = option === selected;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    onModelChange(option);
                    setOpen(false);
                  }}
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                    active ? "border-ring bg-surface text-foreground ring-1 ring-inset ring-ring/30" : "border-border text-muted-foreground hover:bg-surface-2/60 hover:text-foreground",
                  )}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {option}
                    {active ? <Check size={12} strokeWidth={2.5} className="text-foreground" /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">No image models configured.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
