import { Check, ChevronDown, Code2, Copy, ExternalLink, ImageIcon, ListTodo } from "lucide-react";
import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { Components } from "streamdown";

import { cn } from "../lib/utils.ts";

interface CitationReference {
  number: string;
  href: string;
  label: string;
  host: string;
}

function reactNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join("");
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  return reactNodeText(node.props.children);
}

function safeHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

export function citationReferences(markdown: string): CitationReference[] {
  const references: CitationReference[] = [];
  const seen = new Set<string>();
  const pattern = /\[(\d{1,3})\]\((https?:\/\/[^\s)]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const number = match[1]!;
    const href = match[2]!;
    const key = `${number}:${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const host = safeHost(href);
    references.push({
      number,
      href,
      label: match[3] || match[4] || host,
      host,
    });
  }
  return references;
}

export function AgentCitationSources({ markdown }: { markdown: string }) {
  const references = useMemo(() => citationReferences(markdown), [markdown]);
  if (references.length === 0) return null;
  return (
    <footer className="agent-citations" aria-label="Sources" data-agent-component="inline-citations">
      {references.map((reference) => (
        <a
          key={`${reference.number}:${reference.href}`}
          className="agent-citations__reference"
          href={reference.href}
          target="_blank"
          rel="noreferrer"
        >
          <span className="agent-citation-mark" aria-hidden>{reference.number}</span>
          <span className="agent-citations__label">{reference.label}</span>
          <span className="agent-citations__separator" aria-hidden>·</span>
          <span className="agent-citations__host">{reference.host}</span>
          <ExternalLink className="agent-citations__arrow" aria-hidden />
        </a>
      ))}
    </footer>
  );
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_200);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  return (
    <button
      type="button"
      className="agent-code-block__copy"
      aria-label={copied ? "Code copied" : "Copy code"}
      onClick={() => {
        void writeClipboard(code).then(() => setCopied(true)).catch(() => setCopied(false));
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function AgentCodeBlock({ code, language = "text" }: { code: string; language?: string }) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <figure className="agent-code-block" data-agent-component="code-block">
      <figcaption className="agent-code-block__header">
        <span className="agent-code-block__language"><Code2 aria-hidden />{language || "text"}</span>
        <CopyCodeButton code={code} />
      </figcaption>
      <div className="agent-code-block__body">
        {lines.map((line, index) => (
          <div className="agent-code-block__row" key={`${index}:${line}`}>
            <span className="agent-code-block__line" aria-hidden>{index + 1}</span>
            <code>{line || "\u00a0"}</code>
          </div>
        ))}
      </div>
    </figure>
  );
}

type DiffRowKind = "context" | "add" | "delete";
interface DiffRow {
  key: string;
  oldLine: number | null;
  newLine: number | null;
  kind: DiffRowKind;
  text: string;
}

function parseDiff(code: string): { file: string; rows: DiffRow[] } {
  const source = code.replace(/\n$/, "").split("\n");
  const nextFile = source.find((line) => line.startsWith("+++ "))?.replace(/^\+\+\+\s+(?:b\/)?/, "")
    ?? source.find((line) => line.startsWith("diff --git "))?.split(" ").at(-1)?.replace(/^b\//, "")
    ?? "Changes";
  let oldLine: number | null = null;
  let newLine: number | null = null;
  const rows: DiffRow[] = [];
  for (const [index, line] of source.entries()) {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (/^(?:diff --git|index |--- |\+\+\+ )/.test(line)) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({ key: `${index}:add`, oldLine: null, newLine, kind: "add", text: line.slice(1) });
      if (newLine !== null) newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      rows.push({ key: `${index}:delete`, oldLine, newLine: null, kind: "delete", text: line.slice(1) });
      if (oldLine !== null) oldLine += 1;
      continue;
    }
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({ key: `${index}:context`, oldLine, newLine, kind: "context", text });
    if (oldLine !== null) oldLine += 1;
    if (newLine !== null) newLine += 1;
  }
  return { file: nextFile, rows };
}

export function AgentFileDiff({ code }: { code: string }) {
  const parsed = useMemo(() => parseDiff(code), [code]);
  const added = parsed.rows.filter((row) => row.kind === "add").length;
  const removed = parsed.rows.filter((row) => row.kind === "delete").length;
  return (
    <figure className="agent-file-diff" data-agent-component="file-diff">
      <figcaption className="agent-file-diff__header">
        <span className="agent-file-diff__file"><Code2 aria-hidden />{parsed.file}</span>
        <span className="agent-file-diff__stats" aria-label={`${added} additions and ${removed} deletions`}>
          <span>+{added}</span><span>-{removed}</span>
        </span>
      </figcaption>
      <div className="agent-file-diff__body">
        {parsed.rows.map((row) => (
          <div key={row.key} className="agent-file-diff__row" data-kind={row.kind}>
            <span className="agent-file-diff__line" aria-hidden>{row.oldLine ?? ""}</span>
            <span className="agent-file-diff__line" aria-hidden>{row.newLine ?? ""}</span>
            <span className="agent-file-diff__sign" aria-hidden>{row.kind === "add" ? "+" : row.kind === "delete" ? "−" : ""}</span>
            <code>{row.text || "\u00a0"}</code>
          </div>
        ))}
      </div>
    </figure>
  );
}

function codeBlockDetails(children: ReactNode): { code: string; language: string } {
  const child = Children.toArray(children).find((candidate) => isValidElement<{ className?: string; children?: ReactNode }>(candidate));
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    return { code: reactNodeText(children), language: "text" };
  }
  const language = /(?:^|\s)language-([^\s]+)/.exec(child.props.className ?? "")?.[1] ?? "text";
  return { code: reactNodeText(child.props.children), language };
}

function AgentPre({ children }: ComponentPropsWithoutRef<"pre">) {
  const block = codeBlockDetails(children);
  return block.language.toLocaleLowerCase() === "diff"
    ? <AgentFileDiff code={block.code} />
    : <AgentCodeBlock code={block.code} language={block.language} />;
}

function taskChecks(node: ReactNode): boolean[] {
  if (Array.isArray(node)) return node.flatMap(taskChecks);
  if (!isValidElement<{ children?: ReactNode; checked?: boolean; type?: string }>(node)) return [];
  const own = node.type === "input" && node.props.type === "checkbox" ? [Boolean(node.props.checked)] : [];
  return [...own, ...taskChecks(node.props.children)];
}

function AgentTaskList({ children, className }: ComponentPropsWithoutRef<"ul">) {
  const [open, setOpen] = useState(true);
  const checks = taskChecks(children);
  const complete = checks.filter(Boolean).length;
  const total = checks.length;
  const allComplete = total > 0 && complete === total;
  return (
    <section className="agent-task-list" data-agent-component="task-list" data-collapsed={!open || undefined} data-complete={allComplete || undefined}>
      <button type="button" className="agent-task-list__header" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="agent-task-list__icon" data-complete={allComplete || undefined}>
          {allComplete ? <Check aria-hidden /> : <ListTodo aria-hidden />}
          <ChevronDown className="agent-task-list__chevron" aria-hidden />
        </span>
        <span>To-dos</span>
        <span className="agent-task-list__count">{complete}/{total}</span>
      </button>
      <div className="agent-task-list__collapsible" data-collapsed={!open || undefined}>
        <div>
          <ul className={cn("agent-task-list__items", className)}>{children}</ul>
        </div>
      </div>
    </section>
  );
}

function AgentUnorderedList({ children, className }: ComponentPropsWithoutRef<"ul">) {
  if (className?.includes("contains-task-list")) return <AgentTaskList className={className}>{children}</AgentTaskList>;
  return <ul className={cn("agent-response-list agent-response-list--unordered", className)}>{children}</ul>;
}

function AgentGeneratedImage({ src, alt = "", title }: ComponentPropsWithoutRef<"img">) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  return (
    <figure className="agent-generated-image" data-agent-component="image-generation" data-state={state}>
      <div className="agent-generated-image__canvas">
        <span className="agent-generated-image__dots" aria-hidden />
        <span className="agent-generated-image__glow" aria-hidden />
        {src ? (
          <img
            src={src}
            alt={alt}
            title={title}
            loading="lazy"
            onLoad={() => setState("ready")}
            onError={() => setState("failed")}
          />
        ) : null}
        <span className="agent-generated-image__badge">Image</span>
        {state === "failed" ? <ImageIcon className="agent-generated-image__fallback" aria-hidden /> : null}
      </div>
      <figcaption>
        <strong>{state === "loading" ? "Generating image" : state === "ready" ? "Generated image" : "Image unavailable"}</strong>
        {alt ? <span>“{alt}”</span> : null}
      </figcaption>
    </figure>
  );
}

function AgentParagraph({ children }: ComponentPropsWithoutRef<"p">) {
  const containsImage = Children.toArray(children).some((child) => (
    isValidElement(child) && child.type === AgentGeneratedImage
  ));
  return containsImage
    ? <div className="agent-response-media">{children}</div>
    : <p className="agent-response-paragraph">{children}</p>;
}

function AgentCitationLink({ children, href, title }: ComponentPropsWithoutRef<"a">) {
  const label = reactNodeText(children).trim();
  if (href && /^\d{1,3}$/.test(label)) {
    const tooltip = title || safeHost(href);
    return (
      <span className="agent-citation-tip">
        <a className="agent-citation-mark" href={href} target="_blank" rel="noreferrer" aria-label={`Source ${label}: ${tooltip}`}>{label}</a>
        <span className="agent-citation-tip__content" role="tooltip">{tooltip}</span>
      </span>
    );
  }
  return (
    <a className="agent-response-link" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function AgentTable({ children }: ComponentPropsWithoutRef<"table">) {
  return (
    <div className="agent-data-table" data-agent-component="data-table">
      <div className="agent-data-table__scroll">
        <table>{children}</table>
      </div>
    </div>
  );
}

const inlineCode = ({ children }: ComponentPropsWithoutRef<"code">) => (
  <code className="agent-inline-code max-w-full whitespace-normal [overflow-wrap:anywhere]">{children}</code>
);

export const agentMarkdownComponents = {
  p: AgentParagraph,
  h1: ({ children }: ComponentPropsWithoutRef<"h1">) => <h2 className="agent-response-heading agent-response-heading--large">{children}</h2>,
  h2: ({ children }: ComponentPropsWithoutRef<"h2">) => <h3 className="agent-response-heading">{children}</h3>,
  h3: ({ children }: ComponentPropsWithoutRef<"h3">) => <h4 className="agent-response-heading agent-response-heading--small">{children}</h4>,
  ul: AgentUnorderedList,
  ol: ({ children, className, start }: ComponentPropsWithoutRef<"ol">) => <ol start={start} className={cn("agent-response-list agent-response-list--ordered", className)}>{children}</ol>,
  li: ({ children, className, value }: ComponentPropsWithoutRef<"li">) => <li value={value} className={className}>{children}</li>,
  strong: ({ children }: ComponentPropsWithoutRef<"strong">) => <strong className="agent-response-strong">{children}</strong>,
  em: ({ children }: ComponentPropsWithoutRef<"em">) => <em>{children}</em>,
  a: AgentCitationLink,
  blockquote: ({ children }: ComponentPropsWithoutRef<"blockquote">) => <blockquote className="agent-response-quote">{children}</blockquote>,
  inlineCode,
  code: ({ className, children }: ComponentPropsWithoutRef<"code">) => className
    ? <code className={className}>{children}</code>
    : inlineCode({ children }),
  pre: AgentPre,
  table: AgentTable,
  thead: ({ children }: ComponentPropsWithoutRef<"thead">) => <thead>{children}</thead>,
  tbody: ({ children }: ComponentPropsWithoutRef<"tbody">) => <tbody>{children}</tbody>,
  tr: ({ children }: ComponentPropsWithoutRef<"tr">) => <tr>{children}</tr>,
  th: ({ children, colSpan, rowSpan, scope }: ComponentPropsWithoutRef<"th">) => <th colSpan={colSpan} rowSpan={rowSpan} scope={scope}>{children}</th>,
  td: ({ children, colSpan, rowSpan }: ComponentPropsWithoutRef<"td">) => <td colSpan={colSpan} rowSpan={rowSpan}>{children}</td>,
  img: AgentGeneratedImage,
} as unknown as Components;
