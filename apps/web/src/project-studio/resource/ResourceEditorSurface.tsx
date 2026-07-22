import "./resource-revision-viewer.css";

import {
  ArrowLeft,
  CheckCircle2,
  Code2,
  Download,
  FileArchive,
  Image as ImageIcon,
  LoaderCircle,
  Monitor,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useApi } from "../../lib/api-context.tsx";
import type {
  ApiClient,
  Resource,
  ResourceRevisionPreviewKind,
  ResourceRevisionView,
} from "../../lib/api.ts";
import { ResourceRevisionHistory } from "./ResourceRevisionHistory.tsx";

type ResourceEditorLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      resource: Resource;
      view: ResourceRevisionView | null;
      requestKey: string;
    };

export interface ResourceEditorController {
  resourceId: string | null;
  requestedRevisionId: string | null;
  load: ResourceEditorLoad;
  headRevisionId: string | null;
  pinned: boolean;
  retry: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "This Resource could not be opened.";
}

export function useResourceEditorController({
  projectId,
  workspaceId,
  resourceId,
  requestedRevisionId,
  activeRevisionId,
  activeSnapshotId,
}: {
  projectId: string;
  workspaceId: string | null;
  resourceId: string | null;
  requestedRevisionId: string | null;
  activeRevisionId: string | null;
  activeSnapshotId: string | null;
}): ResourceEditorController {
  const api = useApi();
  const requestKey = [
    projectId,
    workspaceId ?? "",
    resourceId ?? "",
    requestedRevisionId ?? "HEAD",
    activeRevisionId ?? "",
    activeSnapshotId ?? "",
  ].join("\0");
  const [load, setLoad] = useState<ResourceEditorLoad>(resourceId === null ? { status: "idle" } : { status: "loading" });
  const [retryEpoch, setRetryEpoch] = useState(0);
  const epochRef = useRef(0);

  useEffect(() => {
    const epoch = ++epochRef.current;
    if (resourceId === null) {
      setLoad({ status: "idle" });
      return;
    }
    setLoad({ status: "loading" });
    const readExact = async (attempt = 0): Promise<{ resource: Resource; view: ResourceRevisionView | null }> => {
      const resource = await api.getResource(projectId, resourceId);
      if (resource.id !== resourceId || (workspaceId !== null && resource.workspaceId !== workspaceId)) {
        throw new Error("Resource identity does not match the active workspace.");
      }
      const revisionId = requestedRevisionId ?? resource.headRevisionId;
      if (revisionId === null) return { resource, view: null };
      const view = await api.getResourceRevisionView(projectId, resourceId, revisionId);
      if (view.resource.id !== resource.id
        || view.resource.workspaceId !== resource.workspaceId
        || view.resource.kind !== resource.kind
        || view.revision.id !== revisionId
        || view.revision.resourceId !== resource.id) {
        throw new Error("Resource Revision identity changed while it was loading.");
      }
      if (requestedRevisionId === null && view.observed.headRevisionId !== revisionId) {
        if (attempt === 0) return readExact(1);
        throw new Error("Current Head changed while it was opening. Try again.");
      }
      if (view.resource.headRevisionId !== view.observed.headRevisionId) {
        throw new Error("Resource Revision identity changed while it was loading.");
      }
      if ((activeRevisionId !== null && view.observed.headRevisionId !== activeRevisionId)
        || (activeSnapshotId !== null && view.observed.snapshotId !== activeSnapshotId)) {
        if (attempt === 0) return readExact(1);
        throw new Error("Resource observation no longer matches the active Workspace.");
      }
      return { resource: view.resource, view };
    };
    void readExact().then(({ resource, view }) => {
      if (epoch === epochRef.current) setLoad({ status: "ready", resource, view, requestKey });
    }).catch((error: unknown) => {
      if (epoch === epochRef.current) setLoad({ status: "error", message: errorMessage(error) });
    });
    return () => {
      if (epoch === epochRef.current) epochRef.current += 1;
    };
  }, [
    activeRevisionId,
    activeSnapshotId,
    api,
    projectId,
    requestKey,
    requestedRevisionId,
    retryEpoch,
    resourceId,
    workspaceId,
  ]);

  const currentLoad: ResourceEditorLoad = load.status === "ready" && load.requestKey !== requestKey
    ? { status: "loading" }
    : load;

  return {
    resourceId,
    requestedRevisionId,
    load: currentLoad,
    headRevisionId: currentLoad.status === "ready" ? currentLoad.resource.headRevisionId : null,
    pinned: requestedRevisionId !== null,
    retry: () => setRetryEpoch((value) => value + 1),
  };
}

