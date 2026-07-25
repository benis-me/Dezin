import { ChevronDown, History, LoaderCircle, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/index.ts";
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
  const statusDescriptionId = useId();
  const epochRef = useRef(0);
  const openRef = useRef(false);
  const [open, setOpen] = useState(false);
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
    if (openRef.current) void load(null, epoch);
  }, [current?.id, headRevisionId, load, projectId, resourceId]);

  const statusLabel = current === null
    ? "Awaiting first Revision"
    : pinned
      ? `Pinned · Revision ${current.sequence}`
      : `Current Head · Revision ${current.sequence}`;

  return (
    <div className={["dezin-resource-history", className].filter(Boolean).join(" ")}>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          openRef.current = nextOpen;
          setOpen(nextOpen);
          if (nextOpen && status === "idle") void load(null);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="dezin-resource-history__trigger"
            aria-label="Open Resource Revision history"
            aria-describedby={statusDescriptionId}
          >
            <span id={statusDescriptionId} className="sr-only">
              Current Resource checkout: {statusLabel}
            </span>
            <span data-pinned={pinned || undefined}>{statusLabel}</span>
            <ChevronDown aria-hidden size={13} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="dezin-resource-history__menu"
          aria-label="Resource Revision history"
        >
          <div className="dezin-resource-history__heading">
            <span><History aria-hidden size={12} /> Immutable history</span>
            {pinned && headRevisionId !== null ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  openRef.current = false;
                  setOpen(false);
                  onReturnToHead();
                }}
              >
                <RotateCcw aria-hidden size={11} /> Return to Head
              </Button>
            ) : null}
          </div>

          {status === "loading" && items.length === 0 ? (
            <p
              className="dezin-resource-history__state"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <LoaderCircle aria-hidden size={13} /> Loading 20 newest Revisions…
            </p>
          ) : null}
          {items.length > 0 ? (
            <ol className="dezin-resource-history__list">
              {items.map((revision) => {
                const active = revision.id === current?.id;
                return (
                  <li key={revision.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-current={active ? "page" : undefined}
                      onClick={() => {
                        openRef.current = false;
                        setOpen(false);
                        onOpenRevision(revision.id);
                      }}
                    >
                      <span>
                        <strong>Revision {revision.sequence}</strong>
                        {revision.id === headRevisionId ? <i>Head</i> : null}
                      </span>
                      <small>{revision.summary}</small>
                      <time dateTime={new Date(revision.createdAt).toISOString()}>
                        {new Date(revision.createdAt).toLocaleString()}
                      </time>
                    </Button>
                  </li>
                );
              })}
            </ol>
          ) : null}
          {status === "error" ? (
            <div className="dezin-resource-history__error" role="alert">
              <span>{error}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void load(items.length === 0 ? null : nextCursor)}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {status === "ready" && items.length === 0 ? (
            <p className="dezin-resource-history__state">No immutable Revisions yet.</p>
          ) : null}
          {items.length > 0 && nextCursor !== null && status !== "error" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="dezin-resource-history__older"
              disabled={status === "loading"}
              onClick={() => void load(nextCursor)}
            >
              {status === "loading" ? <LoaderCircle aria-hidden size={12} /> : null}
              {status === "loading" ? "Loading older…" : "Load older Revisions"}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
