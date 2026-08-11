import type {
  DesignJob,
  DesignJobActivity,
  DesignNodeVersion,
  DesignThread,
  DesignThreadScope,
} from "./types.ts";

export const TRANSCRIPT_MESSAGE_PAGE_SIZE = 12;
export const TRANSCRIPT_JOB_PAGE_SIZE = 6;
export const RESERVED_MAIN_AGENT_QUEUED_REPLY =
  "Main Agent orchestration is queued. The final result will replace this status.";

export interface MainAgentJobGroup {
  parentJobId: string;
  label: string;
  jobs: DesignJob[];
}

export interface OptimisticUserTurn {
  scopeKey: string;
  message: DesignThread["messages"][number];
  existingMessageIds: ReadonlySet<string>;
  existingJobIds: ReadonlySet<string>;
}

export type AgentTimelineItem =
  | { kind: "message"; id: string; createdAt: number; message: DesignThread["messages"][number] }
  | { kind: "thinking"; id: string; createdAt: number }
  | { kind: "main-job-group"; id: string; createdAt: number; group: MainAgentJobGroup }
  | { kind: "node-job"; id: string; createdAt: number; job: DesignJob };

export type AgentActivityPhase = "reasoning" | "progress" | "search" | "image";

export interface AgentSearchResultModel {
  id: string;
  title: string;
  href: string;
  state: "loading" | "done";
}

export interface AgentOutputActivityItem {
  id: string;
  text: string;
  createdAt: number;
}

interface AgentOutputActivityBlockBase {
  id: string;
  createdAt: number;
  active: boolean;
  phase: AgentActivityPhase;
}

export interface AgentTraceOutputBlock extends AgentOutputActivityBlockBase {
  type: "trace";
  phase: "reasoning";
  items: AgentOutputActivityItem[];
}

export interface AgentToolGroupOutputBlock extends AgentOutputActivityBlockBase {
  type: "tool-group";
  phase: "progress";
  items: AgentOutputActivityItem[];
}

export interface AgentSearchOutputBlock extends AgentOutputActivityBlockBase {
  type: "search";
  phase: "search";
  query: string;
  items: AgentOutputActivityItem[];
  results: AgentSearchResultModel[];
}

export interface AgentImageOutputBlock extends AgentOutputActivityBlockBase {
  type: "image";
  phase: "image";
  prompt: string;
  items: AgentOutputActivityItem[];
}

interface AgentOutputMetadataBlockBase {
  id: string;
  createdAt: number;
  active: false;
  phase: null;
}

export interface AgentLoadingOutputBlock {
  type: "loading";
  id: string;
  createdAt: number;
  active: true;
  phase: null;
  status: Extract<DesignJob["status"], "queued" | "running" | "validating">;
  label: string;
  startedAt: number;
}

export interface AgentContextItemModel {
  id: string;
  label: string;
  value: string;
  detail?: string;
}

export interface AgentContextOutputBlock extends AgentOutputMetadataBlockBase {
  type: "context";
  items: AgentContextItemModel[];
}

export interface AgentApprovalOutputBlock extends AgentOutputMetadataBlockBase {
  type: "approval";
  title: string;
  detail: string;
  actionLabel: string;
}

export interface AgentRecommendationOutputBlock extends AgentOutputMetadataBlockBase {
  type: "recommendation";
  title: string;
  description: string;
  actionLabel: string | null;
  versionId: string | null;
  exportId: string | null;
}

export interface AgentInsightItemModel {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "critical";
}

export interface AgentInsightsOutputBlock extends AgentOutputMetadataBlockBase {
  type: "insights";
  title: string;
  items: AgentInsightItemModel[];
}

export interface AgentOutputBlockRegistry {
  loading: AgentLoadingOutputBlock;
  trace: AgentTraceOutputBlock;
  "tool-group": AgentToolGroupOutputBlock;
  search: AgentSearchOutputBlock;
  image: AgentImageOutputBlock;
  context: AgentContextOutputBlock;
  approval: AgentApprovalOutputBlock;
  recommendation: AgentRecommendationOutputBlock;
  insights: AgentInsightsOutputBlock;
}

