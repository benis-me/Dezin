import { LoaderCircle } from "lucide-react";
import { useRef, useState, type RefObject } from "react";

import { Button } from "../components/ui/Button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/Dialog.tsx";

export function ImplementationExportConfirmation({
  open,
  onOpenChange,
  onConfirm,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const confirm = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await onConfirm();
    } finally {
      pendingRef.current = false;
      setPending(false);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-[420px] gap-0 overflow-hidden p-0"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <DialogHeader className="gap-2 px-6 pb-5 pt-6 text-left">
          <DialogTitle>Start implementation export?</DialogTitle>
          <DialogDescription className="leading-6">
            Dezin will generate a fresh implementation from the selected Versions. This may consume quota from your configured provider.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="border-t border-border/70 bg-surface-1/60 px-6 py-4 sm:justify-end">
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>Cancel</Button>
          </DialogClose>
          <Button
            type="button"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={() => void confirm().catch(() => undefined)}
          >
            {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
            {pending ? "Starting…" : "Start export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
