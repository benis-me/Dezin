import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronLeft, Loader2, Sparkles } from "lucide-react";
import type { AgentInfo, MoodboardMessage } from "../lib/api.ts";
import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import { IconButton, Textarea } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";

export function MoodboardAgentPanel({
  boardName,
  status,
  messages,
  busy,
  agents,
  agent,
  model,
  onBack,
  onAgentChange,
  onModelChange,
  onRescanAgents,
  onSend,
}: {
  boardName: string;
  status: string;
  messages: MoodboardMessage[];
  busy: boolean;
  agents: AgentInfo[];
  agent: string;
  model: string;
  onBack: () => void;
  onAgentChange: (command: string) => void;
  onModelChange: (model: string) => void;
  onRescanAgents: () => Promise<void>;
  onSend: (content: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, busy]);

  const submit = async () => {
    const content = text.trim();
    if (!content || busy) return;
    setText("");
    await onSend(content);
  };

  return (
    <aside className="relative flex h-full min-w-0 flex-col bg-sidebar">
      <div className="app-drag titlebar-pad-left flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-2.5">
        <button
          type="button"
          aria-label="Back to moodboards"
          title="Back to moodboards"
          onClick={onBack}
          className="app-no-drag flex min-w-0 items-center gap-1 rounded-lg py-1 pl-1 pr-2 text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <ChevronLeft size={16} strokeWidth={2} className="shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{boardName}</span>
        </button>
        <span className="label-mono shrink-0 text-muted-foreground">{status}</span>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 pt-5">
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
              <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[88%] rounded-lg border px-3 py-2 text-sm leading-relaxed",
                    message.role === "user"
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-foreground",
                  )}
                >
                  {message.content}
                </div>
              </div>
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
        <div className="bg-background px-3 pb-3">
        <div className="pointer-events-auto rounded-2xl border border-input bg-card px-2.5 pb-2 pt-2.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 hover:border-border-strong">
          <Textarea
            aria-label="Moodboard prompt"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Generate a tactile product shot with soft daylight..."
            className="field-sizing-content max-h-40 min-h-[36px] border-0 bg-transparent px-1 py-0.5 text-sm leading-relaxed shadow-none focus-visible:ring-0"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="mt-1 flex items-center justify-end gap-2">
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
              <IconButton aria-label="Send message" disabled={busy || text.trim().length === 0} onClick={() => void submit()} className="rounded-lg">
                <ArrowUp size={15} strokeWidth={2} />
              </IconButton>
            </div>
          </div>
        </div>
        </div>
      </div>
    </aside>
  );
}