export const AGENT_OUTPUT_BLOCK_TYPES = [
  "loading",
  "trace",
  "tool-group",
  "search",
  "image",
  "context",
  "approval",
  "recommendation",
  "insights",
] as const satisfies readonly (keyof AgentOutputBlockRegistry)[];

export type AgentOutputBlockType = (typeof AGENT_OUTPUT_BLOCK_TYPES)[number];
export type AgentOutputBlock = AgentOutputBlockRegistry[AgentOutputBlockType];

export interface AgentOutputModel {
  jobId: string;
  activePhase: AgentActivityPhase | null;
  blocks: AgentOutputBlock[];
}

export interface BuildAgentOutputModelOptions {
  nodeName?: string;
}

export interface AgentTranscriptPage {
  presentableMessages: DesignThread["messages"];
  reservedMainReplies: DesignThread["messages"];
  hiddenTranscriptCount: number;
  latestVisibleJobId: string | null;
  timeline: AgentTimelineItem[];
}

export function agentScopeKey(scope: DesignThreadScope): string {
  return scope.type === "main" ? "main" : `node:${scope.nodeId}`;
}

export function isReservedMainAgentReply(message: DesignThread["messages"][number]): boolean {
  return message.role === "assistant"
    && message.jobId !== null
    && message.content.trim() === RESERVED_MAIN_AGENT_QUEUED_REPLY;
}

export function relatedAgentJobs(
  jobs: readonly DesignJob[],
  scope: DesignThreadScope,
): DesignJob[] {
  const related = scope.type === "main"
    ? jobs.filter((job) => (
      job.kind === "main-agent"
      || job.kind === "implementation-export"
      || job.parentJobId !== null
    ))
    : jobs.filter((job) => job.nodeId === scope.nodeId);
  return [...related].sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ));
}

export function mainAgentGroupLabel(job: DesignJob): string {
  return job.kind === "implementation-export" ? "Implementation export" : "Canvas execution";
}

export function groupMainAgentJobs(
  jobs: readonly DesignJob[],
  thread: DesignThread | null,
): MainAgentJobGroup[] {
  const parents = jobs.filter((job) => job.kind === "main-agent" || job.kind === "implementation-export");
  const children = jobs.filter((job) => job.parentJobId !== null);
  const childrenByParent = new Map<string, DesignJob[]>();
  for (const child of children) {
    const grouped = childrenByParent.get(child.parentJobId!);
    if (grouped) grouped.push(child);
    else childrenByParent.set(child.parentJobId!, [child]);
  }
  const groups = parents.flatMap((parent) => {
    const groupedChildren = childrenByParent.get(parent.id) ?? [];
    const hasAssistantReply = thread?.messages.some((message) => (
      message.role === "assistant" && message.jobId === parent.id
    )) ?? false;
    const conversationOnly = parent.kind === "main-agent"
      && parent.status === "ready"
      && parent.conversationOnly === true
      && groupedChildren.length === 0
      && hasAssistantReply;
    return conversationOnly ? [] : [{
      parentJobId: parent.id,
      label: mainAgentGroupLabel(parent),
      jobs: [parent, ...groupedChildren],
    }];
  });
  const visibleParents = new Set(parents.map((parent) => parent.id));
  for (const [parentJobId, orphanedChildren] of childrenByParent) {
    if (visibleParents.has(parentJobId)) continue;
    groups.push({
      parentJobId,
      label: "Canvas execution",
      jobs: orphanedChildren,
    });
  }
  return groups;
}

