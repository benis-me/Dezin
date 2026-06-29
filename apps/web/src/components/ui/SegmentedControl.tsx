import { useId, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "../../lib/utils.ts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.tsx";

export interface SegmentedOption<T extends string> {
  value: T;
  label?: ReactNode;
  icon?: ReactNode;
  /** Tooltip + accessible name (use for icon-only segments). */
  title?: string;
}

/**
 * A canonical segmented control — the one pattern for "pick one of a few" inline
 * toggles (build mode, device presets, …). Matches the picker height/border so it
 * sits flush beside Picker/Select controls.
 */
export function Segmented<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  size = "md",
  className,
}: {
  ariaLabel: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  const layoutId = useId();
  return (
    <TooltipProvider delayDuration={120}>
      <div
        role="group"
        aria-label={ariaLabel}
        className={cn(
          "inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-2/60 p-0.5",
          size === "xs" ? "h-7" : size === "sm" ? "h-8" : "h-9",
          className,
        )}
      >
        {options.map((o) => {
          const active = o.value === value;
          const button = (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              aria-label={o.title}
              onClick={() => onChange(o.value)}
              className={cn(
                "relative flex h-full items-center gap-1.5 rounded-md text-xs font-medium transition-colors",
                size === "xs" ? "px-1.5" : "px-2",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {active ? (
                <motion.span
                  layoutId={layoutId}
                  aria-hidden
                  className="absolute inset-0 rounded-md bg-card ring-1 ring-border"
                  transition={{ type: "spring", stiffness: 520, damping: 42 }}
                />
              ) : null}
              <span className="relative z-10 inline-flex items-center gap-1.5">
                {o.icon}
                {o.label}
              </span>
            </button>
          );
          if (!o.title) return button;
          return (
            <Tooltip key={o.value}>
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent sideOffset={2}>{o.title}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
