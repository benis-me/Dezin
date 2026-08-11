import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Markdown } from "../components/Markdown.tsx";
import { AgentCodeBlock, AgentFileDiff } from "../components/AgentRichContent.tsx";
import {
  DezinAgentApproval,
  DezinAgentLoadingState,
  DezinAgentRecommendation,
  DezinAgentThinking,
  DezinAgentToolGroup,
  type AgentActionSpec,
  type AgentToolChipItem,
} from "./DezinAgentPrimitives.tsx";
import { designExportPath, type DesignExportRevealResult } from "../lib/design-export.ts";
import {
  compactActivityText,
  compactJobDuration,
  type AgentApprovalOutputBlock,
  type AgentImageOutputBlock,
  type AgentLoadingOutputBlock,
  type AgentOutputActivityItem,
  type AgentOutputBlock,
  type AgentOutputModel,
  type AgentRecommendationOutputBlock,
  type AgentSearchOutputBlock,
  type AgentToolGroupOutputBlock,
  type AgentTraceOutputBlock,
} from "./agent-panel-model.ts";

export interface AgentOutputRendererProps {
  model: AgentOutputModel;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
  onRetry?: (jobId: string) => Promise<void>;
  retrying?: boolean;
  retryError?: string | null;
}

export function AgentOutputRenderer({
  model,
  projectPath,
  onRevealExport,
  onRetry,
  retrying = false,
  retryError = null,
}: AgentOutputRendererProps) {
  const activityBlocks = model.blocks.filter((block): block is AgentTraceOutputBlock | AgentToolGroupOutputBlock => (
    block.type === "trace" || block.type === "tool-group"
  ));
  const activityAnchorId = activityBlocks[0]?.id;
  return (
    <div className="design-canvas-agent__output" data-agent-component="job-output">
      {model.blocks.map((block) => {
        if (block.type === "trace" || block.type === "tool-group") {
          return block.id === activityAnchorId
            ? <ActivityGroupBlock key={activityAnchorId} blocks={activityBlocks} live={model.activePhase !== null} />
            : null;
        }
        return (
          <AgentOutputBlockView
            key={block.id}
            block={block}
            jobId={model.jobId}
            projectPath={projectPath}
            onRevealExport={onRevealExport}
            onRetry={onRetry}
            retrying={retrying}
            retryError={retryError}
          />
        );
      })}
    </div>
  );
}

function AgentOutputBlockView({
  block,
  jobId,
  projectPath,
  onRevealExport,
  onRetry,
  retrying,
  retryError,
}: {
  block: Exclude<AgentOutputBlock, AgentTraceOutputBlock | AgentToolGroupOutputBlock>;
  jobId: string;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
  onRetry?: (jobId: string) => Promise<void>;
  retrying: boolean;
  retryError: string | null;
}) {
  switch (block.type) {
    case "loading": return <LoadingBlock block={block} />;
    case "search": return <SearchBlock block={block} />;
    case "image": return <ImageBlock block={block} />;
    case "approval": return (
      <ApprovalBlock
        block={block}
        jobId={jobId}
        onRetry={onRetry}
        retrying={retrying}
        retryError={retryError}
      />
    );
    case "recommendation": return (
      <RecommendationBlock
        block={block}
        projectPath={projectPath}
        onRevealExport={onRevealExport}
      />
    );
    default: return assertNever(block);
  }
}

function LoadingBlock({ block }: { block: AgentLoadingOutputBlock }) {
  const elapsed = useElapsedLabel(block.startedAt);
  return (
    <div data-agent-output-block="loading">
      <DezinAgentLoadingState label={block.label} elapsed={elapsed} variant="drive" />
    </div>
  );
}

function ActivityGroupBlock({
  blocks,
  live,
}: {
  blocks: readonly (AgentTraceOutputBlock | AgentToolGroupOutputBlock)[];
  live: boolean;
}) {
  const orderedEntries = blocks
    .flatMap((block) => block.items)
    .sort((left, right) => left.createdAt - right.createdAt || (left.order ?? 0) - (right.order ?? 0));
  const entries = orderedEntries.filter((item) => item.kind !== "status");
  const latestActiveEntry = blocks.find((block) => block.active)?.items.at(-1);
  const activeItemId = latestActiveEntry?.kind !== "status"
    ? latestActiveEntry?.id ?? null
    : null;
  if (entries.length === 0) return null;
  return (
    <div data-agent-output-block="tool-group">
      <DezinAgentToolGroup
        items={activityItems(entries, activeItemId)}
        toolCallCount={entries.filter((item) => item.kind === "tool").length}
        messageCount={entries.filter((item) => item.kind !== "tool").length}
        defaultOpen={live}
      />
    </div>
  );
}

