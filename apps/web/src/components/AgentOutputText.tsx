import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Markdown } from "./Markdown.tsx";
import { cn } from "../lib/utils.ts";

function splitGraphemes(text: string): string[] {
  const segmenter = typeof Intl !== "undefined" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  return segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);
}

export function AgentOutputText({
  text,
  className,
  animate = true,
}: {
  text: string;
  className?: string;
  animate?: boolean;
}) {
  if (!animate) return <Markdown className={className}>{text}</Markdown>;

  const charIndex = { current: 0 };
  const animated = (children: ReactNode) => animateChildren(children, charIndex);

  return (
    <div data-agent-output-animated="true" className={cn("agent-output-text", className)}>
      <div className="sr-only" aria-hidden="true" inert>
        <Markdown>{text}</Markdown>
      </div>
      <div className="dz-selectable space-y-2.5 text-sm leading-relaxed text-foreground/90">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p className="leading-relaxed">{animated(children)}</p>,
            h1: ({ children }) => <h3 className="mt-3 text-sm font-semibold text-foreground">{animated(children)}</h3>,
            h2: ({ children }) => <h3 className="mt-3 text-sm font-semibold text-foreground">{animated(children)}</h3>,
            h3: ({ children }) => <h4 className="mt-3 text-[13px] font-semibold text-foreground">{animated(children)}</h4>,
            ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground">{animated(children)}</ul>,
            ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">{animated(children)}</ol>,
            li: ({ children }) => <li className="leading-relaxed">{animated(children)}</li>,
            strong: ({ children }) => <strong className="font-semibold text-foreground">{animated(children)}</strong>,
            em: ({ children }) => <em className="italic">{animated(children)}</em>,
            a: ({ children, href }) => (
              <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
                {animated(children)}
              </a>
            ),
            blockquote: ({ children }) => <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">{animated(children)}</blockquote>,
            code: ({ className, children }) => {
              const inline = !className;
              return inline ? (
                <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-foreground">{animated(children)}</code>
              ) : (
                <code className={className}>{animated(children)}</code>
              );
            },
            pre: ({ children }) => (
              <pre className="overflow-x-auto rounded-lg border border-border bg-card p-3 font-mono text-[12px] leading-relaxed">
                {animated(children)}
              </pre>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function animateChildren(children: ReactNode, charIndex: { current: number }): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return animateString(child, charIndex);
    if (!isValidElement(child)) return child;
    if ((child.props as { "data-agent-output-char"?: boolean })["data-agent-output-char"]) return child;
    const element = child as ReactElement<{ children?: ReactNode }>;
    if (element.props.children === undefined) return child;
    return cloneElement(element, { children: animateChildren(element.props.children, charIndex) });
  });
}

function animateString(text: string, charIndex: { current: number }): ReactNode {
  return splitGraphemes(text).map((char) => {
    const index = charIndex.current;
    charIndex.current += 1;
    return (
      <span key={`${index}-${char}`} data-agent-output-char className="agent-output-char" style={{ animationDelay: `${Math.min(index * 18, 900)}ms` }}>
        {char}
      </span>
    );
  });
}
