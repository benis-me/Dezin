import { useEffect, useRef, useState } from "react";
import { ArrowUp, ImagePlus, Loader2 } from "lucide-react";
import type { MoodboardMessage, MoodboardNode } from "../lib/api.ts";
import { Button, IconButton, Textarea } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";

export function MoodboardAgentPanel({
  messages,
  nodes,
  busy,
  onSend,
  onGenerate,
}: {
  messages: MoodboardMessage[];
  nodes: MoodboardNode[];
  busy: boolean;
  onSend: (content: string) => Promise<void>;
  onGenerate: (prompt: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, busy]);

  const submit = async (mode: "send" | "generate") => {
    const content = text.trim();
    if (!content || busy) return;
    setText("");
    if (mode === "generate") await onGenerate(content);
    else await onSend(content);
  };

  return (
    <aside className="flex h-full min-w-0 flex-col border-r border-border bg-sidebar">
      <div className="app-drag titlebar-pad-top border-b border-border px-3.5 pb-3 pt-3">
        <div className="app-no-drag flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">Moodboard Agent</h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {nodes.length} canvas item{nodes.length === 1 ? "" : "s"} in context
            </p>
          </div>
          <span className="label-mono">Board</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="mt-8 rounded-lg border border-dashed border-border bg-background/60 p-3 text-sm leading-relaxed text-muted-foreground">
            Ask for visual directions, generate image material, or use the canvas as context for references.
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

      <div className="border-t border-border p-2.5">
        <div className="rounded-xl border border-input bg-background p-2 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
          <Textarea
            aria-label="Moodboard prompt"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Generate a tactile product shot with soft daylight..."
            className="border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submit("send");
              }
            }}
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <Button size="sm" variant="ghost" className="gap-2" disabled={busy || text.trim().length === 0} onClick={() => void submit("generate")}>
              <ImagePlus size={14} strokeWidth={1.75} />
              Generate image
            </Button>
            <IconButton aria-label="Send message" disabled={busy || text.trim().length === 0} onClick={() => void submit("send")}>
              <ArrowUp size={15} strokeWidth={2} />
            </IconButton>
          </div>
        </div>
      </div>
    </aside>
  );
}
