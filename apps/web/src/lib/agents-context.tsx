import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useApi } from "./api-context.tsx";
import type { AgentInfo } from "./api.ts";

/**
 * App-wide agent scan, shared so a Rescan from anywhere (Settings, a composer) updates every
 * agent/model picker at once — instead of each screen holding its own stale copy.
 */
interface AgentsValue {
  /** Whether a real app-level provider owns this value. */
  provided: boolean;
  agents: AgentInfo[];
  /** First load still in flight. */
  loading: boolean;
  /** A forced rescan in progress. */
  scanning: boolean;
  /** Human-readable progress of the current rescan, e.g. "Scanning CodeBuddy…" ("" when idle). */
  status: string;
  rescan: () => Promise<void>;
  reload: () => Promise<void>;
}

const AgentsContext = createContext<AgentsValue>({
  provided: false,
  agents: [],
  loading: true,
  scanning: false,
  status: "",
  rescan: async () => {},
  reload: async () => {},
});

export function AgentsProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState("");

  const reload = useCallback(async () => {
    try {
      setAgents(await api.listAgents());
    } catch {
      /* keep the last good list */
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Stream the rescan so the UI can show which agent is being probed; fall back to the plain
  // POST if streaming isn't available.
  const rescan = useCallback(async () => {
    setScanning(true);
    setStatus("");
    try {
      let done = false;
      for await (const ev of api.scanAgentsStream()) {
        if (ev.type === "progress") {
          setStatus(
            ev.phase === "models"
              ? `Reading ${ev.label}'s models…`
              : ev.phase === "readiness"
                ? `Checking ${ev.label} sign-in…`
                : `Scanning ${ev.label}…`,
          );
        } else {
          setAgents(ev.agents);
          done = true;
        }
      }
      if (!done) setAgents(await api.rescanAgents());
    } catch {
      try {
        setAgents(await api.rescanAgents());
      } catch {
        /* keep the last good list */
      }
    } finally {
      setScanning(false);
      setStatus("");
      setLoading(false);
    }
  }, [api]);

  // The daemon uses persisted model metadata but refreshes fast presence/sign-in state before
  // answering, so upgraded or signed-out CLIs do not remain silently selectable.
  useEffect(() => {
    void reload();
  }, [reload]);

  return <AgentsContext.Provider value={{ provided: true, agents, loading, scanning, status, rescan, reload }}>{children}</AgentsContext.Provider>;
}

export const useAgents = (): AgentsValue => useContext(AgentsContext);