function PayloadMedia({
  kind,
  url,
  label,
  width,
  height,
}: {
  kind: ResourceRevisionPreviewKind;
  url: string | null;
  label: string;
  width?: number | null;
  height?: number | null;
}) {
  const [attempt, setAttempt] = useState(0);
  const { targetRef, visible } = useNearViewport();
  const blob = useAuthenticatedBlobUrl(url, attempt, visible);
  if (url === null) return null;
  if (!visible) {
    return <span ref={targetRef} className="dezin-revision-media__state" role="status">Exact media waits until it is near the viewport.</span>;
  }
  if (blob.status === "loading" || blob.status === "idle") {
    return <p className="dezin-revision-media__state" role="status"><LoaderCircle aria-hidden size={14} /> Loading exact media…</p>;
  }
  if (blob.status === "error") {
    return (
      <p className="dezin-revision-media__state" role="alert">
        <span>Exact media unavailable · {blob.message}</span>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry exact media</button>
      </p>
    );
  }
  if (kind === "image") {
    return (
      <img
        className="dezin-revision-media__image"
        src={blob.url}
        alt={label}
        loading="lazy"
        decoding="async"
        {...(width === null || width === undefined ? {} : { width })}
        {...(height === null || height === undefined ? {} : { height })}
      />
    );
  }
  if (kind === "video") return <video className="dezin-revision-media__video" src={blob.url} controls preload="metadata" />;
  if (kind === "audio") return <audio className="dezin-revision-media__audio" src={blob.url} controls preload="metadata" />;
  if (kind === "pdf") {
    return <iframe className="dezin-revision-media__pdf" src={blob.url} title={`${label} PDF`} sandbox="allow-same-origin" />;
  }
  return null;
}

type AuthenticatedBlobState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; message: string };

interface AuthenticatedBlobEntry {
  path: string;
  attempt: number;
  refs: number;
  state: AuthenticatedBlobState;
  controller: AbortController | null;
  listeners: Set<(state: AuthenticatedBlobState) => void>;
}

const authenticatedBlobCache = new WeakMap<ApiClient, Map<string, AuthenticatedBlobEntry>>();

function notifyAuthenticatedBlobEntry(entry: AuthenticatedBlobEntry): void {
  for (const listener of entry.listeners) listener(entry.state);
}

function disposeAuthenticatedBlobEntry(entry: AuthenticatedBlobEntry): void {
  entry.controller?.abort();
  entry.controller = null;
  if (entry.state.status === "ready" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(entry.state.url);
  }
}

function loadAuthenticatedBlobEntry(api: ApiClient, entry: AuthenticatedBlobEntry): void {
  disposeAuthenticatedBlobEntry(entry);
  const controller = new AbortController();
  entry.controller = controller;
  entry.state = { status: "loading" };
  notifyAuthenticatedBlobEntry(entry);
  void api.getResourceRevisionBlob(entry.path, controller.signal).then((blob) => {
    if (controller.signal.aborted || entry.controller !== controller) return;
    if (typeof URL.createObjectURL !== "function") throw new Error("Blob URLs are unavailable in this browser");
    const objectUrl = URL.createObjectURL(blob);
    if (controller.signal.aborted || entry.controller !== controller) {
      if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(objectUrl);
      return;
    }
    entry.state = { status: "ready", url: objectUrl };
    notifyAuthenticatedBlobEntry(entry);
  }).catch((error: unknown) => {
    if (controller.signal.aborted || entry.controller !== controller) return;
    entry.state = { status: "error", message: errorMessage(error) };
    notifyAuthenticatedBlobEntry(entry);
  });
}

