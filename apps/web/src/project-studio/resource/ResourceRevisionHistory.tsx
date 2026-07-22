import { ChevronDown, History, LoaderCircle, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useApi } from "../../lib/api-context.tsx";
import type { ResourceRevision, ResourceRevisionViewIdentity } from "../../lib/api.ts";

type HistoryStatus = "idle" | "loading" | "ready" | "error";

function messageFor(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Revision history is unavailable.";
}

export function ResourceRevisionHistory({
  className,
  projectId,
  resourceId,
  current,
  headRevisionId,
  pinned,
  onOpenRevision,
  onReturnToHead,
}: {
  className?: string;
  projectId: string;
  resourceId: string;
  current: ResourceRevisionViewIdentity | null;
  headRevisionId: string | null;
  pinned: boolean;
  onOpenRevision: (revisionId: string) => void;
  onReturnToHead: () => void;
}) {
  const api = useApi();
  const epochRef = useRef(0);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [status, setStatus] = useState<HistoryStatus>("idle");
  const [items, setItems] = useState<ResourceRevision[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (
    cursor: string | null,
    epoch = epochRef.current,
  ): Promise<void> => {
    setStatus("loading");
    setError(null);
    try {
      const page = await api.listResourceRevisionHistory(projectId, resourceId, {
        limit: 20,
        ...(cursor === null ? {} : { cursor }),
      });
      if (epoch !== epochRef.current) return;
      if (page.items.some((revision) => revision.resourceId !== resourceId)) {
        throw new Error("Revision history identity does not match this Resource.");
      }
      setItems((existing) => {
        const merged = cursor === null ? page.items : [...existing, ...page.items];
        return [...new Map(merged.map((revision) => [revision.id, revision])).values()];
      });
      setNextCursor(page.nextCursor);
      setStatus("ready");
    } catch (cause) {
      if (epoch !== epochRef.current) return;
      setError(messageFor(cause));
      setStatus("error");
    }
  }, [api, projectId, resourceId]);

  useEffect(() => {
    const epoch = ++epochRef.current;
    setStatus("idle");
    setItems([]);
    setNextCursor(null);
    setError(null);
    if (detailsRef.current?.open) void load(null, epoch);
  }, [current?.id, headRevisionId, load, projectId, resourceId]);

  const statusLabel = current === null
    ? "Awaiting first Revision"
    : pinned
      ? `Pinned · Revision ${current.sequence}`
      : `Current Head · Revision ${current.sequence}`;

  return (
    <div className={["dezin-resource-history", className].filter(Boolean).join(" ")}>
      <details
        ref={detailsRef}
        onToggle={(event) => {
          if (event.currentTarget.open && status === "idle") void load(null);
        }}
      >
        <summary aria-label="Open Resource Revision history">
          <span data-pinned={pinned || undefined}>{statusLabel}</span>
          <ChevronDown aria-hidden size={13} />
        </summary>
        <div className="dezin-resource-history__menu">
          <div className="dezin-resource-history__heading">
            <span><History aria-hidden size={12} /> Immutable history</span>
            {pinned && headRevisionId !== null ? (
              <button type="button" onClick={onReturnToHead}>
                <RotateCcw aria-hidden size={11} /> Return to Head
              </button>
            ) : null}
          </div>

          {status === "loading" && items.length === 0 ? (
            <p className="dezin-resource-history__state"><LoaderCircle aria-hidden size={13} /> Loading 20 newest Revisions…</p>
          ) : null}
          {items.length > 0 ? (
            <ol className="dezin-resource-history__list">
              {items.map((revision) => {
                const active = revision.id === current?.id;
                return (
                  <li key={revision.id}>
                    <button
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => onOpenRevision(revision.id)}
                    >
                      <span>
                        <strong>Revision {revision.sequence}</strong>
                        {revision.id === headRevisionId ? <i>Head</i> : null}
                      </span>
                      <small>{revision.summary}</small>
                      <time dateTime={new Date(revision.createdAt).toISOString()}>
                        {new Date(revision.createdAt).toLocaleString()}
                      </time>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : null}
          {status === "error" ? (
            <div className="dezin-resource-history__error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void load(items.length === 0 ? null : nextCursor)}>Retry</button>
            </div>
          ) : null}
          {status === "ready" && items.length === 0 ? (
            <p className="dezin-resource-history__state">No immutable Revisions yet.</p>
          ) : null}
          {items.length > 0 && nextCursor !== null && status !== "error" ? (
            <button
              type="button"
              className="dezin-resource-history__older"
              disabled={status === "loading"}
              onClick={() => void load(nextCursor)}
            >
              {status === "loading" ? <LoaderCircle aria-hidden size={12} /> : null}
              {status === "loading" ? "Loading older…" : "Load older Revisions"}
            </button>
          ) : null}
        </div>
      </details>
    </div>
  );
}
