import { useEffect, useRef, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { useToast } from "../components/Toast.tsx";
import type { SharinganStep, SharinganPage } from "../lib/api.ts";

export function SharinganTab({ projectId, sourceUrl }: { projectId: string; sourceUrl: string }) {
  const api = useApi();
  const { toast } = useToast();
  const [phase, setPhase] = useState<string>("idle");
  const [log, setLog] = useState<SharinganStep[]>([]);
  const [pages, setPages] = useState<SharinganPage[]>([]);
  const started = useRef(false);

  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    const refreshStatus = async () => {
      const s = await api.sharinganStatus(projectId).catch(() => null);
      if (alive && s) { setPhase(s.phase); setPages(s.pages); }
      return s;
    };
    (async () => {
      const s = await refreshStatus();
      if (alive && s && s.phase === "idle" && !started.current) {
        started.current = true;
        await api.startSharingan(projectId, sourceUrl).then(() => setPhase("capturing")).catch(() => toast("Couldn't start the capture.", { variant: "error" }));
      }
    })();
    (async () => {
      try {
        for await (const step of api.streamSharinganEvents(projectId, ac.signal)) {
          if (!alive) return;
          setLog((l) => [...l, step]);
          if (step.kind === "login-required") setPhase("login-required");
          if (step.kind === "done") await refreshStatus();
        }
      } catch { /* aborted on unmount */ }
    })();
    return () => { alive = false; ac.abort(); };
  }, [api, projectId, sourceUrl, toast]);

  const recapture = () => {
    started.current = true;
    setLog([]);
    setPages([]);
    api.startSharingan(projectId, sourceUrl).then(() => setPhase("capturing")).catch(() => toast("Couldn't re-capture.", { variant: "error" }));
  };

  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-sm font-medium">Sharingan</span>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground">{phase}</span>
        <button type="button" onClick={recapture} className="ml-auto rounded-md border px-2 py-1 text-xs">Re-capture</button>
      </div>

      {/* Everything below the header scrolls together (pages gallery + the work-log with its shots). */}
      <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto">
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
