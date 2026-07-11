import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { useToast } from "../components/Toast.tsx";
import type { SharinganStep, SharinganPage, SharinganPhase, SharinganStatus } from "../lib/api.ts";

const SHARINGAN_LOG_LIMIT = 500;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function SharinganTab({ projectId, sourceUrl }: { projectId: string; sourceUrl: string }) {
  const api = useApi();
  const { toast } = useToast();
  const [phase, setPhase] = useState<SharinganPhase>("idle");
  const [log, setLog] = useState<SharinganStep[]>([]);
  const [pages, setPages] = useState<SharinganPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"starting" | "cancelling" | null>(null);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [streamFailed, setStreamFailed] = useState(false);
  const started = useRef(false);

  const applyStatus = useCallback((status: SharinganStatus) => {
    setPhase(status.phase);
    setPages(status.pages);
    setError(status.error ?? (status.phase === "error" ? "Capture failed." : null));
    if (status.phase === "captured" || status.phase === "cancelled" || status.phase === "error") setStreamFailed(false);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    const refreshStatus = async () => {
      try {
        const status = await api.sharinganStatus(projectId);
        if (alive) applyStatus(status);
        return status;
      } catch (statusError) {
        if (alive) setError(errorMessage(statusError, "Couldn't read the capture status."));
        return null;
      }
    };
    (async () => {
      const s = await refreshStatus();
      if (alive && s && s.phase === "idle" && !started.current) {
        started.current = true;
        setPendingAction("starting");
        try {
          await api.startSharingan(projectId, sourceUrl);
          if (alive) { setPhase("capturing"); setError(null); }
        } catch (startError) {
          if (alive) {
            setPhase("error");
            setError(errorMessage(startError, "Couldn't start the capture."));
            toast("Couldn't start the capture.", { variant: "error" });
          }
        } finally {
          if (alive) setPendingAction(null);
        }
      }
    })();
    (async () => {
      try {
        for await (const step of api.streamSharinganEvents(projectId, ac.signal)) {
          if (!alive) return;
          setStreamFailed(false);
          setLog((current) => [...current, step].slice(-SHARINGAN_LOG_LIMIT));
          if (step.kind === "login-required") setPhase("login-required");
          if (step.kind === "done") await refreshStatus();
        }
      } catch (streamError) {
        if (alive && !ac.signal.aborted && !isAbortError(streamError)) {
          setStreamFailed(true);
          setError(errorMessage(streamError, "Capture event stream failed."));
        }
      }
    })();
    return () => { alive = false; ac.abort(); };
  }, [api, applyStatus, projectId, sourceUrl, streamGeneration, toast]);

  const recapture = async () => {
    if (pendingAction) return;
    started.current = true;
    setPendingAction("starting");
    setStreamFailed(false);
    setError(null);
    setLog([]);
    setPages([]);
    try {
      await api.startSharingan(projectId, sourceUrl);
      setPhase("capturing");
      setStreamGeneration((generation) => generation + 1);
    } catch (startError) {
      setPhase("error");
      setError(errorMessage(startError, "Couldn't start the capture."));
      toast("Couldn't start the capture.", { variant: "error" });
    } finally {
      setPendingAction(null);
    }
  };

  const cancel = async () => {
    if (pendingAction) return;
    setPendingAction("cancelling");
    setStreamFailed(false);
    setError(null);
    try {
      await api.cancelSharingan(projectId);
      const status = await api.sharinganStatus(projectId);
      applyStatus(status);
      setLog([]);
    } catch (cancelError) {
      setError(errorMessage(cancelError, "Couldn't cancel the capture."));
      toast("Couldn't cancel the capture.", { variant: "error" });
    } finally {
      setPendingAction(null);
    }
  };

  const reconnect = () => {
    if (pendingAction) return;
    setError(null);
    setStreamFailed(false);
    setStreamGeneration((generation) => generation + 1);
  };

  const captureIsActive = phase === "capturing" || phase === "login-required" || phase === "probing";
  const action = pendingAction === "cancelling"
    ? <button type="button" disabled className="ml-auto rounded-md border px-2 py-1 text-xs disabled:opacity-60">Cancelling…</button>
    : pendingAction === "starting"
      ? <button type="button" disabled className="ml-auto rounded-md border px-2 py-1 text-xs disabled:opacity-60">Starting…</button>
      : streamFailed
        ? <button type="button" onClick={reconnect} className="ml-auto rounded-md border px-2 py-1 text-xs">Reconnect</button>
        : captureIsActive
          ? <button type="button" onClick={() => void cancel()} className="ml-auto rounded-md border px-2 py-1 text-xs">Cancel</button>
          : <button type="button" onClick={() => void recapture()} className="ml-auto rounded-md border px-2 py-1 text-xs">{phase === "error" || phase === "cancelled" ? "Retry" : "Re-capture"}</button>;

  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-sm font-medium">Sharingan</span>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground">{phase}</span>
        {action}
      </div>

      {/* Everything below the header scrolls together (pages gallery + the work-log with its shots). */}
      <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto">
        {error ? (
          <div role="alert" className="rounded-md border border-red-400/40 bg-red-50/60 p-3 text-sm text-red-900 dark:bg-red-500/10 dark:text-red-100">
            {phase === "error" ? "Capture failed: " : "Capture issue: "}{error}
          </div>
        ) : null}

        {phase === "cancelled" ? (
          <div role="status" className="rounded-md border bg-surface-2 p-3 text-sm text-muted-foreground">
            Capture cancelled. You can retry when you're ready.
          </div>
        ) : null}

        {phase === "login-required" ? (
          <div role="status" className="rounded-md border border-amber-400/40 bg-amber-50/60 p-3 text-sm dark:bg-amber-500/10">
            This page needs a login. Open the controlled browser, sign in there, then click Continue.
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => void api.focusSharingan(projectId)} className="rounded-md border px-3 py-1">Open the browser</button>
              <button type="button" onClick={() => void api.continueSharingan(projectId)} className="rounded-md border px-3 py-1">Continue</button>
            </div>
          </div>
        ) : null}

        {pages.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {pages.map((p) => (
              <figure key={p.url} className="overflow-hidden rounded-lg border">
                {(() => {
                  const rel = p.screenshots.desktop ?? Object.values(p.screenshots)[0];
                  return rel ? <img alt={p.title} src={api.sharinganShotUrl(projectId, rel)} className="w-full" /> : null;
                })()}
                <figcaption className="truncate p-2 text-xs text-muted-foreground">{p.title} — {p.url}</figcaption>
              </figure>
            ))}
          </div>
        ) : null}

        <ol className="space-y-1 rounded-md border p-2 text-xs text-muted-foreground">
          {log.map((s, i) => (
            <li key={i} className="py-0.5">
              <div>{s.text}</div>
              {s.shot ? (
                <a href={api.sharinganShotUrl(projectId, s.shot)} target="_blank" rel="noreferrer" className="mt-1 block w-fit">
                  <img alt={s.text} src={api.sharinganShotUrl(projectId, s.shot)} className="max-h-40 w-auto rounded border" />
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
