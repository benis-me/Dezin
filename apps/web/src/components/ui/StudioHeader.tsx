import type { ComponentProps, ReactNode, Ref } from "react";
import { cn } from "../../lib/utils.ts";

function StudioHeaderFrame({
  className,
  draggable = false,
  density,
  ...props
}: ComponentProps<"header"> & {
  draggable?: boolean;
  density: "surface" | "panel";
}) {
  return (
    <header
      className={cn(
        "relative flex shrink-0 items-center border-b border-border bg-background",
        density === "surface" ? "h-14 min-h-14" : "h-10 min-h-10",
        draggable && "app-drag",
        className,
      )}
      {...props}
    />
  );
}

/** Two-line document header for Research and immutable Resource views. */
export function StudioDocumentHeader(
  props: ComponentProps<"header"> & { draggable?: boolean },
) {
  return <StudioHeaderFrame density="surface" {...props} />;
}

/** Compact tool/panel header matching Moodboard Agent and Canvas chrome. */
export function StudioPanelHeader(
  props: ComponentProps<"header"> & { draggable?: boolean },
) {
  return <StudioHeaderFrame density="panel" {...props} />;
}

/** Compact design-surface toolbar for Canvas, Artifact editing, and Present. */
export function StudioToolbarHeader(
  props: ComponentProps<"header"> & { draggable?: boolean },
) {
  return <StudioHeaderFrame density="panel" {...props} />;
}

export function StudioHeaderIdentity({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-w-0 items-center gap-2.5", className)}
      {...props}
    />
  );
}

export function StudioHeaderCopy({
  title,
  subtitle,
  titleId,
  headingLevel = 1,
  headingRef,
  headingTabIndex,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  titleId?: string;
  headingLevel?: 1 | 2;
  headingRef?: Ref<HTMLHeadingElement>;
  headingTabIndex?: number;
  className?: string;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className={cn("min-w-0", className)}>
      <Heading
        ref={headingRef}
        id={titleId}
        tabIndex={headingTabIndex}
        className="truncate text-[13px] font-medium leading-[1.2] tracking-[-0.01em] text-foreground"
      >
        {title}
      </Heading>
      {subtitle === undefined ? null : (
        <p className="mt-0.5 truncate text-xs leading-[1.25] text-muted-foreground">
          {subtitle}
        </p>
      )}
    </div>
  );
}

export function StudioHeaderActions({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn("app-no-drag flex min-w-0 items-center gap-1.5", className)}
      {...props}
    />
  );
}
