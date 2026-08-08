import { AgentOutputText } from "./AgentOutputText.tsx";
import { Markdown } from "./Markdown.tsx";
import { cn } from "../lib/utils.ts";

export function AgentMessageBody({
  role,
  content,
  className,
  animate = false,
}: {
  role: "user" | "assistant";
  content: string;
  className?: string;
  animate?: boolean;
}) {
  if (role === "user") {
    return (
      <div
        data-agent-message-body="user"
        data-message-kind="user"
        className={cn(
          "agent-user-message dz-selectable max-w-[88%] text-foreground",
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
      className={cn("agent-assistant-message dz-selectable min-w-0 text-foreground", className)}
    >
      <AgentOutputText text={content} animate={animate} />
    </div>
  );
}
