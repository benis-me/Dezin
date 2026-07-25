import { ArrowUp, ChevronLeft, LoaderCircle, MessageSquareText } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  AgentComposerContextCards,
  type AgentComposerContextItem,
} from "../components/AgentComposerContext.tsx";
import { AgentMessageBody } from "../components/AgentMessageBody.tsx";
import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import { AttachMenu } from "../components/AttachMenu.tsx";
import { DesignSystemSelect } from "../components/DesignSystemSelect.tsx";
import {
  Button,
  StudioHeaderCopy,
  StudioHeaderIdentity,
  StudioPanelHeader,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/index.ts";
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
  designSystemCatalogStatus = "ready",
  onRetryDesignSystems,
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
  designSystemCatalogStatus?: "loading" | "ready" | "error";
  onRetryDesignSystems?: () => void;
}) {
  const pendingMessage = submissionBlockedPending
    ? submissionBlockedReason ?? "Checking Agent availability…"
    : null;
  const activityMessage = pendingMessage
    ?? (attaching ? "Saving immutable context…" : submitting ? submittingLabel : null);
  const activityLabel = pendingMessage ?? `${title} activity`;
  const visibleMessage = submissionBlockedPending ? error : submissionBlockedReason ?? error;
  const messageIsError = visibleMessage !== null;
  const messageId = "workspace-agent-error";
  const activityMessageId = "workspace-agent-activity";
  const describedBy = [
    visibleMessage ? messageId : null,
    activityMessage ? activityMessageId : null,
  ].filter(Boolean).join(" ") || undefined;
  const canSubmit = onSubmit !== undefined
    && draft.trim().length > 0
    && !submissionBlockedPending
    && !submitting
    && !attaching
    && submissionBlockedReason === null;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const hasAgentPicker = onAgentChange !== undefined
    && onModelChange !== undefined
    && onRescanAgents !== undefined;
  const hasDesignSystemPicker = onDesignSystemChange !== undefined;

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [status, transcript.length]);

  const attachFiles = (files: FileList | File[]): void => {
    if (!onAttachFiles || attaching) return;
    const next = Array.from(files);
    if (next.length > 0) void onAttachFiles(next);
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-sidebar" aria-labelledby="workspace-agent-title">
      <StudioPanelHeader draggable className="titlebar-pad-left gap-2 bg-sidebar px-2.5">
        {onBackHome ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="app-no-drag shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Back to projects"
            title={projectName ? `Back to projects · ${projectName}` : "Back to projects"}
            onClick={onBackHome}
          >
            <ChevronLeft aria-hidden className="size-3.5" />
          </Button>
        ) : null}
        <StudioHeaderIdentity className="min-w-0 flex-1">
          <StudioHeaderCopy
            title={title}
            subtitle={contextLabel}
            titleId="workspace-agent-title"
            headingLevel={2}
            className="flex-1 text-left"
          />
        </StudioHeaderIdentity>
      </StudioPanelHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-4" aria-label={`${title} transcript`}>
        {transcript.length === 0 ? (
          <div className="grid min-h-40 place-items-center px-3 text-center">
            <div className="max-w-52">
              <span className="mx-auto grid size-9 place-items-center rounded-xl border border-border bg-card text-muted-foreground">
                <MessageSquareText aria-hidden className="size-4" />
              </span>
              <p className="mt-2.5 text-xs font-medium text-foreground">Work in this scope</p>
              <p className="mt-1 text-[11px] leading-[1.55] text-muted-foreground">
                Attach exact project revisions, then describe the design decision or change.
              </p>
            </div>
          </div>
        ) : (
          <ol className="space-y-3.5">
            {transcript.map((entry) => (
              <li key={entry.id} className="min-w-0">
                <article
                  data-agent-role={entry.role}
                  data-agent-turn-id={entry.turnId}
                  className={cn(
                    entry.role === "user"
                      ? "flex max-w-full flex-col items-end gap-1"
                      : "-mx-2 min-w-0 rounded-xl px-2 py-1",
                  )}
                >
                  <AgentMessageBody role={entry.role} content={entry.content} />
                  <p
                    data-agent-turn-state={entry.id}
                    className={cn(
                      "text-[11px] leading-4 text-muted-foreground",
                      entry.role === "assistant" && "mt-1",
                    )}
                  >
                    {entry.state}
                  </p>
                </article>
              </li>
            ))}
          </ol>
        )}
        {status && activityMessage === null ? (
          <div
            role="status"
            aria-label={`${title} task status`}
            aria-live="polite"
            className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-[11px] leading-4 text-muted-foreground"
          >
            <span className="min-w-0 truncate">{status}</span>
            {onStatusClick ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto shrink-0 px-0 text-[11px] text-foreground"
                onClick={onStatusClick}
              >
                {statusActionLabel}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div ref={transcriptEndRef} />
      </div>

      <div className="shrink-0 px-2.5 pb-2.5 pt-1" data-workspace-agent-composer>
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
            "overflow-hidden rounded-2xl border border-input bg-card transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
            draggingFiles && "border-ring bg-brand/5 ring-2 ring-ring/20",
          )} data-agent-composer-shell>
            <AgentComposerContextCards
              items={contextItems}
              onChange={onContextItemsChange}
              onRemove={onRemoveContextItem}
              ariaLabel="Selected Agent Context"
              className="border-border/60 px-2.5 pt-2.5"
            />
            <textarea
              id="workspace-agent-draft"
              aria-label={draftLabel}
              aria-describedby={describedBy}
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
              rows={2}
              spellCheck
              className="block max-h-40 min-h-[72px] w-full resize-none bg-transparent px-3 pb-2 pt-2.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/70"
            />
            {hasDesignSystemPicker || hasAgentPicker ? (
              <div
                data-workspace-agent-routing
                className="flex min-w-0 flex-wrap items-center gap-0.5 px-2 pt-1"
              >
                {hasDesignSystemPicker ? (
                  <div className="min-w-[8rem] flex-1 overflow-hidden [&_button]:min-w-0 [&_button]:w-full [&_button]:max-w-full [&_button]:overflow-hidden">
                    <DesignSystemSelect
                      compact
                      systems={designSystems}
                      value={designSystemId}
                      onChange={onDesignSystemChange}
                      catalogStatus={designSystemCatalogStatus}
                      onRetry={onRetryDesignSystems}
                    />
                  </div>
                ) : null}
                {hasAgentPicker ? (
                  <div className="min-w-[8rem] flex-1 overflow-hidden [&_button]:min-w-0 [&_button]:w-full [&_button]:max-w-full [&_button]:overflow-hidden [&_button>span]:min-w-0">
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
                  </div>
                ) : null}
              </div>
            ) : null}
            <div
              data-workspace-agent-actions
              className="flex min-h-10 min-w-0 items-center justify-between gap-2 px-2 pb-2 pt-1"
            >
              <div className="flex min-w-0 flex-1 items-center">
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
                {!hasAgentPicker && !hasDesignSystemPicker ? (
                  <span className="truncate px-2 text-[11px] text-muted-foreground">Project context</span>
                ) : null}
                <span className="sr-only">{scopeLabel}</span>
              </div>
              {onSubmit ? (
                <TooltipProvider delayDuration={180}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="inline-flex shrink-0"
                        tabIndex={activityMessage ? 0 : undefined}
                        aria-label={activityMessage ?? undefined}
                      >
                        <Button
                          type="submit"
                          size="icon-xs"
                          aria-label={submitLabel}
                          aria-describedby={activityMessage ? activityMessageId : undefined}
                          aria-busy={activityMessage ? true : undefined}
                          disabled={!canSubmit}
                          className="size-7 shrink-0 rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:opacity-30"
                        >
                          {activityMessage
                            ? <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
                            : <ArrowUp aria-hidden className="size-3.5" />}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {activityMessage ? (
                      <TooltipContent side="top" sideOffset={6}>{activityMessage}</TooltipContent>
                    ) : null}
                  </Tooltip>
                </TooltipProvider>
              ) : null}
            </div>
          </div>
          {activityMessage ? (
            <span
              id={activityMessageId}
              role="status"
              aria-label={activityLabel}
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              {activityMessage}
            </span>
          ) : null}
          {visibleMessage ? (
            <p
              id={messageId}
              role="alert"
              className="mt-1.5 px-1 text-[11px] leading-4 text-destructive"
            >
              {visibleMessage}
            </p>
          ) : null}
        </form>
      </div>
    </section>
  );
}
