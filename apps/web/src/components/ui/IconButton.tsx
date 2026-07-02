import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

/** A square icon-only button. Always pass aria-label (a11y). */
export const IconButton = forwardRef<HTMLButtonElement, { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>>(function IconButton(
  { className = "", children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-[transform,color,background-color] duration-150 ease-out hover:bg-surface-2 hover:text-foreground active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] leading-none text-muted-foreground">
      {children}
    </kbd>
  );
}
