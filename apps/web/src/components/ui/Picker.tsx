import type { ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.tsx";
import { cn } from "../../lib/utils.ts";

export interface PickerOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

const EMPTY = "__empty__";

/**
 * A thin, options-array convenience wrapper over the shadcn (Radix) Select — so
 * call sites stay terse and each option can carry an icon/swatch, while the menu
 * itself is portal-positioned and viewport-clamped (never overflows the screen).
 */
export function Picker({
  ariaLabel,
  value,
  options,
  onChange,
  placeholder = "Select",
  className,
  size = "md",
  tone = "surface",
}: {
  ariaLabel: string;
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  size?: "sm" | "md";
  /** "surface" = bordered control; "ghost" = borderless, for inside inputs/toolbars. */
  tone?: "surface" | "ghost";
}) {
  // Radix forbids empty-string item values; map "" ⇄ a sentinel transparently so
  // call sites can keep using value="" for a "Default"/"Auto" option.
  const enc = (v: string) => (v === "" ? EMPTY : v);
  return (
    <Select value={enc(value)} onValueChange={(v) => onChange(v === EMPTY ? "" : v)}>
      <SelectTrigger
        size={size === "sm" ? "sm" : "default"}
        aria-label={ariaLabel}
        className={cn(
          "rounded-lg",
          size === "sm" && "h-7 gap-1.5 px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
          tone === "ghost" ? "border-transparent bg-transparent shadow-none hover:bg-surface-2" : "bg-surface",
          className,
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={enc(o.value)}>
            {o.icon ? (
              <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">{o.icon}</span>
            ) : null}
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
