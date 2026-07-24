import { ArrowUp, ChevronLeft, LoaderCircle, MessageSquareText } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  AgentComposerContextCards,
  type AgentComposerContextItem,
} from "../components/AgentComposerContext.tsx";
import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import { AttachMenu } from "../components/AttachMenu.tsx";
import { DesignSystemSelect } from "../components/DesignSystemSelect.tsx";
import { Button } from "../components/ui/index.ts";
import type { AgentInfo, DesignSystemCard, EffectCard, Moodboard } from "../lib/api.ts";
import { cn } from "../lib/utils.ts";
import type { AgentTranscriptEntry } from "./scoped-agent-session.ts";

const NOOP_CONTEXT_CHANGE = (_items: AgentComposerContextItem[]) => {};
const NOOP_CONTEXT_REMOVE = (_id: string) => {};

export function WorkspaceAgentPanel({
  projectName,
  onBackHome,
  draft,
  onDraftChange,
  contextLabel,
  contextItems = [],
  onContextItemsChange = NOOP_CONTEXT_CHANGE,
  onRemoveContextItem = NOOP_CONTEXT_REMOVE,
  transcript = [],
  title = "Workspace Agent",
  draftLabel = "Workspace Agent draft",
  placeholder = "Plan a page, component, or workspace change…",
  scopeLabel = "Workspace",
  onSubmit,
  submitting = false,
  error = null,
  status = null,
  onStatusClick,
  statusActionLabel = "Open build plan",
  submitLabel = "Create proposal",
  submittingLabel = "Creating a reviewable proposal…",
  onAttachFiles,
  attaching = false,
  onReferenceMoodboard,
  onReferenceEffect,
  workspaceReferences = [],
  onReferenceWorkspaceItem,
  agents = [],
  agent = "",
  model = "",
  onAgentChange,
  onModelChange,
  onRescanAgents,
  agentDisabledReason,
  submissionBlockedReason = null,
  submissionBlockedPending = false,
  designSystems = [],
  designSystemId = "",
  onDesignSystemChange,
}: {
  projectName?: string;
  onBackHome?: () => void;
  draft: string;
  onDraftChange: (value: string) => void;
  contextLabel: string;
  contextItems?: AgentComposerContextItem[];
  onContextItemsChange?: (items: AgentComposerContextItem[]) => void;
  onRemoveContextItem?: (id: string) => void;
  transcript?: AgentTranscriptEntry[];
  title?: string;
  draftLabel?: string;
  placeholder?: string;
  scopeLabel?: string;
  onSubmit?: () => void | Promise<void>;
  submitting?: boolean;
  error?: string | null;
  status?: string | null;
  onStatusClick?: () => void;
  statusActionLabel?: string;
  submitLabel?: string;
  submittingLabel?: string;
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  attaching?: boolean;
  onReferenceMoodboard?: (board: Moodboard) => void;
  onReferenceEffect?: (effect: EffectCard) => void;
  workspaceReferences?: Array<{ id: string; label: string; detail?: string }>;
  onReferenceWorkspaceItem?: (id: string) => void;
  agents?: AgentInfo[];
  agent?: string;
  model?: string;
  onAgentChange?: (command: string) => void;
  onModelChange?: (model: string) => void;
  onRescanAgents?: () => Promise<void>;
  agentDisabledReason?: (agent: AgentInfo) => string | null;
  submissionBlockedReason?: string | null;
  submissionBlockedPending?: boolean;
  designSystems?: DesignSystemCard[];
  designSystemId?: string;
  onDesignSystemChange?: (id: string) => void;
}) {
  const visibleMessage = submissionBlockedReason ?? error;
  const messageIsError = !submissionBlockedPending && visibleMessage !== null;
  const messageId = submissionBlockedPending ? "workspace-agent-status" : "workspace-agent-error";
  const canSubmit = onSubmit !== undefined
    && draft.trim().length > 0
    && !submitting
    && !attaching
    && submissionBlockedReason === null;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [transcript.length]);

  const attachFiles = (files: FileList | File[]): void => {
    if (!onAttachFiles || attaching) return;
    const next = Array.from(files);
    if (next.length > 0) void onAttachFiles(next);
  };

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="workspace-agent-title">
      <header className="app-drag titlebar-pad-left flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2.5">
        {onBackHome ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="app-no-drag min-w-0 max-w-[58%] justify-start gap-1.5 px-1.5"
            aria-label="Back to projects"
            onClick={onBackHome}
          >
            <ChevronLeft aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{projectName ?? "Projects"}</span>
          </Button>
        ) : null}
        <div className="min-w-0 flex-1 text-right">
          <h2 id="workspace-agent-title" className="truncate text-xs font-medium tracking-[-0.01em] text-foreground">
            {title}
          </h2>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{contextLabel}</p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-label={`${title} transcript`}>
        {transcript.length === 0 ? (
          <div className="grid min-h-32 place-items-center px-2 text-center">
            <div className="max-w-48">
              <span className="mx-auto grid size-8 place-items-center rounded-xl border border-border bg-surface-2 text-muted-foreground">
                <MessageSquareText aria-hidden className="size-3.5" />
              </span>
              <p className="mt-2 text-[11px] font-medium text-foreground">Work in this scope</p>
              <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                Attach exact project revisions, then describe the design decision or change.
              </p>
            </div>
          </div>
        ) : (
          <ol className="space-y-3">
            {transcript.map((entry) => (
              <li key={entry.id} className={cn("flex", entry.role === "user" ? "justify-end" : "justify-start")}>
                <article
                  data-agent-role={entry.role}
                  data-agent-turn-id={entry.turnId}
                  className={cn(
                    "max-w-[90%] rounded-xl border px-2.5 py-2 text-[11px] leading-[1.55]",
                    entry.role === "user"
                      ? "border-foreground/10 bg-foreground text-background"
                      : "border-border bg-card text-foreground",
                  )}
                >
                  <p className="whitespace-pre-wrap break-words">{entry.content}</p>
                  <p className={cn(
                    "mt-1 text-[8px] font-medium uppercase tracking-[0.08em]",
                    entry.role === "user" ? "text-background/55" : "text-muted-foreground",
                  )}>
                    {entry.state}
                  </p>
                </article>
              </li>
            ))}
          </ol>
        )}
        <div ref={transcriptEndRef} />
      </div>

      <div className="shrink-0 border-t border-border p-2.5">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) attachFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <label htmlFor="workspace-agent-draft" className="sr-only">
          {draftLabel}
        </label>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) void onSubmit();
          }}
          onDragEnter={(event) => {
            if (!onAttachFiles || !event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDraggingFiles(true);
          }}
          onDragOver={(event) => {
            if (!onAttachFiles || !event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false);
          }}
          onDrop={(event) => {
            if (!onAttachFiles || event.dataTransfer.files.length === 0) return;
            event.preventDefault();
            setDraggingFiles(false);
            attachFiles(event.dataTransfer.files);
          }}
        >
          <div className={cn(
            "overflow-hidden rounded-2xl border border-input bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/15",
            draggingFiles && "border-ring bg-brand/5 ring-2 ring-ring/20",
          )}>
            <AgentComposerContextCards
              items={contextItems}
              onChange={onContextItemsChange}
              onRemove={onRemoveContextItem}
              ariaLabel="Selected Agent Context"
              className="border-border/60 px-2.5 pt-2.5"
            />
            {onDesignSystemChange ? (
              <div className="flex min-h-9 items-center border-b border-border/60 px-2 py-1">
                <DesignSystemSelect
                  compact
                  systems={designSystems}
                  value={designSystemId}
                  onChange={onDesignSystemChange}
                />
              </div>
            ) : null}
            <textarea
              id="workspace-agent-draft"
              aria-label={draftLabel}
              aria-describedby={visibleMessage ? messageId : undefined}
              aria-invalid={messageIsError ? true : undefined}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSubmit) {
                  event.preventDefault();
                  void onSubmit();
                }
              }}
              placeholder={draggingFiles ? "Drop files to attach…" : placeholder}
              rows={4}
              spellCheck
              className="block max-h-40 min-h-24 w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/70"
            />
            <div className="flex min-h-10 items-center justify-between gap-2 border-t border-border/70 px-2 py-1">
              <div className="flex min-w-0 items-center gap-1">
                {onAttachFiles ? (
                  <AttachMenu
                    fileActionLabel="Upload a reference"
                    onAttachFile={() => fileInputRef.current?.click()}
                    onReferenceMoodboard={onReferenceMoodboard}
                    onReferenceEffect={onReferenceEffect}
                    workspaceReferences={workspaceReferences}
                    onReferenceWorkspaceItem={onReferenceWorkspaceItem}
                    allowLocalPaths={false}
                    allowProjectReference={false}
                    allowFigImport={false}
                  />
                ) : null}
                {onAgentChange && onModelChange && onRescanAgents ? (
                  <AgentModelSelect
                    agents={agents}
                    agent={agent}
                    model={model}
                    onAgentChange={onAgentChange}
                    onModelChange={onModelChange}
                    onRescan={onRescanAgents}
                    agentDisabledReason={agentDisabledReason}
                    dropUp
                  />
                ) : (
                  <span className="truncate text-[10px] text-muted-foreground">Project context</span>
                )}
                <span className="hidden rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground min-[300px]:inline">{scopeLabel}</span>
              </div>
              {onSubmit ? (
                <button
                  type="submit"
                  aria-label={submitLabel}
                  disabled={!canSubmit}
                  className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-background transition-[opacity,transform] enabled:hover:scale-[1.03] enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  {submitting
                    ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
                    : <ArrowUp aria-hidden className="size-3.5" />}
                </button>
              ) : null}
            </div>
          </div>
          {visibleMessage ? (
            <p
              id={messageId}
              role={submissionBlockedPending ? "status" : "alert"}
              className={cn(
                "mt-1.5 px-1 text-[10px] leading-4",
                submissionBlockedPending ? "text-muted-foreground" : "text-destructive",
              )}
            >
              {visibleMessage}
            </p>
          ) : submitting || attaching ? (
            <p role="status" aria-label={`${title} activity`} aria-live="polite" className="mt-1.5 px-1 text-[10px] leading-4 text-muted-foreground">
              {attaching ? "Saving immutable context…" : submittingLabel}
            </p>
          ) : status ? (
            <div role="status" aria-label={`${title} task status`} aria-live="polite" className="mt-1.5 flex items-center justify-between gap-2 px-1 text-[10px] leading-4 text-muted-foreground">
              <span className="min-w-0 truncate">{status}</span>
              {onStatusClick ? (
                <button
                  type="button"
                  className="shrink-0 font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                  onClick={onStatusClick}
                >
                  {statusActionLabel}
                </button>
              ) : null}
            </div>
          ) : null}
        </form>
      </div>
    </section>
  );
}
