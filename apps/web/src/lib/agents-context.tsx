import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useApi } from "./api-context.tsx";
import type { AgentInfo } from "./api.ts";

/**
 * App-wide agent scan, shared so a Rescan from anywhere (Settings, a composer) updates every
 * agent/model picker at once — instead of each screen holding its own stale copy.
 */
interface AgentsValue {
  agents: AgentInfo[];
  /** First load still in flight. */
  loading: boolean;
  /** A forced rescan in progress. */
  scanning: boolean;
  rescan: () => Promise<void>;
  reload: () => Promise<void>;
}

const AgentsContext = createContext<AgentsValue>({
  agents: [],
  loading: true,
  scanning: false,
  rescan: async () => {},
  reload: async () => {},
});

export function AgentsProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const reload = useCallback(async () => {
    try {
      setAgents(await api.listAgents());
    } catch {
      /* keep the last good list */
    } finally {
      setLoading(false);
    }
  }, [api]);

  const rescan = useCallback(async () => {
    setScanning(true);
    try {
      setAgents(await api.rescanAgents());
    } catch {
      /* keep the last good list */
    } finally {
      setScanning(false);
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return <AgentsContext.Provider value={{ agents, loading, scanning, rescan, reload }}>{children}</AgentsContext.Provider>;
}

export const useAgents = (): AgentsValue => useContext(AgentsContext);
