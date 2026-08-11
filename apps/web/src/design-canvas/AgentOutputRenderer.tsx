import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  DezinAgentApproval,
  DezinAgentContext,
  DezinAgentInsights,
  DezinAgentLoadingState,
  DezinAgentRecommendation,
  DezinAgentThinking,
  DezinAgentToolGroup,
  type AgentActionSpec,
  type AgentInsightMetric,
  type AgentToolChipItem,
} from "./DezinAgentPrimitives.tsx";
import { designExportPath, type DesignExportRevealResult } from "../lib/design-export.ts";
import {
  compactJobDuration,
  type AgentApprovalOutputBlock,
  type AgentContextOutputBlock,
  type AgentImageOutputBlock,
  type AgentInsightsOutputBlock,
  type AgentLoadingOutputBlock,
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
  return (
    <div className="design-canvas-agent__output" data-agent-component="job-output">
      {model.blocks.map((block) => (
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
      ))}
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
  block: AgentOutputBlock;
  jobId: string;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
  onRetry?: (jobId: string) => Promise<void>;
  retrying: boolean;
  retryError: string | null;
}) {
  switch (block.type) {
    case "loading": return <LoadingBlock block={block} />;
    case "trace": return <ThinkingBlock block={block} />;
    case "tool-group": return <ToolGroupBlock block={block} />;
    case "search": return <SearchBlock block={block} />;
    case "image": return <ImageBlock block={block} />;
    case "context": return <ContextBlock block={block} />;
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
    case "insights": return <InsightsBlock block={block} />;
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

function ThinkingBlock({ block }: { block: AgentTraceOutputBlock }) {
  const items = block.items.map((item, index) => ({
    id: item.id,
    text: item.text,
    state: block.active && index === block.items.length - 1 ? "active" as const : "done" as const,
  }));
  if (items.length === 0) {
    items.push({ id: `${block.id}:pending`, text: "Preparing the next step", state: "active" });
  }
  return (
    <div data-agent-output-block="trace">
      <DezinAgentThinking items={items} active={block.active} defaultOpen />
    </div>
  );
}

function ToolGroupBlock({ block }: { block: AgentToolGroupOutputBlock }) {
  return (
    <div data-agent-output-block="tool-group">
      <DezinAgentToolGroup
        items={toolItems(block)}
        title={`${block.items.length} ${block.items.length === 1 ? "action" : "actions"}`}
        defaultOpen={block.active}
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

function ContextBlock({ block }: { block: AgentContextOutputBlock }) {
  return (
    <div data-agent-output-block="context">
      <DezinAgentContext
        title="Working context"
        items={block.items.map((item) => ({
          id: item.id,
          title: item.label,
          meta: item.value,
          summary: item.detail,
        }))}
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

function InsightsBlock({ block }: { block: AgentInsightsOutputBlock }) {
  const pages = block.items.map((item) => {
    const metric: AgentInsightMetric = {
      id: item.id,
      label: item.label,
      value: item.value,
      tone: item.tone === "positive" ? "success" : item.tone === "critical" ? "danger" : "neutral",
    };
    return {
      id: `${item.id}:page`,
      title: item.label,
      description: insightFactDescription(item.label),
      metrics: [metric],
    };
  });
  return (
    <div data-agent-output-block="insights">
      <DezinAgentInsights title={block.title} items={pages} />
    </div>
  );
}

function toolItems(block: AgentToolGroupOutputBlock): AgentToolChipItem[] {
  const omittedCount = Math.max(0, block.items.length - 7);
  const visibleItems = block.items.slice(-7);
  return [
    ...(omittedCount > 0 ? [{
      id: `${block.id}:earlier`,
      label: `${omittedCount} earlier actions`,
      detail: "Completed",
      state: "done" as const,
      kind: "tool" as const,
    }] : []),
    ...visibleItems.map((item, index) => {
      const { label, detail } = toolPresentation(item.text);
      return {
        id: item.id,
        label,
        detail,
        kind: "tool" as const,
        state: block.active && index === visibleItems.length - 1 ? "active" as const : "done" as const,
      };
    }),
  ];
}

function toolPresentation(text: string): {
  label: string;
  detail?: string;
} {
  const compact = text.replace(/\s+/g, " ").trim();
  const code = /`([^`]+)`/.exec(compact)?.[1]
    ?? /((?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.(?:tsx?|jsx?|json|html|css|md|png|jpe?g|webp|svg))\b/i.exec(compact)?.[1];
  const label = code ? compact.replace(`\`${code}\``, "").replace(code, "").replace(/[·:—-]+\s*$/, "").trim() : compact;
  return { label: label || compact || "Activity updated", ...(code ? { detail: code } : {}) };
}

function insightFactDescription(label: string): string {
  switch (label) {
    case "Elapsed": return "Duration recorded from this Job's persisted lifecycle timestamps.";
    case "Activity": return "Activity events persisted for this Job.";
    case "Result": return "Terminal lifecycle state persisted for this Job.";
    case "Version": return "Immutable version identifier published by this Job.";
    case "Export": return "Implementation export identifier published by this Job.";
    default: return "Persisted lifecycle fact for this Job.";
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
