import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export function Switch({ checked, onCheckedChange, className, disabled, onClick, ...props }: SwitchProps) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) onCheckedChange?.(!checked);
      }}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-transparent bg-border-strong p-[3px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-45",
        checked ? "bg-foreground" : "bg-border-strong/80 hover:bg-border-strong",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none block size-[18px] rounded-full bg-background shadow-[0_1px_2px_rgba(0,0,0,0.16)] transition-transform",
          checked ? "translate-x-3.5" : "translate-x-0",
        )}
      />
    </button>
  );
}
