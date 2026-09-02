import { useEffect, useRef } from "react";
import { Button, Dialog } from "./ui/index.ts";

/**
 * In-app confirmation for destructive actions. Replaces window.confirm so the
 * prompt follows the theme, reduced-motion preference, and focus handling of
 * every other dialog. Says exactly what will be deleted and that it is final.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);
  return (
    <Dialog open={open} onClose={onCancel} label={title} className="sm:max-w-md">
      <div className="flex flex-col gap-4 p-1">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={() => void onConfirm()}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
