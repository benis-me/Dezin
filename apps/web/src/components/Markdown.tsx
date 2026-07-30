import { Streamdown, type Components } from "streamdown";
import "streamdown/styles.css";
import { cn } from "../lib/utils.ts";

export const dezinMarkdownComponents = {
  a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
  strong: ({ children }) => <strong>{children}</strong>,
} satisfies Components;

/**
 * Render agent prose as markdown — headings, lists, code, bold, links — with the
 * app's typography. Kept compact for the chat column.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("dezin-markdown", className)}>
      <Streamdown
        components={dezinMarkdownComponents}
        controls={false}
        mode="static"
        skipHtml
      >
        {children}
      </Streamdown>
    </div>
  );
}
