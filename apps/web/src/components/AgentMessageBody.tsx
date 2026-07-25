import { AgentOutputText } from "./AgentOutputText.tsx";
import { Markdown } from "./Markdown.tsx";
import { cn } from "../lib/utils.ts";

export function AgentMessageBody({
  role,
  content,
  className,
}: {
  role: "user" | "assistant";
  content: string;
  className?: string;
}) {
  if (role === "user") {
    return (
      <div
        data-agent-message-body="user"
        data-message-kind="user"
        className={cn(
          "dz-selectable max-w-[88%] rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2 text-sm leading-relaxed text-foreground",
          className,
        )}
      >
        <Markdown className="space-y-1.5 text-foreground">{content}</Markdown>
      </div>
    );
  }

  return (
    <div
      data-agent-message-body="assistant"
      data-message-kind="assistant"
      className={cn("dz-selectable min-w-0 text-sm leading-relaxed text-foreground", className)}
    >
      <AgentOutputText text={content} />
    </div>
  );
}
