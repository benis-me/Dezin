import { Streamdown } from "streamdown";
import { useEffect, useState } from "react";
import "streamdown/styles.css";
import "./agent-conversation.css";
import { Markdown } from "./Markdown.tsx";
import { AgentCitationSources, agentMarkdownComponents } from "./AgentRichContent.tsx";
import { cn } from "../lib/utils.ts";
import { DezinAgentStreamingText } from "../design-canvas/DezinAgentPrimitives.tsx";

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
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const copied = copiedText === text;

  useEffect(() => {
    if (copiedText === null) return;
    const timer = window.setTimeout(() => setCopiedText(null), 1_500);
    return () => window.clearTimeout(timer);
  }, [copiedText]);

  return (
    <DezinAgentStreamingText streaming={animate} ariaLabel="Agent response">
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
        {animate ? null : (
          <div className="agent-response-actions" data-agent-component="response-actions" aria-live="polite">
            <button
              type="button"
              className="agent-response-action"
              data-state={copied ? "copied" : "idle"}
              aria-label={copied ? "Response copied" : "Copy response"}
              title={copied ? "Copied" : "Copy"}
              onClick={() => {
                void writeResponseClipboard(text).then(() => setCopiedText(text)).catch(() => setCopiedText(null));
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {copied ? (
                  <path d="M20 6L9 17l-5-5" />
                ) : (
                  <>
                    <rect x="9" y="9" width="12" height="12" rx="2.5" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </>
                )}
              </svg>
            </button>
          </div>
        )}
        <AgentCitationSources markdown={text} />
      </div>
    </DezinAgentStreamingText>
  );
}

async function writeResponseClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard copy was rejected");
  } finally {
    field.remove();
  }
}