function subscribeAuthenticatedBlob(
  api: ApiClient,
  path: string,
  attempt: number,
  listener: (state: AuthenticatedBlobState) => void,
): () => void {
  let entries = authenticatedBlobCache.get(api);
  if (!entries) {
    entries = new Map();
    authenticatedBlobCache.set(api, entries);
  }
  let entry = entries.get(path);
  if (!entry) {
    entry = {
      path,
      attempt,
      refs: 0,
      state: { status: "loading" },
      controller: null,
      listeners: new Set(),
    };
    entries.set(path, entry);
    loadAuthenticatedBlobEntry(api, entry);
  } else if (attempt > entry.attempt) {
    entry.attempt = attempt;
    loadAuthenticatedBlobEntry(api, entry);
  }
  entry.refs += 1;
  entry.listeners.add(listener);
  listener(entry.state);
  return () => {
    entry!.listeners.delete(listener);
    entry!.refs = Math.max(0, entry!.refs - 1);
    if (entry!.refs > 0) return;
    if (entries!.get(path) === entry) entries!.delete(path);
    disposeAuthenticatedBlobEntry(entry!);
  };
}

function useNearViewport() {
  const targetRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const target = targetRef.current;
    if (!target) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "240px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [visible]);

  return { targetRef, visible };
}

function useAuthenticatedBlobUrl(path: string | null, attempt = 0, enabled = true): AuthenticatedBlobState {
  const api = useApi();
  const [state, setState] = useState<AuthenticatedBlobState>(path === null || !enabled
    ? { status: "idle" }
    : { status: "loading" });

  useEffect(() => {
    if (path === null || !enabled) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    return subscribeAuthenticatedBlob(api, path, attempt, setState);
  }, [api, attempt, enabled, path]);

  return state;
}

function AuthenticatedImage({
  path,
  alt,
  width,
  height,
}: {
  path: string;
  alt: string;
  width?: number | null;
  height?: number | null;
}) {
  const [attempt, setAttempt] = useState(0);
  const { targetRef, visible } = useNearViewport();
  const blob = useAuthenticatedBlobUrl(path, attempt, visible);
  if (!visible) {
    return <span ref={targetRef} className="dezin-revision-image-state" role="status">Exact image waits until it is near the viewport.</span>;
  }
  if (blob.status === "loading" || blob.status === "idle") {
    return <span className="dezin-revision-image-state" role="status">Loading exact image…</span>;
  }
  if (blob.status === "error") {
    return (
      <span className="dezin-revision-image-state" role="alert">
        <span>Image unavailable · {blob.message}</span>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry exact image</button>
      </span>
    );
  }
  return (
    <img
      src={blob.url}
      alt={alt}
      loading="lazy"
      decoding="async"
      {...(width === null || width === undefined ? {} : { width })}
      {...(height === null || height === undefined ? {} : { height })}
    />
  );
}

function TextDocument({ text, truncated }: { text: string | null; truncated: boolean }) {
  return text === null ? null : (
    <div className="dezin-revision-text">
      <pre>{text}</pre>
      {truncated ? <p>Preview truncated. Download the exact payload to inspect the complete file.</p> : null}
    </div>
  );
}