export function buildAgentTranscriptPage({
  scopeKey,
  scopeType,
  thread,
  optimisticUserTurn,
  relatedJobs,
  mainJobGroups,
  historyPages,
}: {
  scopeKey: string;
  scopeType: DesignThreadScope["type"];
  thread: DesignThread | null;
  optimisticUserTurn: OptimisticUserTurn | null;
  relatedJobs: readonly DesignJob[];
  mainJobGroups: readonly MainAgentJobGroup[];
  historyPages: number;
}): AgentTranscriptPage {
  const messageHistoryLimit = historyPages * TRANSCRIPT_MESSAGE_PAGE_SIZE;
  const jobHistoryLimit = historyPages * (scopeType === "main" ? TRANSCRIPT_JOB_PAGE_SIZE : 2);
  const threadMatchesScope = thread !== null && agentScopeKey(thread.scope) === scopeKey;
  const threadMessages = optimisticUserTurn
    ? [...(threadMatchesScope ? thread.messages : []), optimisticUserTurn.message]
    : threadMatchesScope ? thread.messages : [];
  // The daemon reserves a complete user/system + assistant pair before it
  // creates any Job. Its exact assistant marker is transport state, never a
  // conversational bubble, in both Main and Node transcripts.
  const reservedMainReplies = threadMessages.filter(isReservedMainAgentReply);
  const presentableMessages = threadMessages.filter((message) => !isReservedMainAgentReply(message));
  const visibleMessages = presentableMessages.slice(-messageHistoryLimit);
  const visibleMainJobGroups = mainJobGroups.slice(-jobHistoryLimit);
  const visibleRelatedJobs = relatedJobs.slice(-jobHistoryLimit);
  const visibleReservedMainReplies = reservedMainReplies.slice(-jobHistoryLimit);
  const hiddenTranscriptCount = Math.max(0, presentableMessages.length - visibleMessages.length)
    + (scopeType === "main"
      ? Math.max(0, mainJobGroups.length - visibleMainJobGroups.length)
      : Math.max(0, relatedJobs.length - visibleRelatedJobs.length));
  const userTurnCreatedAt = new Map<string, number>();
  for (const message of threadMessages) {
    if (message.role === "user" && message.jobId !== null) {
      userTurnCreatedAt.set(message.jobId, message.createdAt);
    }
  }
  const timeline: AgentTimelineItem[] = visibleMessages.map((message) => ({
    kind: "message",
    id: `message:${message.id}`,
    createdAt: message.createdAt,
    message,
  }));
  if (scopeType === "main") {
    const representedJobIds = new Set(visibleMainJobGroups.map((group) => group.parentJobId));
    timeline.push(...visibleMainJobGroups.map((group) => ({
      kind: "main-job-group" as const,
      id: `main-job-group:${group.parentJobId}`,
      createdAt: (optimisticUserTurn && !optimisticUserTurn.existingJobIds.has(group.parentJobId)
        ? optimisticUserTurn.message.createdAt
        : userTurnCreatedAt.get(group.parentJobId))
        ?? Math.min(...group.jobs.map((job) => job.createdAt)),
      group,
    })));
    timeline.push(...visibleReservedMainReplies.flatMap((message) => (
      message.jobId !== null && representedJobIds.has(message.jobId)
        ? []
        : [{
          kind: "thinking" as const,
          id: `thinking:${message.id}`,
          createdAt: userTurnCreatedAt.get(message.jobId ?? "") ?? message.createdAt,
        }]
    )));
  } else {
    timeline.push(...visibleRelatedJobs.map((job) => ({
      kind: "node-job" as const,
      id: `node-job:${job.id}`,
      createdAt: (optimisticUserTurn && !optimisticUserTurn.existingJobIds.has(job.id)
        ? optimisticUserTurn.message.createdAt
        : userTurnCreatedAt.get(job.id)) ?? job.createdAt,
      job,
    })));
  }
  const priority = (item: AgentTimelineItem): number => {
    if (item.kind !== "message") return 1;
    return item.message.role === "user" ? 0 : 2;
  };
  timeline.sort((left, right) => (
    left.createdAt - right.createdAt
    || priority(left) - priority(right)
    || left.id.localeCompare(right.id)
  ));
  let latestVisibleJobId: string | null = null;
  for (let index = timeline.length - 1; index >= 0 && latestVisibleJobId === null; index -= 1) {
    const item = timeline[index]!;
    if (item.kind === "node-job") {
      latestVisibleJobId = item.job.id;
    } else if (item.kind === "main-job-group") {
      latestVisibleJobId = item.group.jobs.at(-1)?.id ?? null;
    }
  }
  return {
    presentableMessages,
    reservedMainReplies,
    hiddenTranscriptCount,
    latestVisibleJobId,
    timeline,
  };
}

