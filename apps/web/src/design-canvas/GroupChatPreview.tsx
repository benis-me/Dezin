import { MessagesSquare, ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { DesignCanvasApi } from "./api.ts";
import type { DesignNode, DesignThread } from "./types.ts";

export function GroupChatPreview({ node, projectId, api, members, onOpen }: {
  node: DesignNode;
  projectId: string;
  api: DesignCanvasApi;
  members: readonly string[];
  onOpen?: () => void;
}) {
  const [thread, setThread] = useState<DesignThread | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api.getThread(projectId, { type: "node", nodeId: node.id }, controller.signal).then((next) => {
      if (!controller.signal.aborted) { setThread(next); setError(false); }
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [api, node.id, node.updatedAt, projectId]);
  const goal = thread?.messages.find((message) => message.role === "user")?.content;
  const latest = thread?.messages.filter((message) => message.role === "assistant").at(-1)?.content;
  const busy = node.activeJobId !== null;
  return (
    <section className="design-group-chat" aria-label={`${node.name} summary`}>
      <header><MessagesSquare aria-hidden /><strong title={node.name}>{node.name}</strong></header>
      <p className="design-group-chat__goal">{goal ?? "Bring a direction, references, or a rough idea. Work through it here, then generate the designs."}</p>
      <div className="design-group-chat__members" aria-label="Connected Nodes">
        {members.length ? members.map((name, index) => <span key={index} title={name}>{name}</span>) : <span>Connect Nodes to share context</span>}
      </div>
      <p className="design-group-chat__reply">{error ? "Unable to load the discussion. Open the group to try again." : busy ? "Coordinating design work…" : node.error ? "The last run needs attention. Open the group to review and retry." : latest ?? "The conversation and its designs stay together on this canvas."}</p>
      <button type="button" className="nodrag nopan" onClick={onOpen}>
        Open group chat <ArrowUpRight aria-hidden />
      </button>
    </section>
  );
}