function AuthenticatedDownload({ path, fileName }: { path: string; fileName: string }) {
  const [requested, setRequested] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const downloadedUrlRef = useRef<string | null>(null);
  const blob = useAuthenticatedBlobUrl(requested ? path : null, attempt);

  useEffect(() => {
    if (!requested || blob.status !== "ready" || downloadedUrlRef.current === blob.url) return;
    downloadedUrlRef.current = blob.url;
    anchorRef.current?.click();
  }, [blob, requested]);

  if (blob.status === "ready") {
    return (
      <>
        <a ref={anchorRef} href={blob.url} download={fileName} hidden aria-hidden tabIndex={-1} />
        <button type="button" onClick={() => anchorRef.current?.click()}>
          <Download aria-hidden size={12} /> Download again
        </button>
      </>
    );
  }
  if (blob.status === "error") {
    return (
      <span className="dezin-revision-payload__download-error" role="alert">
        Download unavailable · {blob.message}
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
      </span>
    );
  }
  return (
    <button type="button" disabled={blob.status === "loading"} onClick={() => setRequested(true)}>
      {blob.status === "loading" ? <LoaderCircle aria-hidden size={12} /> : <Download aria-hidden size={12} />}
      {blob.status === "loading" ? "Preparing exact payload…" : "Download exact payload"}
    </button>
  );
}

function PayloadFooter({ view }: { view: ResourceRevisionView }) {
  return (
    <footer className="dezin-revision-payload">
      <span>{view.payload.mimeType}</span>
      <span>{view.payload.byteLength.toLocaleString()} bytes</span>
      <code title={view.payload.checksum}>{view.payload.checksum.slice(0, 12)}…</code>
      <AuthenticatedDownload path={view.payload.downloadUrl} fileName={`resource-revision-${view.revision.id}`} />
    </footer>
  );
}

type MoodboardNode = Extract<ResourceRevisionView, { kind: "moodboard" }>["content"]["nodes"][number];