export function versionOptionLabel(version: DesignNodeVersion): string {
  const materialName = version.contentKind === "asset"
    ? version.fileName ?? version.mimeType ?? "Material"
    : null;
  const timestamp = new Date(version.createdAt).toLocaleString();
  return `V${version.sequence} · ${materialName ? `${materialName} · ` : ""}${timestamp}`;
}

export function compactActivityText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Activity updated";
  if ((normalized.startsWith("{") || normalized.startsWith("[")) && normalized.length > 240) {
    return "Prepared the structured response";
  }
  if (normalized.length <= 260) return normalized;
  const sentence = normalized.match(/^.{80,220}?[.!?](?:\s|$)/)?.[0]?.trim();
  return `${sentence ?? normalized.slice(0, 220).trimEnd()}…`;
}

export function isWebSearchActivity(activity: DesignJobActivity): boolean {
  return /\b(?:web\s+search|searching\s+(?:the\s+)?web|searched\s+(?:the\s+)?web)\b/i.test(activity.text);
}

export function isImageGenerationActivity(activity: DesignJobActivity): boolean {
  return /\b(?:generating|generate|rendering)\s+(?:an?\s+)?image\b/i.test(activity.text);
}

export function isReasoningActivity(activity: DesignJobActivity): boolean {
  return activity.kind === "text"
    && !isWebSearchActivity(activity)
    && !isImageGenerationActivity(activity);
}

export function activityPhase(activity: DesignJobActivity): AgentActivityPhase {
  if (isWebSearchActivity(activity)) return "search";
  if (isImageGenerationActivity(activity)) return "image";
  if (isReasoningActivity(activity)) return "reasoning";
  return "progress";
}

export function activeAgentActivityPhase(job: DesignJob): AgentActivityPhase | null {
  const active = job.status === "queued" || job.status === "running" || job.status === "validating";
  if (!active) return null;
  const latestActivity = job.activity.at(-1);
  return latestActivity === undefined ? "reasoning" : activityPhase(latestActivity);
}

export function quotedActivityText(text: string): string | null {
  return /[“"]([^”"]{2,180})[”"]/.exec(text)?.[1]?.trim() ?? null;
}

export function searchResults(
  activities: readonly DesignJobActivity[],
  active: boolean,
): AgentSearchResultModel[] {
  return activities.flatMap((activity, index) => {
    const href = activity.text.match(/https?:\/\/[^\s)>\]]+/)?.[0]?.replace(/[.,;:]$/, "");
    if (!href) return [];
    const title = compactActivityText(
      activity.text.replace(href, "").replace(/^[\s·—:-]+|[\s·—:-]+$/g, ""),
    ) || href;
    return [{
      id: activity.id,
      title,
      href,
      state: active && index === activities.length - 1 ? "loading" as const : "done" as const,
    }];
  });
}

function outputActivityItem(
  activity: DesignJobActivity,
  compact: boolean,
): AgentOutputActivityItem {
  return {
    id: activity.id,
    text: compact
      ? compactActivityText(activity.text)
      : activity.text.trim() || "Activity updated",
    createdAt: activity.createdAt,
  };
}

function searchQuery(activities: readonly DesignJobActivity[]): string {
  const first = activities[0];
  if (!first) return "the web";
  return quotedActivityText(first.text)
    ?? (compactActivityText(first.text).replace(/^.*?\bsearch(?:ing|ed)?\b\s*/i, "") || "the web");
}

