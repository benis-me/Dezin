import { Check, Circle, CircleAlert, FolderOpen, LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  AgentImageGenerationState,
  AgentProgressList,
  AgentReasoning,
  AgentWebSearch,
  type AgentProgressItem,
} from "../components/AgentActivityBlocks.tsx";
import { Button } from "../components/ui/index.ts";
import { designExportPath, type DesignExportRevealResult } from "../lib/design-export.ts";
import { usePrefersReducedMotion } from "../lib/use-prefers-reduced-motion.ts";
import {
  compactJobDuration,
  type AgentExportOutputBlock,
  type AgentOutputBlock,
  type AgentOutputModel,
  type AgentToolGroupOutputBlock,
} from "./agent-panel-model.ts";

export interface AgentOutputRendererProps {
  model: AgentOutputModel;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
}

export function AgentOutputRenderer({
  model,
  projectPath,
  onRevealExport,
}: AgentOutputRendererProps) {
  const terminalBlock = model.blocks.find((block) => block.type === "error" || block.type === "outcome");
  const terminalStatus = terminalBlock?.status ?? null;
  const durationMs = terminalBlock?.durationMs ?? 0;
  const exportOwnsReadyOutcome = model.blocks.some((block) => block.type === "export" && block.status === "ready");

  return (
    <div className="design-canvas-agent__activity-body" data-agent-component="job-output">
      {model.blocks.map((block) => (
        <AgentOutputBlockView
          key={block.id}
          block={block}
          durationMs={durationMs}
          terminalStatus={terminalStatus}
          exportOwnsReadyOutcome={exportOwnsReadyOutcome}
          projectPath={projectPath}
          onRevealExport={onRevealExport}
        />
      ))}
    </div>
  );
}

function AgentOutputBlockView({
  block,
  durationMs,
  terminalStatus,
  exportOwnsReadyOutcome,
  projectPath,
  onRevealExport,
}: {
  block: AgentOutputBlock;
  durationMs: number;
  terminalStatus: "ready" | "failed" | "cancelled" | "superseded" | null;
  exportOwnsReadyOutcome: boolean;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
}) {
  if (block.type === "outcome" && block.status === "ready" && exportOwnsReadyOutcome) return null;
  let content: ReactNode;
  switch (block.type) {
    case "trace":
      content = <AgentReasoning items={block.items} active={block.active} durationMs={durationMs} />;
      break;
    case "tool-group":
      content = (
        <AgentProgressList
          items={progressItems(block, terminalStatus)}
          defaultOpen={block.active || terminalStatus === "failed"}
          completionTone={terminalStatus === "ready" ? "auto" : "neutral"}
        />
      );
      break;
    case "search":
      content = <AgentWebSearch query={block.query} results={block.results} active={block.active} />;
      break;
    case "image":
      content = <AgentImageGenerationState prompt={block.prompt} active={block.active} />;
      break;
    case "outcome":
      content = (
        <div
          className="design-canvas-agent__activity-outcome"
          data-agent-component="outcome"
          data-agent-output-block="outcome"
          data-status={block.status}
          role="status"
          aria-label="Job outcome"
        >
          <span aria-hidden>{block.status === "ready" ? <Check /> : <Circle />}</span>
          <p>{block.label}{block.durationMs > 0 ? ` · ${compactJobDuration(block.durationMs)}` : ""}</p>
        </div>
      );
      break;
    case "error":
      content = (
        <div className="design-canvas-agent__activity-error" data-agent-component="error-outcome" data-agent-output-block="error" role="alert">
          <CircleAlert aria-hidden />
          <p>{block.message ?? "The job did not complete."}</p>
        </div>
      );
      break;
    case "export":
      content = (
        <AgentExportOutcome
          block={block}
          projectPath={projectPath}
          onRevealExport={onRevealExport}
        />
      );
      break;
    default:
      content = assertNever(block);
  }
  return content;
}

function progressItems(
  block: AgentToolGroupOutputBlock,
  terminalStatus: "ready" | "failed" | "cancelled" | "superseded" | null,
): AgentProgressItem[] {
  const omittedCount = Math.max(0, block.items.length - 7);
  const visibleItems = block.items.slice(-7);
  return [
    ...(omittedCount > 0 ? [{
      id: `${block.id}:earlier-actions`,
      text: `${omittedCount} earlier actions completed`,
      state: "done" as const,
    }] : []),
    ...visibleItems.map((item, index) => ({
      id: item.id,
      text: item.text,
      state: terminalStatus === "failed" && index === visibleItems.length - 1
        ? "failed" as const
        : block.active && index === visibleItems.length - 1
          ? "active" as const
          : "done" as const,
    })),
  ];
}

function AgentExportOutcome({
  block,
  projectPath,
  onRevealExport,
}: {
  block: AgentExportOutputBlock;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const [revealFeedback, setRevealFeedback] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const exportPath = designExportPath(projectPath, block.exportId);

  return (
    <div className="design-canvas-agent__activity-result" data-agent-component="export-outcome" data-agent-output-block="export">
      <FolderOpen aria-hidden />
      <div className="design-canvas-agent__activity-result-body">
        <p>{block.status === "ready" ? "Export ready" : "Export"}</p>
        {block.status === "ready" ? (
          <>
            {exportPath
              ? <code title={exportPath}>{exportPath}</code>
              : <small>Output path unavailable until Project metadata loads.</small>}
            <div className="design-canvas-agent__activity-export-actions">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={revealing || !exportPath || !onRevealExport}
                onClick={() => {
                  if (!onRevealExport) return;
                  setRevealing(true);
                  setRevealFeedback(null);
                  void onRevealExport(block.exportId).then((result) => {
                    setRevealFeedback(result === "revealed"
                      ? "Opened in Finder."
                      : result === "copied"
                        ? "Finder unavailable · path copied."
                        : "Reveal unavailable · copy the path shown above.");
                  }).catch(() => {
                    setRevealFeedback("Couldn't reveal this export.");
                  }).finally(() => setRevealing(false));
                }}
              >
                {revealing ? <LoaderCircle aria-hidden className={reduceMotion ? undefined : "animate-spin"} /> : null}
                Reveal export
              </Button>
              {revealFeedback ? <output role="status">{revealFeedback}</output> : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Agent output block: ${JSON.stringify(value)}`);
}
