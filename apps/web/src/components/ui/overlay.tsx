import type { ReactNode } from "react";
import { Dialog as ShDialog, DialogContent, DialogTitle } from "./Dialog.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * Thin adapter over shadcn's Radix Dialog that keeps Dezin's simple
 * open/onClose API. No built-in close button (consumers render their own chrome).
 */
export function Dialog({
  open,
  onClose,
  children,
  label,
  className = "",
  align = "center",
  showClose = false,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  label?: string;
  className?: string;
  align?: "center" | "top";
  autoFocus?: boolean;
  showClose?: boolean;
}) {
  return (
    <ShDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={showClose}
        aria-label={label}
        className={cn("gap-0 overflow-hidden p-0", align === "top" && "top-[12vh] translate-y-0", className)}
      >
        <DialogTitle className="sr-only">{label ?? "Dialog"}</DialogTitle>
        {children}
      </DialogContent>
    </ShDialog>
  );
}