function outputContextItems(
  job: DesignJob,
  options: BuildAgentOutputModelOptions,
): AgentContextItemModel[] {
  const items: AgentContextItemModel[] = [];
  if (job.nodeId !== null) {
    items.push({
      id: `${job.id}:context:target`,
      label: "Target",
      value: options.nodeName ?? job.nodeId,
      ...(options.nodeName ? { detail: job.nodeId } : {}),
    });
  }
  if (job.canvasRevision !== null || job.contextHash !== null) {
    items.push({
      id: `${job.id}:context:canvas`,
      label: "Canvas snapshot",
      value: job.canvasRevision === null ? "Frozen context" : `Revision ${job.canvasRevision}`,
      ...(job.contextHash === null ? {} : { detail: `Context ${job.contextHash.slice(0, 8)}` }),
    });
  }
  if (job.expectedHeadVersionId !== null) {
    items.push({
      id: `${job.id}:context:head`,
      label: "Expected head",
      value: job.expectedHeadVersionId,
    });
  }
  items.push({
    id: `${job.id}:context:runtime`,
    label: "Runtime",
    value: job.runnerId,
    ...(job.model === null ? {} : { detail: job.model }),
  });
  if (job.parentJobId !== null) {
    items.push({
      id: `${job.id}:context:lineage`,
      label: "Orchestrated by",
      value: job.parentJobId,
    });
  }
  return items;
}

function loadingLabel(job: DesignJob, nodeName?: string): string {
  if (job.status === "validating") return "Validating the result";
  switch (job.kind) {
    case "node-generation": return `Generating ${nodeName ?? "the node"}`;
    case "node-analysis": return `Analyzing ${nodeName ?? "the node"}`;
    case "main-agent": return "Planning the canvas";
    case "implementation-export": return "Building the implementation export";
  }
}

function outputRecommendation(job: DesignJob, nodeName?: string): AgentRecommendationOutputBlock {
  const base: AgentOutputMetadataBlockBase = {
    id: `${job.id}:recommendation`,
    createdAt: job.finishedAt ?? job.updatedAt,
    active: false,
    phase: null,
  };
  if (job.kind === "implementation-export" && job.exportId !== null) {
    return {
      ...base,
      type: "recommendation",
      title: "Export ready",
      description: "Reveal the verified implementation output in Finder.",
      actionLabel: "Reveal export",
      versionId: null,
      exportId: job.exportId,
    };
  }
  if (job.versionId !== null) {
    return {
      ...base,
      type: "recommendation",
      title: "Version published",
      description: `${nodeName ?? "The generated result"} is ready to review on the canvas.`,
      actionLabel: null,
      versionId: job.versionId,
      exportId: null,
    };
  }
  return {
    ...base,
    type: "recommendation",
    title: job.kind === "main-agent" ? "Canvas plan complete" : "Task complete",
    description: job.kind === "main-agent"
      ? "Review the updated canvas and continue from the result."
      : "Review the completed result in the conversation.",
    actionLabel: null,
    versionId: null,
    exportId: null,
  };
}

function outputInsights(job: DesignJob, durationMs: number): AgentInsightsOutputBlock {
  const resultTone = job.status === "ready"
    ? "positive" as const
    : job.status === "failed"
      ? "critical" as const
      : "neutral" as const;
  const count = job.activity.length;
  const items: AgentInsightItemModel[] = [
    { id: `${job.id}:insight:elapsed`, label: "Elapsed", value: compactJobDuration(durationMs) },
    { id: `${job.id}:insight:activity`, label: "Activity", value: `${count} ${count === 1 ? "event" : "events"}` },
    { id: `${job.id}:insight:result`, label: "Result", value: jobStatusLabel(job), tone: resultTone },
  ];
  if (job.versionId !== null) {
    items.push({ id: `${job.id}:insight:version`, label: "Version", value: job.versionId, tone: "positive" });
  } else if (job.exportId !== null) {
    items.push({ id: `${job.id}:insight:export`, label: "Export", value: job.exportId, tone: resultTone });
  }
  return {
    type: "insights",
    id: `${job.id}:insights`,
    createdAt: job.finishedAt ?? job.updatedAt,
    active: false,
    phase: null,
    title: "Run insights",
    items,
  };
}