function SearchBlock({ block }: { block: AgentSearchOutputBlock }) {
  const resultItems = block.results.map((result, index) => ({
    id: result.id,
    text: (
      <a href={result.href} target="_blank" rel="noreferrer">
        {result.title}
      </a>
    ),
    state: block.active && index === block.results.length - 1 ? "active" as const : "done" as const,
  }));
  const items = resultItems.length > 0
    ? resultItems
    : block.items.map((item, index) => ({
        id: item.id,
        text: item.text,
        state: block.active && index === block.items.length - 1 ? "active" as const : "done" as const,
      }));
  return (
    <div data-agent-output-block="search">
      <DezinAgentThinking items={items} active={block.active} durationLabel={`Search · ${block.query}`} defaultOpen />
    </div>
  );
}

function ImageBlock({ block }: { block: AgentImageOutputBlock }) {
  if (block.active) {
    return (
      <div data-agent-output-block="image">
        <DezinAgentLoadingState label={`Generating image · ${block.prompt}`} variant="orbit" />
      </div>
    );
  }
  return (
    <div data-agent-output-block="image">
      <DezinAgentThinking
        items={[{ id: `${block.id}:image`, text: block.prompt, state: "done" }]}
        durationLabel="Image prepared"
        defaultOpen
      />
    </div>
  );
}

function ApprovalBlock({
  block,
  jobId,
  onRetry,
  retrying,
  retryError,
}: {
  block: AgentApprovalOutputBlock;
  jobId: string;
  onRetry?: (jobId: string) => Promise<void>;
  retrying: boolean;
  retryError: string | null;
}) {
  const actions: AgentActionSpec[] = onRetry ? [{
    id: `${block.id}:retry`,
    label: retrying ? "Retrying" : block.actionLabel,
    tone: "primary",
    busy: retrying,
    icon: <SourceRetryIcon />,
    onClick: () => void onRetry(jobId),
  }] : [];
  return (
    <div data-agent-output-block="approval">
      <DezinAgentApproval
        title={block.title}
        description={block.detail}
        tone="danger"
        actions={actions}
      >
        {retryError ? <p role="alert">{retryError}</p> : null}
      </DezinAgentApproval>
    </div>
  );
}

function RecommendationBlock({
  block,
  projectPath,
  onRevealExport,
}: {
  block: AgentRecommendationOutputBlock;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
}) {
  const [revealState, setRevealState] = useState<"idle" | "revealing" | DesignExportRevealResult | "failed">("idle");
  const exportPath = block.exportId === null ? null : designExportPath(projectPath, block.exportId);
  const feedback = revealState === "revealed"
    ? "Opened in Finder."
    : revealState === "copied"
      ? "Finder unavailable · path copied."
      : revealState === "unavailable"
        ? "Reveal unavailable · copy the path shown below."
        : revealState === "failed"
          ? "Couldn't reveal this export."
          : null;
  const actionLabel = revealState === "revealing"
    ? "Revealing"
    : revealState === "revealed"
      ? "Revealed"
      : revealState === "copied"
        ? "Path copied"
        : block.actionLabel;
  const revealSucceeded = revealState === "revealed" || revealState === "copied";
  const actions: AgentActionSpec[] = block.exportId !== null && block.actionLabel !== null ? [{
    id: `${block.id}:reveal`,
    label: actionLabel ?? block.actionLabel,
    tone: "primary",
    busy: revealState === "revealing",
    disabled: !exportPath || !onRevealExport,
    icon: revealSucceeded ? <SourceCheckIcon /> : undefined,
    onClick: () => {
      if (!onRevealExport) return;
      setRevealState("revealing");
      void onRevealExport(block.exportId!).then((result) => {
        setRevealState(result);
      }).catch(() => setRevealState("failed"));
    },
  }] : [];
  const detail: ReactNode = (
    <>
      <p>{block.description}</p>
      {exportPath ? <code title={exportPath}>{exportPath}</code> : null}
      {block.versionId ? <code>{block.versionId}</code> : null}
      {feedback ? <output role="status">{feedback}</output> : null}
    </>
  );
  return (
    <div data-agent-output-block="recommendation" data-reveal-state={revealState}>
      <DezinAgentRecommendation title={block.title} description={detail} actions={actions} />
    </div>
  );
}

