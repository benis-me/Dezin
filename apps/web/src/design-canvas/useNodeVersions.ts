import { useEffect, useState } from "react";

import type { DesignCanvasApi } from "./api.ts";
import type { DesignNode, DesignNodeVersion } from "./types.ts";

/** Version history of the Node whose Agent panel is open; reloads when its version count changes. */
export function useNodeVersions({
  api,
  projectId,
  selectedNode,
}: {
  api: DesignCanvasApi;
  projectId: string;
  selectedNode: DesignNode | null;
}) {
  const [versions, setVersions] = useState<DesignNodeVersion[]>([]);
  const [versionsNodeId, setVersionsNodeId] = useState<string | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);

  useEffect(() => {
    if (!selectedNode) {
      setVersions([]);
      setVersionsNodeId(null);
      return;
    }
    const controller = new AbortController();
    setVersions([]);
    setVersionsNodeId(null);
    setVersionsLoading(true);
    void api.listNodeVersions(projectId, selectedNode.id, controller.signal).then((next) => {
      if (!controller.signal.aborted) {
        setVersions(next);
        setVersionsNodeId(selectedNode.id);
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setVersions([]);
        setVersionsNodeId(selectedNode.id);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setVersionsLoading(false);
    });
    return () => controller.abort();
  }, [api, projectId, selectedNode?.id, selectedNode?.versionCount]);

  return { versions, versionsNodeId, versionsLoading };
}
