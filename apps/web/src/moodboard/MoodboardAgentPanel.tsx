import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronLeft, Copy, Loader2, Paperclip, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { AgentInfo, MoodboardMessage } from "../lib/api.ts";
import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import { AttachMenu } from "../components/AttachMenu.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Button, IconButton, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";

export function MoodboardAgentPanel({
  boardName,
  messages,
  busy,
  agents,
  agent,
  model,
  onBack,
  onAgentChange,
  onModelChange,
  onRescanAgents,
  onUploadFiles,
  onSend,
}: {
  boardName: string;
  messages: MoodboardMessage[];
  busy: boolean;
  agents: AgentInfo[];
  agent: string;
  model: string;
  onBack: () => void;
  onAgentChange: (command: string) => void;
  onModelChange: (model: string) => void;
  onRescanAgents: () => Promise<void>;
  onUploadFiles?: (files: FileList | null) => void;
  onSend: (content: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [composerH, setComposerH] = useState(92);
  const [dragging, setDragging] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setComposerH(element.offsetHeight));
    observer.observe(element);
    setComposerH(element.offsetHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, busy]);

  const submit = async () => {
    const content = text.trim();
    if (!content || busy) return;
    setText("");
    await onSend(content);
  };

  const copyMessage = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      /* Clipboard can be unavailable in local webviews. */
    }
  };

  const appendContext = (context: string) => {
    setText((current) => `${current}${current.trim() ? "\n\n" : ""}${context}`);
  };

  const attachFiles = (files: FileList | null) => {
    onUploadFiles?.(files);
    setDragging(false);
  };

  return (
    <aside className="relative flex h-full min-w-0 flex-col bg-background">
      <div className="app-drag titlebar-pad-left flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-2.5">
        <button
          type="button"
          aria-label="Back to moodboards"
          title="Back to moodboards"
          onClick={onBack}
          className="app-no-drag flex min-w-0 items-center gap-1 rounded-lg py-1 pl-1 pr-2 text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <ChevronLeft size={16} strokeWidth={2} className="shrink-0 text-muted-foreground" />
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={boardName || "Moodboard"}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
              className="truncate text-sm font-medium"
            >
              {boardName || "Moodboard"}
            </motion.span>
          </AnimatePresence>
        </button>
      </div>

      <div
        data-testid="moodboard-agent-messages"
        className={cn("min-h-0 flex-1 px-4 pt-5", messages.length > 0 ? "space-y-4 overflow-auto" : "overflow-hidden")}
        style={messages.length > 0 ? { paddingBottom: composerH + 36 } : undefined}
      >
        {messages.length === 0 ? (
          <div className="grid h-full place-items-center">
            <div className="flex max-w-[16rem] flex-col items-center gap-3 text-center">
              <span className="grid h-11 w-11 place-items-center rounded-2xl border border-border bg-card text-foreground">
                <Sparkles size={20} strokeWidth={1.75} />
              </span>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Ask for visual direction, generate image material, or use the current canvas as reference context.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => (
              <MoodboardMessageRow key={message.id} message={message} busy={busy} onCopy={(content) => void copyMessage(content)} />
            ))}
            {busy ? (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  Working...
                </div>
              </div>
            ) : null}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0">
        <div aria-hidden className="h-12 bg-gradient-to-t from-background via-background/90 to-transparent" />
        <div ref={composerRef} className="bg-background px-3 pb-3">
          <div
            onDragOver={(event) => {
              if (!onUploadFiles) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setDragging(false);
            }}
            onDrop={(event) => {
              if (!onUploadFiles) return;
              event.preventDefault();
              attachFiles(event.dataTransfer.files);
            }}
            className={`pointer-events-auto relative rounded-2xl border bg-card px-2.5 pb-2 pt-2.5 transition-[color,border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 focus-within:hover:border-ring ${
              dragging ? "border-ring ring-2 ring-ring/40" : "border-input hover:border-border-strong"
            }`}
          >
            {dragging ? (
              <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-card/90 text-sm font-medium text-foreground">
                <span className="flex items-center gap-2">
                  <Paperclip size={15} strokeWidth={1.75} />
                  Drop files to attach
                </span>
              </div>
            ) : null}
            {onUploadFiles ? (
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,video/*"
                className="hidden"
                aria-label="Attach moodboard files"
                onChange={(event) => {
                  attachFiles(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
            ) : null}
            <textarea
              aria-label="Message"
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ask for visual direction or generate material..."
              className="field-sizing-content max-h-40 min-h-[36px] w-full resize-none bg-transparent px-1 py-0.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="mt-1 flex items-center justify-between gap-2">
              <div className="flex items-center gap-0.5">
                <AttachMenu
                  onAttachFile={onUploadFiles ? () => fileInputRef.current?.click() : undefined}
                  onPickPaths={(paths) => appendContext(`Reference local paths: ${paths.join(", ")}`)}
                  onContext={appendContext}
                  onReference={(project) => appendContext(`Reference Dezin project: ${project.name} (${project.id})`)}
                />
              </div>
              <TooltipProvider delayDuration={120}>
                <div className="flex min-w-0 items-center gap-1">
                  <AgentModelSelect
                    agents={agents}
                    agent={agent}
                    model={model}
                    dropUp
                    onAgentChange={onAgentChange}
                    onModelChange={onModelChange}
                    onRescan={onRescanAgents}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button aria-label="Send" size="icon-sm" disabled={busy || text.trim().length === 0} onClick={() => void submit()} className="ml-0.5 rounded-lg">
                        <ArrowUp size={15} strokeWidth={2} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={2}>Send</TooltipContent>
                  </Tooltip>
                </div>
              </TooltipProvider>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function MoodboardMessageRow({
  message,
  busy,
  onCopy,
}: {
  message: MoodboardMessage;
  busy: boolean;
  onCopy: (content: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <span className="dz-selectable max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2 text-sm leading-relaxed text-foreground">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div className="group/moodboard-assistant -mx-2 rounded-xl px-2 py-1">
      <div data-message-kind="assistant" className="dz-selectable text-sm leading-relaxed text-foreground">
        <Markdown>{message.content}</Markdown>
      </div>
      {!busy ? (
        <TooltipProvider delayDuration={120}>
          <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/moodboard-assistant:opacity-100 focus-within:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton aria-label="Copy message" className="h-7 w-7 rounded-md" onClick={() => onCopy(message.content)}>
                  <Copy size={13} strokeWidth={1.8} />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent sideOffset={2}>Copy</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      ) : null}
    </div>
  );
}
