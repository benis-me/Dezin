import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import { IconButton, Kbd } from "./IconButton.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

export function StudioToolButton({
  label,
  active,
  disabled = false,
  disabledReason,
  shortcut,
  tone = "primary",
  className,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  shortcut?: string;
  tone?: "primary" | "quiet";
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const unavailable = disabled && Boolean(disabledReason);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex"
          tabIndex={unavailable ? 0 : undefined}
          role={unavailable ? "button" : undefined}
          aria-disabled={disabled || undefined}
          aria-label={unavailable ? disabledReason : undefined}
        >
          <IconButton
            aria-label={unavailable ? undefined : label}
            aria-pressed={active}
            aria-hidden={unavailable || undefined}
            tabIndex={unavailable ? -1 : undefined}
            data-active={active || undefined}
            disabled={disabled}
            onClick={disabled ? undefined : onClick}
            className={cn(
              className,
              active && (tone === "primary"
                ? "!bg-primary !text-primary-foreground hover:!bg-primary hover:!text-primary-foreground"
                : "bg-surface-2 text-foreground hover:bg-surface-2 hover:text-foreground"),
              disabled && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground",
            )}
          >
            {children}
          </IconButton>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={2} className={shortcut ? "flex items-center gap-2" : undefined}>
        <span>{disabledReason ?? label.replace(/ tool$/, "")}</span>
        {!disabled && shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}
