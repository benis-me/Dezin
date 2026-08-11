import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import "./agent-conversation.css";
import { Markdown } from "./Markdown.tsx";
import { AgentCitationSources, agentMarkdownComponents } from "./AgentRichContent.tsx";
import { cn } from "../lib/utils.ts";

export function AgentOutputText({
  text,
  className,
  animate = false,
}: {
  text: string;
  className?: string;
  animate?: boolean;
}) {
  const needsTextMirror = animate && /\s/.test(text.trim());

  return (
    <div
      className={cn(
        "agent-text-response dz-selectable min-w-0 max-w-full overflow-x-hidden [overflow-wrap:anywhere]",
        className,
      )}
      data-agent-component="message-response"
      data-output-state={animate ? "streaming" : "complete"}
      data-streaming={animate || undefined}
    >
      {needsTextMirror ? (
        <div className="sr-only" aria-hidden="true" inert>
          <Markdown>{text}</Markdown>
        </div>
      ) : null}
      <Streamdown
        animated={animate}
        className="agent-response-prose min-w-0 max-w-full overflow-x-hidden [overflow-wrap:anywhere] [&_[data-sd-animate]]:max-w-full [&_[data-sd-animate]]:whitespace-normal [&_[data-sd-animate]]:[overflow-wrap:anywhere]"
        components={agentMarkdownComponents}
        controls={false}
        isAnimating={animate}
        mode="streaming"
        skipHtml
      >
        {text}
      </Streamdown>
      <AgentCitationSources markdown={text} />
    </div>
  );
}
