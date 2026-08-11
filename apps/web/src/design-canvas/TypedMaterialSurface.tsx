import { Code2, ExternalLink, FileText, RotateCcw, Save } from "lucide-react";
import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";

import { Markdown } from "../components/Markdown.tsx";
import { Button } from "../components/ui/Button.tsx";
import type { DesignCanvasApi } from "./api.ts";
import { useExactVersionMetadata } from "./exact-version-metadata.ts";
import type { NodeFocusMotion } from "./node-focus-motion.ts";
import {
  displayLanguage,
  typedMaterialHighlighter,
  typedMaterialPresentation,
  type TypedMaterialPresentation,
} from "./typed-material.ts";
import type { DesignNode, DesignNodeVersion } from "./types.ts";
import "./typed-material.css";

const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_RICH_TEXT_RENDER_BYTES = 64 * 1024;
const MAX_CACHED_TEXT_MATERIALS = 12;

export interface TextMaterialDescriptor {
  fileName: string;
  mimeType: string;
  bytes: number | null;
  presentation: TypedMaterialPresentation;
}

type TextMaterialState =
  | { key: string; status: "loading"; descriptor: TextMaterialDescriptor }
  | { key: string; status: "ready"; descriptor: TextMaterialDescriptor; content: string }
  | { key: string; status: "binary"; descriptor: TextMaterialDescriptor }
  | { key: string; status: "error"; descriptor: TextMaterialDescriptor; error: string };

interface CachedTextMaterial {
  descriptor: TextMaterialDescriptor;
  content: string;
}

const textMaterialCache = new Map<string, CachedTextMaterial>();

function cachedTextMaterial(key: string): CachedTextMaterial | undefined {
  const cached = textMaterialCache.get(key);
  if (!cached) return undefined;
  textMaterialCache.delete(key);
  textMaterialCache.set(key, cached);
  return cached;
}

function cacheTextMaterial(key: string, value: CachedTextMaterial): void {
  textMaterialCache.delete(key);
  textMaterialCache.set(key, value);
  while (textMaterialCache.size > MAX_CACHED_TEXT_MATERIALS) {
    const oldest = textMaterialCache.keys().next().value;
    if (oldest === undefined) break;
    textMaterialCache.delete(oldest);
  }
}

function descriptorFor(node: DesignNode, version?: DesignNodeVersion | null): TextMaterialDescriptor {
  const fileName = version?.fileName?.trim() || node.name.trim() || "Untitled file";
  const mimeType = version?.mimeType?.trim() || "";
  return {
    fileName,
    mimeType,
    bytes: version?.bytes ?? null,
    presentation: typedMaterialPresentation(fileName, mimeType),
  };
}

function textLoadError(problem: unknown): string {
  if (problem instanceof Error && problem.name === "AbortError") return "Loading stopped.";
  return problem instanceof Error ? problem.message : String(problem);
}

