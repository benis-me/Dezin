import { useEffect, useMemo, useState, type ReactNode } from "react";

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
  const messages = entries.filter((item) => item.kind !== "tool");
  const firstMessageId = messages[0]?.id;
  const latestMessage = messages.at(-1);
  const earlierMessages = messages.slice(Math.max(0, messages.length - 3), -1);
  const thinkingActive = messages.some((item) => item.id === activeItemId);
  const items: AgentToolChipItem[] = [];

  for (const item of entries) {
    if (item.kind !== "tool") {
      if (item.id !== firstMessageId || !latestMessage) continue;
      items.push({
        id: `thinking:${item.id}`,
        label: "Thinking",
        detail: compactActivityText(latestMessage.rawText?.trim() || latestMessage.text),
        detailMono: false,
        contentMono: false,
        kind: "thinking",
        state: thinkingActive ? "active" : "done",
        children: earlierMessages.length === 0 ? undefined : (
          <div className="dezin-agent-tool-detail dezin-agent-tool-detail--thinking">
            {earlierMessages.map((message) => {
              const text = compactActivityText(message.rawText?.trim() || message.text);
              return <span key={message.id} className="dezin-agent-tool-detail__line" title={text}>{text}</span>;
            })}
          </div>
        ),
      });
      continue;
    }
    items.push({
      id: item.id,
      label: toolLabel(item.toolName),
      detail: toolDetail(item),
      detailMono: item.toolName === "write" || item.toolName === "read" || item.toolName === "command",
      contentMono: item.toolName !== "read" && item.toolName !== "search",
      kind: item.toolName ?? "tool",
      state: item.id === activeItemId ? "active" : "done",
      children: toolActivityDetails(item),
    });
  }
  return items;
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
  const lines = item.diff
    ? diffPreviewLines(item.diff)
    : writtenContent !== null
      ? textPreviewLines(writtenContent, "content")
      : input
        ? inputPreviewLines(input)
        : [];
  const resultLines = item.toolResult
    ? textPreviewLines(prettyToolPayload(item.toolResult), item.toolResultError ? "error" : "result")
    : [];
  const previewLines = lines.length > 0 && resultLines.length > 0 && !item.diff && writtenContent === null
    ? [lines[0], resultLines[0]].filter((line): line is ToolPreviewLine => line !== undefined)
    : [...lines, ...resultLines].slice(0, 2);
  if (previewLines.length === 0) return undefined;
  return (
    <div className="dezin-agent-tool-detail" data-tool-kind={item.toolName ?? "tool"} data-tool-result-error={item.toolResultError || undefined}>
      {previewLines.map((line, index) => (
        <span
          key={`${line.tone}:${index}:${line.text}`}
          className="dezin-agent-tool-detail__line"
          data-tone={line.tone}
          title={line.text}
        >
          {line.text}
        </span>
      ))}
    </div>
  );
}

interface ToolPreviewLine {
  text: string;
  tone: "add" | "remove" | "content" | "input" | "result" | "error";
}

function diffPreviewLines(diff: string): ToolPreviewLine[] {
  return diff.split(/\r?\n/)
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))
    .slice(0, 2)
    .map((line) => ({ text: line, tone: line.startsWith("+") ? "add" : "remove" }));
}

function textPreviewLines(value: string, tone: ToolPreviewLine["tone"]): ToolPreviewLine[] {
  return value.split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, 2)
    .map((text) => ({ text, tone }));
}

function inputPreviewLines(input: Record<string, unknown>): ToolPreviewLine[] {
  const inlineKeys = new Set(["file_path", "path", "command", "query", "pattern", "content", "old_string", "new_string", "edits", "diff", "patch"]);
  return Object.entries(input)
    .filter(([key]) => !inlineKeys.has(key))
    .slice(0, 2)
    .map(([key, value]) => ({
      text: `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
      tone: "input" as const,
    }));
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
