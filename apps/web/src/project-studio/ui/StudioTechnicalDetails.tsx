import { ChevronRight, Copy } from "lucide-react";
import { type ComponentProps, type ReactNode } from "react";

import { Button } from "../../components/ui/Button.tsx";
import { cn } from "../../lib/utils.ts";

type StudioTechnicalDetailsProps = Omit<ComponentProps<"details">, "children"> & {
  label?: ReactNode;
  copyText?: string;
  copyLabel?: string;
  contentClassName?: string;
  children: ReactNode;
};

export function StudioTechnicalDetails({
  label = "Technical details",
  copyText,
  copyLabel = "Copy technical details",
  contentClassName,
  className,
  children,
  ...props
}: StudioTechnicalDetailsProps) {
  return (
    <details
      className={cn("group border-t border-border pt-2", className)}
      {...props}
    >
      <summary
        className={cn(
          "flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-sm",
          "text-xs font-medium text-muted-foreground outline-none transition-colors",
          "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90"
        />
        <span>{label}</span>
      </summary>
      <div className={cn("min-w-0 pb-0.5 pl-[18px] pt-1", contentClassName)}>
        {children}
        {copyText === undefined ? null : (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="mt-1.5"
            onClick={() => {
              void navigator.clipboard?.writeText(copyText).catch(() => {});
            }}
            aria-label={copyLabel}
          >
            <Copy aria-hidden size={12} />
            Copy
          </Button>
        )}
      </div>
    </details>
  );
}