export function buildAgentOutputModel(
  job: DesignJob,
  options: BuildAgentOutputModelOptions = {},
): AgentOutputModel {
  const orderedActivities = job.activity
    .map((activity, index) => ({ activity, index }))
    .sort((left, right) => (
      left.activity.createdAt - right.activity.createdAt || left.index - right.index
    ))
    .map(({ activity }) => activity);
  const active = job.status === "queued" || job.status === "running" || job.status === "validating";
  const latestActivity = orderedActivities.at(-1);
  const activePhase = !active
    ? null
    : latestActivity === undefined ? "reasoning" : activityPhase(latestActivity);
  const activitiesByPhase = new Map<AgentActivityPhase, DesignJobActivity[]>();
  for (const activity of orderedActivities) {
    const phase = activityPhase(activity);
    const grouped = activitiesByPhase.get(phase);
    if (grouped) grouped.push(activity);
    else activitiesByPhase.set(phase, [activity]);
  }
  const blocks: AgentOutputBlock[] = [];
  const contextItems = outputContextItems(job, options);
  if (contextItems.length > 0) {
    blocks.push({
      type: "context",
      id: `${job.id}:context`,
      createdAt: job.createdAt,
      active: false,
      phase: null,
      items: contextItems,
    });
  }
  if (job.status === "queued" || job.status === "running" || job.status === "validating") {
    blocks.push({
      type: "loading",
      id: `${job.id}:loading`,
      createdAt: job.createdAt,
      active: true,
      phase: null,
      status: job.status,
      label: loadingLabel(job, options.nodeName),
      startedAt: job.createdAt,
    });
  }
  if (orderedActivities.length === 0 && activePhase === "reasoning") {
    blocks.push({
      type: "trace",
      id: `${job.id}:reasoning`,
      createdAt: job.createdAt,
      active: true,
      phase: "reasoning",
      items: [],
    });
  }
  for (const [phase, activities] of activitiesByPhase) {
    const base = {
      id: `${job.id}:${phase}`,
      createdAt: activities[0]!.createdAt,
      active: activePhase === phase,
    };
    switch (phase) {
      case "reasoning":
        blocks.push({
          ...base,
          type: "trace",
          phase,
          items: activities.map((activity) => outputActivityItem(activity, false)),
        });
        break;
      case "progress":
        blocks.push({
          ...base,
          type: "tool-group",
          phase,
          items: activities.map((activity) => outputActivityItem(activity, true)),
        });
        break;
      case "search":
        blocks.push({
          ...base,
          type: "search",
          phase,
          query: searchQuery(activities),
          items: activities.map((activity) => outputActivityItem(activity, true)),
          results: searchResults(activities, activePhase === phase),
        });
        break;
      case "image": {
        const latest = activities.at(-1)!;
        blocks.push({
          ...base,
          type: "image",
          phase,
          prompt: quotedActivityText(latest.text) ?? compactActivityText(latest.text),
          items: activities.map((activity) => outputActivityItem(activity, true)),
        });
        break;
      }
    }
  }
  const durationMs = Math.max(0, (job.finishedAt ?? job.updatedAt) - job.createdAt);
  if (job.status === "failed") {
    blocks.push({
      type: "approval",
      id: `${job.id}:approval`,
      createdAt: job.finishedAt ?? job.updatedAt,
      active: false,
      phase: null,
      title: "Repair this run?",
      detail: job.error?.trim() || "The task did not complete.",
      actionLabel: jobRetryLabel(job),
    });
  } else if (job.status === "ready") {
    blocks.push(outputRecommendation(job, options.nodeName));
  }
  if (!active) {
    blocks.push(outputInsights(job, durationMs));
  }
  return { jobId: job.id, activePhase, blocks };
}

export function jobStatusLabel(job: DesignJob): string {
  switch (job.status) {
    case "queued": return "Queued";
    case "running": return "Working";
    case "validating": return "Validating";
    case "ready": return "Complete";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    case "superseded": return "Superseded";
  }
}

export function jobRetryLabel(job: DesignJob): string {
  switch (job.kind) {
    case "node-analysis": return "Retry analysis";
    case "implementation-export": return "Retry export";
    case "node-generation":
    case "main-agent": return "Repair & retry";
  }
}

export function retryFailureMessage(error: unknown, displayLabel: string): string {
  const detail = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "The failed Job could not be restarted";
  return `Couldn't retry ${displayLabel}. ${detail}`;
}

export function compactJobDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
