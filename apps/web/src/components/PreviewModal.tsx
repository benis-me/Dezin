import { X } from "lucide-react";
import { Dialog, IconButton } from "./ui/index.ts";
import { previewSandboxForSrc } from "../lib/preview-sandbox.ts";

/** Near-fullscreen artifact preview overlay. `src` is a /projects/:id/preview/ URL. */
export function PreviewModal({ open, src, onClose }: { open: boolean; src?: string; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} label="Preview" className="flex h-[92vh] w-[96vw] max-w-none flex-col overflow-hidden sm:max-w-none">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-sm font-medium">Preview</span>
        <IconButton aria-label="Close preview" onClick={onClose}>
          <X size={16} strokeWidth={1.75} />
        </IconButton>
      </div>
      <div className="flex-1 bg-surface-2">
        {src ? (
          <iframe
            title="Artifact preview (full screen)"
            src={src}
            sandbox={previewSandboxForSrc(src)}
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">No artifact yet</div>
        )}
      </div>
    </Dialog>
  );
}