function activityItems(entries: readonly AgentOutputActivityItem[], activeItemId: string | null): AgentToolChipItem[] {
  const omittedCount = Math.max(0, entries.length - 7);
  const visibleItems = entries.slice(-7);
  return [
    ...(omittedCount > 0 ? [{
      id: "earlier-activities",
      label: `${omittedCount} earlier activities`,
      detail: "Completed",
      detailMono: false,
      state: "done" as const,
      kind: "tool" as const,
    }] : []),
    ...visibleItems.map((item) => {
      const rawText = item.rawText?.trim() || item.text;
      if (item.kind !== "tool") {
        return {
          id: item.id,
          label: "Thinking",
          detail: compactActivityText(rawText),
          detailMono: false,
          contentMono: false,
          kind: "thinking" as const,
          state: item.id === activeItemId ? "active" as const : "done" as const,
          children: <Markdown className="dezin-agent-thinking__detail-markdown">{rawText}</Markdown>,
        };
      }
      return {
        id: item.id,
        label: toolLabel(item.toolName),
        detail: toolDetail(item),
        detailMono: item.toolName === "write" || item.toolName === "read" || item.toolName === "command",
        contentMono: item.toolName !== "read" && item.toolName !== "search",
        kind: item.toolName ?? "tool" as const,
        state: item.id === activeItemId ? "active" as const : "done" as const,
        children: toolActivityDetails(item),
      };
    }),
  ];
}

function toolLabel(toolName: AgentOutputActivityItem["toolName"]): string {
  switch (toolName) {
    case "write": return "Write";
    case "read": return "Read";
    case "command": return "Command";
    case "search": return "Search";
    default: return "Tool";
  }
}

function parsedToolInput(item: AgentOutputActivityItem): Record<string, unknown> | null {
  if (!item.toolInput) return null;
  try {
    const parsed: unknown = JSON.parse(item.toolInput);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function toolDetail(item: AgentOutputActivityItem): string | undefined {
  const input = parsedToolInput(item);
  const structured = input?.file_path ?? input?.path ?? input?.command ?? input?.query ?? input?.pattern;
  if (typeof structured === "string" && structured.trim()) {
    return structured.replace(/\s+/g, " ").trim();
  }
  const compact = (item.rawText?.trim() || item.text).replace(/\s+/g, " ").trim();
  return /`([^`]+)`/.exec(compact)?.[1]
    ?? /((?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.(?:tsx?|jsx?|json|html|css|md|png|jpe?g|webp|svg))\b/i.exec(compact)?.[1];
}

function toolActivityDetails(item: AgentOutputActivityItem): ReactNode | undefined {
  if (!item.diff && !item.toolInput && !item.toolResult) return undefined;
  const input = parsedToolInput(item);
  const writtenContent = item.toolName === "write" && typeof input?.content === "string"
    ? input.content
    : null;
  return (
    <div className="dezin-agent-tool-detail" data-tool-kind={item.toolName ?? "tool"} data-tool-result-error={item.toolResultError || undefined}>
      {item.diff ? <AgentFileDiff code={item.diff} /> : writtenContent !== null ? (
        <AgentCodeBlock code={writtenContent} language={toolLanguage(input?.file_path)} />
      ) : item.toolInput ? (
        <section>
          <small>Input</small>
          <pre><code>{prettyToolPayload(item.toolInput)}</code></pre>
        </section>
      ) : null}
      {item.toolResult ? (
        <section>
          <small>{item.toolResultError ? "Error" : "Result"}</small>
          <pre><code>{prettyToolPayload(item.toolResult)}</code></pre>
        </section>
      ) : null}
    </div>
  );
}

function toolLanguage(path: unknown): string {
  if (typeof path !== "string") return "text";
  return /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "text";
}

function prettyToolPayload(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function useElapsedLabel(startedAt: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return useMemo(() => compactJobDuration(Math.max(0, now - startedAt)), [now, startedAt]);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Agent output block: ${JSON.stringify(value)}`);
}

function SourceRetryIcon() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
    </svg>
  );
}

function SourceCheckIcon() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
