import { useId, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils.ts";

export interface TabItem {
  value: string;
  label: ReactNode;
}

/**
 * A click-driven segmented tab strip, styled to match shadcn's TabsList/Trigger.
 * (Radix Tabs activates on mousedown, which doesn't play well with click-based
 * tests; this keeps the same look with simple semantics.)
 */
export function Tabs({
  items,
  value,
  onChange,
  className = "",
  variant = "default",
  "aria-label": ariaLabel,
}: {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  variant?: "default" | "plain";
  "aria-label"?: string;
}) {
  const layoutId = useId();
  const plain = variant === "plain";
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        plain
          ? "inline-flex h-8 w-fit items-center justify-center gap-0.5 rounded-lg p-0 text-muted-foreground"
          : "inline-flex h-8 w-fit items-center justify-center gap-0.5 rounded-lg border border-border bg-surface-2/60 p-0.5 text-muted-foreground",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              "relative inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5",
              plain ? "px-2" : "px-2.5",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active ? (
              <motion.span
                layoutId={layoutId}
                aria-hidden
                className={cn("absolute inset-0 rounded-md", plain ? "bg-surface-2" : "bg-card ring-1 ring-border")}
                transition={{ type: "spring", stiffness: 520, damping: 42 }}
              />
            ) : null}
            <span className="relative z-10 inline-flex items-center gap-1.5">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
