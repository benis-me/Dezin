import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpToLine, Copy, Loader2, Trash2, WandSparkles } from "lucide-react";
import type { MoodboardNode } from "../lib/api.ts";
import { Button, IconButton, Textarea, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { generatorPrompt, generatorStatus, layerLabel } from "./canvas-utils.ts";

export function ToolButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton aria-label={label} onClick={onClick} className={cn(active && "bg-accent text-foreground")}>
          {children}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent sideOffset={2}>{label}</TooltipContent>
    </Tooltip>
  );
}

export function SelectionToolbar({
  node,
  onDuplicate,
  onBringToFront,
  onSendToBack,
  onDelete,
}: {
  node: MoodboardNode;
  onDuplicate: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDelete: () => void;
}) {
  return (
    <TooltipProvider delayDuration={120}>
      <div className="pointer-events-auto app-no-drag flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-pop">
        <span className="max-w-40 truncate px-2 text-xs font-medium text-muted-foreground">{layerLabel(node)}</span>
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolButton label="Duplicate" onClick={onDuplicate}>
          <Copy size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Bring to front" onClick={onBringToFront}>
          <ArrowUpToLine size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Send to back" onClick={onSendToBack}>
          <ArrowDownToLine size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Delete" onClick={onDelete}>
          <Trash2 size={14} strokeWidth={1.75} />
        </ToolButton>
      </div>
    </TooltipProvider>
  );
}

export function GeneratorPromptToolbar({
  node,
  busy,
  onPromptChange,
  onGenerate,
}: {
  node: MoodboardNode;
  busy: boolean;
  onPromptChange: (prompt: string) => void;
  onGenerate: (prompt: string) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState(generatorPrompt(node));
  const status = generatorStatus(node);

  useEffect(() => {
    setPrompt(generatorPrompt(node));
  }, [node]);

  const submit = async () => {
    const next = prompt.trim();
    if (!next || busy) return;
    onPromptChange(next);
    await onGenerate(next);
  };

  return (
    <div className="pointer-events-auto app-no-drag w-[min(600px,calc(100vw-3rem))] rounded-lg border border-border bg-popover/95 p-2 shadow-pop backdrop-blur-xl">
      <Textarea
        aria-label="Image generator prompt"
        rows={3}
        value={prompt}
        autoFocus
        placeholder="Describe the image material this generator should create..."
        onChange={(event) => {
          setPrompt(event.target.value);
          onPromptChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
        className="min-h-20 resize-none border-0 bg-transparent px-1 py-1 text-sm shadow-none focus-visible:ring-0"
      />
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2">
        <span className="label-mono text-muted-foreground">
          {busy ? "Generating" : status === "done" ? "Ready · last image generated" : "Image generator"}
        </span>
        <Button size="sm" disabled={busy || prompt.trim().length === 0} onClick={() => void submit()} className="h-8 gap-2">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <WandSparkles size={14} strokeWidth={1.75} />}
          Generate
        </Button>
      </div>
    </div>
  );
}
