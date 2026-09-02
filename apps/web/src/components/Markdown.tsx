import { Streamdown, type Components } from "streamdown";
import "streamdown/styles.css";
import { explicitExternalImageHref, localPassiveImageSource } from "../lib/local-media-url.ts";
import { cn } from "../lib/utils.ts";

/**
 * Render static markdown (design-system docs, material Documents) with the app's
 * compact typography. Uses the same Streamdown renderer as Agent output so the
 * app carries one Markdown pipeline; here it runs in static mode.
 */
const components: Components = {
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
  img: ({ src, alt }) => {
    const source = typeof src === "string" ? src : undefined;
    const localSrc = localPassiveImageSource(source);
    const externalHref = explicitExternalImageHref(source);
    if (localSrc) {
      return <img src={localSrc} alt={alt ?? ""} loading="lazy" className="max-w-full rounded-lg" />;
    }
    return externalHref ? (
      <a href={externalHref} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
        External image blocked{alt ? `: ${alt}` : ""}
      </a>
    ) : <span>Unsafe image link blocked{alt ? `: ${alt}` : ""}</span>;
  },
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
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("dz-selectable space-y-2.5 text-sm leading-relaxed text-foreground/90", className)}>
      <Streamdown mode="static" controls={false} skipHtml components={components}>
        {children}
      </Streamdown>
    </div>
  );
}
