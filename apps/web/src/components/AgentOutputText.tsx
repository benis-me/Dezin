import { Streamdown } from "streamdown";
import { dezinMarkdownComponents, Markdown } from "./Markdown.tsx";
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
    <>
      {needsTextMirror ? (
        <div className="sr-only" aria-hidden="true" inert>
          <Markdown>{text}</Markdown>
        </div>
      ) : null}
      <Streamdown
        animated={animate}
        className={cn(
          "dezin-markdown dezin-agent-output",
          className,
        )}
        data-stream-idle={animate ? undefined : "true"}
        components={dezinMarkdownComponents}
        controls={false}
        isAnimating={animate}
        mode="streaming"
        skipHtml
      >
        {text}
      </Streamdown>
    </>
  );
}