function useTextMaterial({
  api,
  projectId,
  node,
  versionId,
  url,
}: {
  api: DesignCanvasApi;
  projectId: string;
  node: DesignNode;
  versionId: string;
  url: string;
}): TextMaterialState {
  const key = `${projectId}:${node.id}:${versionId}:${url}`;
  const initialDescriptor = useMemo(() => descriptorFor(node), [node]);
  const metadata = useExactVersionMetadata({ api, projectId, nodeId: node.id, versionId });
  const [state, setState] = useState<TextMaterialState>(() => {
    const cached = cachedTextMaterial(key);
    return cached
      ? { key, status: "ready", ...cached }
      : { key, status: "loading", descriptor: initialDescriptor };
  });

  useEffect(() => {
    const cached = cachedTextMaterial(key);
    if (cached) {
      setState({ key, status: "ready", ...cached });
      return;
    }
    if (metadata.status === "idle" || metadata.status === "loading") {
      setState({ key, status: "loading", descriptor: initialDescriptor });
      return;
    }

    const controller = new AbortController();
    let active = true;
    const exactDescriptor = descriptorFor(node, metadata.metadata);
    setState({ key, status: "loading", descriptor: initialDescriptor });

    void (async () => {
      if (exactDescriptor.presentation.kind === "binary") {
        if (active) setState({ key, status: "binary", descriptor: exactDescriptor });
        return;
      }
      if (exactDescriptor.bytes !== null && exactDescriptor.bytes > MAX_INLINE_TEXT_BYTES) {
        throw new Error("This text file is too large to open inline. The exact revision is still available as a file.");
      }

      const response = await fetch(url, { signal: controller.signal, credentials: "same-origin" });
      if (!response.ok) throw new Error(`The exact file revision could not be read (${response.status}).`);
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_INLINE_TEXT_BYTES) {
        throw new Error("This text file is too large to open inline. The exact revision is still available as a file.");
      }
      const blob = await response.blob();
      if (blob.size > MAX_INLINE_TEXT_BYTES) {
        throw new Error("This text file is too large to open inline. The exact revision is still available as a file.");
      }
      const content = await blob.text();
      const measuredDescriptor = {
        ...exactDescriptor,
        bytes: Math.max(exactDescriptor.bytes ?? 0, blob.size),
      };
      const cachedValue = { descriptor: measuredDescriptor, content };
      cacheTextMaterial(key, cachedValue);
      if (active) setState({ key, status: "ready", ...cachedValue });
    })().catch((problem: unknown) => {
      if (!active || controller.signal.aborted) return;
      setState({ key, status: "error", descriptor: exactDescriptor, error: textLoadError(problem) });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [initialDescriptor, key, metadata.metadata, metadata.status, node, url]);

  if (state.key !== key) return { key, status: "loading", descriptor: initialDescriptor };
  return state;
}

function useEditorReveal(focusMotion: NodeFocusMotion | null): boolean {
  const source = focusMotion?.role === "source";
  const phase = focusMotion?.phase;
  const durationMs = focusMotion?.durationMs ?? 0;
  const [visible, setVisible] = useState(source && phase === "opening" && durationMs <= 0);

  useEffect(() => {
    if (!source || phase === "closing") {
      setVisible(false);
      return;
    }
    if (durationMs <= 0) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const timer = window.setTimeout(() => setVisible(true), durationMs + 16);
    return () => window.clearTimeout(timer);
  }, [durationMs, phase, source]);

  return visible;
}

function FileFallback({
  descriptor,
  url,
  detail,
}: {
  descriptor: TextMaterialDescriptor;
  url: string;
  detail: string;
}) {
  return (
    <div className="design-canvas-node__file-preview design-typed-material__fallback">
      <span className="design-canvas-node__file-icon"><FileText aria-hidden /></span>
      <div>
        <p>{descriptor.fileName}</p>
        <span>{detail}</span>
      </div>
      <a className="nodrag nopan" href={url} target="_blank" rel="noreferrer">
        Open file <ExternalLink aria-hidden />
      </a>
    </div>
  );
}

function HighlightedSource({
  content,
  presentation,
  className = "design-typed-material__highlight",
  elementRef,
  ariaHidden,
}: {
  content: string;
  presentation: TypedMaterialPresentation;
  className?: string;
  elementRef?: Ref<HTMLDivElement>;
  ariaHidden?: boolean;
}) {
  const language = presentation.language ?? "plaintext";
  const html = useMemo(
    () => typedMaterialHighlighter.highlight(content, { lang: language, lineNumbers: true }).html,
    [content, language],
  );
  return (
    <div
      ref={elementRef}
      className={className}
      aria-hidden={ariaHidden}
      // TanStack Highlight escapes source bytes and emits only its stable th-* token tree.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function LightweightTextPreview({ content, bytes }: { content: string; bytes: number }) {
  const preview = content.slice(0, MAX_RICH_TEXT_RENDER_BYTES);
  return (
    <div className="design-typed-material__lightweight">
      <p>{Math.ceil(bytes / 1024).toLocaleString()} KB file · rich rendering paused for canvas performance</p>
      <pre><code>{preview}</code></pre>
      {preview.length < content.length ? <span>Preview truncated. Open the Node to edit the complete exact revision.</span> : null}
    </div>
  );
}

export function TextEditor({
  descriptor,
  content,
  active,
  syntaxHighlighting = descriptor.presentation.kind === "code",
  onAppendMaterialVersion,
  viewerRef,
}: {
  descriptor: TextMaterialDescriptor;
  content: string;
  active: boolean;
  syntaxHighlighting?: boolean;
  onAppendMaterialVersion?: (file: File) => Promise<void>;
  viewerRef?: RefObject<HTMLDivElement | null>;
}) {
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const deferredDraft = useDeferredValue(draft);
  const changed = draft !== content;
  const editable = onAppendMaterialVersion !== undefined;

  useEffect(() => {
    if (!changed) setDraft(content);
  }, [changed, content]);

  useLayoutEffect(() => {
    if (!active) return;
    const textarea = textareaRef.current;
    const viewer = viewerRef?.current;
    if (!textarea || !viewer) return;
    textarea.scrollTop = viewer.scrollTop;
    textarea.scrollLeft = viewer.scrollLeft;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = viewer.scrollTop;
      highlightRef.current.scrollLeft = viewer.scrollLeft;
    }
  }, [active, viewerRef]);

  const save = async () => {
    if (!onAppendMaterialVersion || !changed || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const file = new File(
        [draft],
        descriptor.fileName,
        { type: descriptor.mimeType || "text/plain", lastModified: Date.now() },
      );
      await onAppendMaterialVersion(file);
    } catch (problem) {
      setSaveError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="design-typed-material__editor nodrag nopan nowheel"
      data-visible={active || undefined}
      aria-hidden={!active}
      inert={!active}
    >
      <header className="design-typed-material__editor-header">
        <div className="design-typed-material__identity">
          <Code2 aria-hidden />
          <span title={descriptor.fileName}>{descriptor.fileName}</span>
          <small>{displayLanguage(descriptor.presentation)}</small>
        </div>
        <div className="design-typed-material__editor-actions">
          {!editable ? <span className="design-typed-material__read-only">Read only</span> : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Revert changes"
            disabled={!changed || saving}
            onClick={() => {
              setDraft(content);
              setSaveError(null);
            }}
          >
            <RotateCcw aria-hidden />
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!editable || !changed || saving}
            onClick={() => void save()}
          >
            <Save aria-hidden />
            {saving ? "Saving…" : "Save revision"}
          </Button>
        </div>
      </header>
      <div className="design-typed-material__editor-code">
        {syntaxHighlighting ? (
          <HighlightedSource
            content={deferredDraft}
            presentation={descriptor.presentation}
            className="design-typed-material__editor-highlight"
            elementRef={highlightRef}
            ariaHidden
          />
        ) : null}
        <textarea
          ref={textareaRef}
          className="design-typed-material__textarea nodrag nopan nowheel"
          aria-label={`Edit ${descriptor.fileName}`}
          data-syntax-highlighted={syntaxHighlighting ? "true" : undefined}
          value={draft}
          readOnly={!editable}
          spellCheck={descriptor.presentation.kind === "markdown"}
          wrap={syntaxHighlighting ? "off" : "soft"}
          onChange={(event) => setDraft(event.target.value)}
          onScroll={(event) => {
            const highlight = highlightRef.current;
            if (highlight) {
              highlight.scrollTop = event.currentTarget.scrollTop;
              highlight.scrollLeft = event.currentTarget.scrollLeft;
            }
            const viewer = viewerRef?.current;
            if (viewer) {
              viewer.scrollTop = event.currentTarget.scrollTop;
              viewer.scrollLeft = event.currentTarget.scrollLeft;
            }
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "s") {
              event.preventDefault();
              void save();
            }
          }}
        />
      </div>
      {saveError ? <p className="design-typed-material__save-error" role="alert">{saveError}</p> : null}
    </section>
  );
}

export function TypedMaterialSurface({
  api,
  projectId,
  node,
  versionId,
  url,
  focusMotion,
  onAppendMaterialVersion,
}: {
  api: DesignCanvasApi;
  projectId: string;
  node: DesignNode;
  versionId: string;
  url: string;
  focusMotion: NodeFocusMotion | null;
  onAppendMaterialVersion?: (nodeId: string, file: File) => Promise<void>;
}) {
  const state = useTextMaterial({ api, projectId, node, versionId, url });
  const editorVisible = useEditorReveal(focusMotion);
  const viewerRef = useRef<HTMLDivElement | null>(null);

  if (state.status === "loading") {
    return <FileFallback descriptor={state.descriptor} url={url} detail="Reading the exact file revision…" />;
  }
  if (state.status === "binary") {
    return <FileFallback descriptor={state.descriptor} url={url} detail="This file keeps its original bytes and opens in its native viewer." />;
  }
  if (state.status === "error") {
    return <FileFallback descriptor={state.descriptor} url={url} detail={state.error} />;
  }
  const contentBytes = state.descriptor.bytes ?? new TextEncoder().encode(state.content).byteLength;
  const richRenderingAllowed = contentBytes <= MAX_RICH_TEXT_RENDER_BYTES;

  return (
    <div
      className="design-typed-material nodrag nopan"
      data-presentation={state.descriptor.presentation.kind}
      data-rich-rendering={richRenderingAllowed ? "enabled" : "paused"}
      data-editor-visible={editorVisible || undefined}
    >
      <div ref={viewerRef} className="design-typed-material__viewer">
        {!richRenderingAllowed ? (
          <LightweightTextPreview content={state.content} bytes={contentBytes} />
        ) : state.descriptor.presentation.kind === "markdown" ? (
          <Markdown className="design-typed-material__markdown">{state.content}</Markdown>
        ) : (
          <HighlightedSource content={state.content} presentation={state.descriptor.presentation} />
        )}
      </div>
      {focusMotion?.role === "source" ? (
        <TextEditor
          key={state.key}
          descriptor={state.descriptor}
          content={state.content}
          active={editorVisible}
          viewerRef={viewerRef}
          syntaxHighlighting={richRenderingAllowed && state.descriptor.presentation.kind === "code"}
          onAppendMaterialVersion={onAppendMaterialVersion
            ? (file) => onAppendMaterialVersion(node.id, file)
            : undefined}
        />
      ) : null}
    </div>
  );
}