function moodboardSpatialLayout(nodes: readonly MoodboardNode[]) {
  const positioned = nodes.filter((node): node is MoodboardNode & {
    x: number;
    y: number;
    width: number;
    height: number;
  } => node.x !== null && node.y !== null && node.width !== null && node.height !== null
    && node.width > 0 && node.height > 0);
  if (positioned.length === 0) return null;
  const minX = Math.min(...positioned.map((node) => node.x));
  const minY = Math.min(...positioned.map((node) => node.y));
  const maxX = Math.max(...positioned.map((node) => node.x + node.width));
  const maxY = Math.max(...positioned.map((node) => node.y + node.height));
  return {
    nodes: positioned,
    minX,
    minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function MoodboardNodeCard({
  node,
  asset,
}: {
  node: MoodboardNode;
  asset: Extract<ResourceRevisionView, { kind: "moodboard" }>["content"]["assets"][number] | null;
}) {
  return (
    <article key={node.id} data-node-id={node.id} data-node-type={node.type}>
      {asset?.url ? (
        <AuthenticatedImage
          path={asset.url}
          alt={node.label || asset.fileName}
          width={asset.width}
          height={asset.height}
        />
      ) : null}
      <div>
        <span>{node.type}</span>
        {node.label ? <strong>{node.label}</strong> : null}
        {node.text ? <p>{node.text}</p> : null}
      </div>
    </article>
  );
}

function MoodboardView({ view }: { view: Extract<ResourceRevisionView, { kind: "moodboard" }> }) {
  const assetById = new Map(view.content.assets.map((asset) => [asset.id, asset]));
  const layout = moodboardSpatialLayout(view.content.nodes);
  const positionedIds = new Set(layout?.nodes.map((node) => node.id) ?? []);
  const unpositioned = view.content.nodes.filter((node) => !positionedIds.has(node.id));
  return (
    <section className="dezin-moodboard" aria-label={`${view.content.board.name} Moodboard`}>
      <div className="dezin-moodboard__masthead">
        <span>Moodboard / {view.content.totalNodeCount} nodes</span>
        <h2>{view.content.board.name}</h2>
      </div>
      {layout === null ? null : (
        <svg
          className="dezin-moodboard__canvas"
          viewBox={`${layout.minX} ${layout.minY} ${layout.width} ${layout.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label={`${view.content.board.name} spatial composition`}
        >
          <title>{view.content.board.name} spatial composition</title>
          {layout.nodes.map((node) => {
            const asset = node.assetId === null ? null : assetById.get(node.assetId) ?? null;
            return (
              <foreignObject
                key={node.id}
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
                data-node-id={node.id}
                data-node-type={node.type}
              >
                <MoodboardNodeCard node={node} asset={asset} />
              </foreignObject>
            );
          })}
        </svg>
      )}
      {unpositioned.length > 0 ? <div className="dezin-moodboard__fallback">
        {unpositioned.map((node) => {
          const asset = node.assetId === null ? null : assetById.get(node.assetId) ?? null;
          return <MoodboardNodeCard key={node.id} node={node} asset={asset} />;
        })}
      </div> : null}
      {view.content.nodesTruncated || view.content.assetsTruncated ? (
        <p className="dezin-revision-note">The bounded viewer shows a safe subset; the exact bundle remains available below.</p>
      ) : null}
    </section>
  );
}

function SharinganView({ view }: { view: Extract<ResourceRevisionView, { kind: "sharingan-capture" }> }) {
  return (
    <section className="dezin-capture" aria-label="Sharingan capture">
      <header>
        <span>Captured {new Date(view.content.source.capturedAt).toLocaleString()}</span>
        <code>{view.content.source.finalUrl}</code>
      </header>
      {view.content.pages.map((page, index) => (
        <article key={`${page.finalUrl}:${index}`}>
          <div className="dezin-capture__page-head">
            <div><span>Page {index + 1}</span><h2>{page.title}</h2></div>
            <dl>
              <div><dt>Viewport</dt><dd>{page.viewport.width} × {page.viewport.height}</dd></div>
              <div><dt>Document</dt><dd>{page.document.width} × {page.document.height}</dd></div>
              <div><dt>DOM</dt><dd>{page.dom.nodeCount.toLocaleString()} nodes</dd></div>
            </dl>
          </div>
          <div className="dezin-capture__screens">
            {page.screenshots.map((shot) => (
              <figure key={shot.id}>
                <AuthenticatedImage path={shot.url} alt={shot.label} width={shot.width} height={shot.height} />
                <figcaption>{shot.label} · {shot.width} × {shot.height}</figcaption>
              </figure>
            ))}
          </div>
          <div className="dezin-capture__tokens">
            <div><span>Colors</span><p>{page.styleTokens.colors.map((color) => <i key={color} style={{ backgroundColor: color }} title={color} />)}</p></div>
            <div><span>Type</span><p>{page.styleTokens.fontFamilies.join(" · ") || "None captured"}</p></div>
            <div><span>DOM tags</span><p>{page.dom.tags.join(" · ")}</p></div>
            <div><span>Links</span><p>{page.links.length.toLocaleString()} captured destinations</p></div>
          </div>
        </article>
      ))}
    </section>
  );
}

function EffectView({ view }: { view: Extract<ResourceRevisionView, { kind: "effect" }> }) {
  return (
    <section className="dezin-effect" aria-label={`${view.content.definition.name} Effect`}>
      <div className="dezin-effect__stage">
        <div aria-label="Declarative Effect fixture">
          <Monitor aria-hidden size={22} />
          <strong>{view.content.fixture.width} × {view.content.fixture.height}</strong>
          <span>Static fixture · 0 / 500 / 1000 ms</span>
        </div>
      </div>
      <aside>
        <span>{view.content.definition.origin} / {view.content.definition.category}</span>
        <h2>{view.content.definition.name}</h2>
        <p>{view.content.definition.summary}</p>
        <div className="dezin-effect__parameters">
          {view.content.definition.parameters.map((parameter) => (
            <label key={parameter.id}>
              <span>{parameter.label}</span>
              {parameter.type === "boolean" ? (
                <output aria-label={`${parameter.label} frozen value`}>
                  {Boolean(view.content.fixture.values[parameter.id] ?? parameter.defaultValue) ? "On" : "Off"}
                </output>
              ) : parameter.type === "select" ? (
                <select value={String(view.content.fixture.values[parameter.id] ?? parameter.defaultValue)} disabled>
                  {parameter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : (
                <output>{String(view.content.fixture.values[parameter.id] ?? parameter.defaultValue)}</output>
              )}
            </label>
          ))}
        </div>
        <details className="dezin-effect__code">
          <summary><Code2 aria-hidden size={12} /> Frozen source (never executed)</summary>
          <pre>{view.content.definition.code}</pre>
        </details>
      </aside>
    </section>
  );
}

function FileOrAssetView({ view }: { view: Extract<ResourceRevisionView, { kind: "file" | "asset" }> }) {
  const previewKind = view.kind === "file" ? view.content.previewKind : view.content.mediaKind;
  return (
    <section className="dezin-revision-media" aria-label={`${view.content.fileName} preview`}>
      <PayloadMedia
        kind={previewKind}
        url={view.payload.url}
        label={view.content.fileName}
        width={view.kind === "asset" ? view.content.width : null}
        height={view.kind === "asset" ? view.content.height : null}
      />
      <TextDocument text={view.content.text} truncated={view.content.textTruncated} />
      {previewKind === "download" ? (
        <div className="dezin-revision-media__download">
          <FileArchive aria-hidden size={26} />
          <strong>{view.content.fileName}</strong>
          <span>No safe inline preview is available for this format.</span>
        </div>
      ) : null}
      {view.kind === "asset" ? (
        <dl className="dezin-revision-media__facts">
          <div><dt>Source</dt><dd>{view.content.sourceType} / {view.content.sourceId}</dd></div>
          {view.content.width !== null && view.content.height !== null ? (
            <div><dt>Dimensions</dt><dd>{view.content.width} × {view.content.height}</dd></div>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}

function ExternalReferenceView({ view }: { view: Extract<ResourceRevisionView, { kind: "external-reference" }> }) {
  return (
    <section className="dezin-external" aria-label="Frozen external reference">
      <header>
        <span><CheckCircle2 aria-hidden size={13} /> Frozen response · HTTP {view.content.status}</span>
        <dl>
          <div><dt>Requested</dt><dd>{view.content.sourceUrl}</dd></div>
          <div><dt>Final</dt><dd>{view.content.finalUrl}</dd></div>
        </dl>
      </header>
      <PayloadMedia kind={view.content.previewKind} url={view.payload.url} label="Frozen external reference" />
      <TextDocument text={view.content.text} truncated={view.content.textTruncated} />
      {view.content.previewKind === "download" ? (
        <div className="dezin-revision-media__download">
          <FileArchive aria-hidden size={26} />
          <strong>Frozen external payload</strong>
          <span>The original URL is shown as identity only and is never embedded.</span>
        </div>
      ) : null}
    </section>
  );
}

export function ResourceRevisionBody({ view }: { view: ResourceRevisionView }) {
  let body: React.ReactNode;
  switch (view.kind) {
    case "moodboard": body = <MoodboardView view={view} />; break;
    case "sharingan-capture": body = <SharinganView view={view} />; break;
    case "effect": body = <EffectView view={view} />; break;
    case "file":
    case "asset": body = <FileOrAssetView view={view} />; break;
    case "external-reference": body = <ExternalReferenceView view={view} />; break;
    case "research": body = <p className="dezin-revision-note">Open this Revision in the Research decision viewer.</p>; break;
  }
  return <>{body}<PayloadFooter view={view} /></>;
}

export function ResourceEditorSurface({
  editor,
  projectId,
  onBack,
  onOpenRevision,
  onReturnToHead,
}: {
  editor: ResourceEditorController;
  projectId: string;
  onBack: () => void;
  onOpenRevision: (revisionId: string) => void;
  onReturnToHead: () => void;
}) {
  if (editor.load.status === "idle" || editor.load.status === "loading") {
    return (
      <section role="status" aria-label="Resource editor" className="dezin-resource-viewer dezin-resource-viewer--state">
        <LoaderCircle aria-hidden />
        <strong>Opening immutable Resource</strong>
        <span>Verifying the exact Revision payload…</span>
      </section>
    );
  }
  if (editor.load.status === "error") {
    return (
      <section role="alert" aria-label="Resource editor" className="dezin-resource-viewer dezin-resource-viewer--state">
        <FileArchive aria-hidden />
        <strong>Resource unavailable</strong>
        <span>{editor.load.message}</span>
        <button type="button" onClick={editor.retry}>Try again</button>
        <button type="button" onClick={onBack}>Back to canvas</button>
      </section>
    );
  }

  const { resource, view } = editor.load;
  return (
    <section role="region" aria-label="Resource editor" className="dezin-resource-viewer">
      <header className="dezin-resource-viewer__header">
        <button type="button" aria-label="Back to project canvas" className="dezin-resource-viewer__back" onClick={onBack}>
          <ArrowLeft aria-hidden size={15} />
        </button>
        <div className="dezin-resource-viewer__identity">
          <span>{resource.kind.replaceAll("-", " ")} / immutable resource</span>
          <h1>{resource.title}</h1>
        </div>
        <ResourceRevisionHistory
          projectId={projectId}
          resourceId={resource.id}
          current={view?.revision ?? null}
          headRevisionId={resource.headRevisionId}
          pinned={editor.pinned}
          onOpenRevision={onOpenRevision}
          onReturnToHead={onReturnToHead}
        />
      </header>
      {view === null ? (
        <div className="dezin-resource-viewer__empty">
          <ImageIcon aria-hidden size={26} />
          <strong>Awaiting the first immutable Revision</strong>
          <span>This Resource has an identity, but no published payload yet.</span>
        </div>
      ) : (
        <div className="dezin-resource-viewer__scroll">
          <div className="dezin-resource-viewer__document">
            <div className="dezin-resource-viewer__revision-title">
              <span>Revision {view.revision.sequence}</span>
              <h2>{view.revision.summary}</h2>
              <time dateTime={new Date(view.revision.createdAt).toISOString()}>{new Date(view.revision.createdAt).toLocaleString()}</time>
            </div>
            <ResourceRevisionBody view={view} />
          </div>
        </div>
      )}
    </section>
  );
}

export function ResourceInspector({ editor }: { editor: ResourceEditorController }) {
  const ready = editor.load.status === "ready" ? editor.load : null;
  const view = ready?.view ?? null;
  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="resource-inspector-title">
      <header className="app-drag titlebar-pad-right flex h-11 shrink-0 items-center border-b border-border px-3.5">
        <div><h2 id="resource-inspector-title" className="text-xs font-medium text-foreground">Resource</h2><p className="mt-0.5 text-[10px] text-muted-foreground">Exact Revision facts</p></div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {ready === null ? <p className="text-[10px] text-muted-foreground">Resource identity is loading…</p> : (
          <dl className="space-y-3 text-[10px]">
            <div><dt className="text-muted-foreground">Resource</dt><dd className="mt-1 break-all font-mono text-foreground">{ready.resource.id}</dd></div>
            <div><dt className="text-muted-foreground">Revision</dt><dd className="mt-1 break-all font-mono text-foreground">{view?.revision.id ?? "None"}</dd></div>
            <div><dt className="text-muted-foreground">Viewing</dt><dd className="mt-1 text-foreground">{editor.pinned ? "Pinned immutable Revision" : "Current Head"}</dd></div>
            {view ? <><div><dt className="text-muted-foreground">MIME</dt><dd className="mt-1 text-foreground">{view.payload.mimeType}</dd></div><div><dt className="text-muted-foreground">Checksum</dt><dd className="mt-1 break-all font-mono text-foreground">{view.payload.checksum}</dd></div></> : null}
          </dl>
        )}
      </div>
    </section>
  );
}
