import { useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "../../lib/utils.ts";

type StudioInspectorSectionProps = Omit<ComponentProps<"section">, "title"> & {
  heading?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  headingId?: string;
  contentClassName?: string;
};

export function StudioInspectorSection({
  heading,
  description,
  icon,
  actions,
  headingId,
  contentClassName,
  className,
  children,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: StudioInspectorSectionProps) {
  const generatedHeadingId = useId();
  const resolvedHeadingId = headingId ?? generatedHeadingId;
  return (
    <section
      className={cn("border-b border-border px-3.5 py-3.5 last:border-b-0", className)}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy ?? (
        ariaLabel === undefined && heading !== undefined ? resolvedHeadingId : undefined
      )}
      {...props}
    >
      {heading === undefined ? null : (
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            {icon === undefined ? null : (
              <span className="mt-px flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              <h3
                id={resolvedHeadingId}
                className="m-0 text-[13px] font-medium leading-[1.3] tracking-[-0.01em] text-foreground"
              >
                {heading}
              </h3>
              {description === undefined ? null : (
                <p className="mt-0.5 text-xs leading-[1.45] text-muted-foreground">
                  {description}
                </p>
              )}
            </div>
          </div>
          {actions === undefined ? null : (
            <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
          )}
        </div>
      )}
      <div className={cn(heading === undefined ? undefined : "mt-3", contentClassName)}>
        {children}
      </div>
    </section>
  );
}

type StudioFactRowProps = Omit<ComponentProps<"div">, "children"> & {
  label: ReactNode;
  value: ReactNode;
  metadata?: boolean;
  mono?: boolean;
  stacked?: boolean;
  valueClassName?: string;
};

export function StudioFactRow({
  label,
  value,
  metadata = false,
  mono = false,
  stacked = false,
  className,
  valueClassName,
  ...props
}: StudioFactRowProps) {
  return (
    <div
      className={cn(
        "min-w-0 gap-2 py-2 first:pt-0 last:pb-0",
        stacked
          ? "grid"
          : "grid grid-cols-[104px_minmax(0,1fr)] items-baseline",
        className,
      )}
      {...props}
    >
      <dt className="min-w-0 text-xs leading-[1.4] text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "m-0 min-w-0 break-words text-[13px] leading-[1.45] text-foreground",
          metadata && "text-xs leading-[1.45] text-foreground-2",
          mono && "font-mono",
          valueClassName,
        )}
      >
        {value}
      </dd>
    </div>
  );
}

type StudioStatusBadgeProps = ComponentProps<"span"> & {
  tone?: "neutral" | "active" | "success" | "danger";
  dot?: boolean;
};

const STATUS_TONE_CLASSES: Record<NonNullable<StudioStatusBadgeProps["tone"]>, string> = {
  neutral: "border-border bg-background text-muted-foreground",
  active: "border-foreground/20 bg-surface-2 text-foreground",
  success: "border-success/25 bg-success/10 text-success",
  danger: "border-destructive/25 bg-destructive/10 text-destructive",
};

export function StudioStatusBadge({
  tone = "neutral",
  dot = false,
  className,
  children,
  ...props
}: StudioStatusBadgeProps) {
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex min-h-5 w-fit shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium leading-none whitespace-nowrap",
        STATUS_TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
