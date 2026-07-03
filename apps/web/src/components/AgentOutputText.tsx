import { Streamdown, type Components } from "streamdown";
import "streamdown/styles.css";
import { Markdown } from "./Markdown.tsx";
import { cn } from "../lib/utils.ts";

const agentMarkdownComponents = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  h1: ({ children }) => <h3 className="mt-3 text-sm font-semibold text-foreground">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 text-sm font-semibold text-foreground">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 text-[13px] font-semibold text-foreground">{children}</h4>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 [overflow-wrap:anywhere]">
      {children}
    </a>
  ),
  blockquote: ({ children }) => <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
  inlineCode: ({ children }) => (
    <code className="max-w-full whitespace-normal rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-foreground [overflow-wrap:anywhere]">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="min-w-0 max-w-full overflow-x-auto rounded-lg border border-border bg-card p-3 font-mono text-[12px] leading-relaxed">
      {children}
    </pre>
  ),
} satisfies Components;

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
          "dz-selectable min-w-0 max-w-full overflow-x-hidden space-y-2.5 text-sm leading-relaxed text-foreground/90 [overflow-wrap:anywhere] [&_[data-sd-animate]]:max-w-full [&_[data-sd-animate]]:whitespace-normal [&_[data-sd-animate]]:[overflow-wrap:anywhere]",
          className,
        )}
        components={agentMarkdownComponents}
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
