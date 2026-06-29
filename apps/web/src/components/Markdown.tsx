import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Render agent prose as markdown — headings, lists, code, bold, links — with the
 * app's typography. Kept compact for the chat column.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="dz-selectable space-y-2.5 text-sm leading-relaxed text-foreground/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
            <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
          ),
          code: ({ className, children }) => {
            const inline = !className;
            return inline ? (
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-foreground">{children}</code>
            ) : (
              <code className={className}>{children}</code>
            );
          },
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-lg border border-border bg-card p-3 font-mono text-[12px] leading-relaxed">
              {children}
            </pre>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
