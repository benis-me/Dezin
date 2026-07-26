const WORKSPACE_AGENT_CONVERSATION_PROTOCOL = "dezin.workspace-agent-conversation.v1";
const MAX_WORKSPACE_AGENT_MESSAGE_BYTES = 64 * 1024;
const MAX_PRIOR_REQUEST_BYTES = 32 * 1024;
const MAX_CONVERSATION_REQUESTS = 4;

export interface WorkspaceAgentConversation {
  readonly priorRequests: readonly string[];
  readonly currentRequest: string;
}

export type WorkspaceAgentConversationMode = "continue" | "replace";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EXPLICIT_ENGLISH_CONTINUATION = /^(?:please\s+)?(?:retry|continue|resume)\b/iu;
const REFERENTIAL_ENGLISH_CONTINUATION = /^(?:please\s+)?(?:keep|preserve|retain|maintain|reuse|follow)\b/iu;
const ENGLISH_PRIOR_REFERENCE = /\b(?:previous|same|prior)\b/iu;
const EXPLICIT_CHINESE_CONTINUATION = /^(?:请\s*)?(?:重试|再试|继续|接着|恢复)/u;
const REFERENTIAL_CHINESE_CONTINUATION = /^(?:请\s*)?(?:保留|保持|沿用|延续|继承)/u;
const CHINESE_PRIOR_REFERENCE = /(?:原有|之前|上述|刚才)/u;

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function clipUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let clipped = decoder.decode(encoder.encode(value).slice(0, Math.max(0, maxBytes)));
  while (utf8Bytes(clipped) > maxBytes) clipped = clipped.slice(0, -1);
  return clipped;
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function decodeEnvelope(message: string): WorkspaceAgentConversation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  if (!exactKeys(envelope, ["protocol", "requests"])
    || envelope.protocol !== WORKSPACE_AGENT_CONVERSATION_PROTOCOL
    || !Array.isArray(envelope.requests)
    || envelope.requests.length < 2
    || envelope.requests.length > MAX_CONVERSATION_REQUESTS) return null;
  const requests = envelope.requests.flatMap((value): Array<{ role: "prior" | "current"; content: string }> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const request = value as Record<string, unknown>;
    if (!exactKeys(request, ["role", "content"])
      || (request.role !== "prior" && request.role !== "current")
      || typeof request.content !== "string"
      || request.content.length === 0) return [];
    return [{ role: request.role, content: request.content }];
  });
  if (requests.length !== envelope.requests.length
    || requests.at(-1)?.role !== "current"
    || requests.slice(0, -1).some((request) => request.role !== "prior")) return null;
  return {
    priorRequests: requests.slice(0, -1).map((request) => request.content),
    currentRequest: requests.at(-1)!.content,
  };
}

export function decodeWorkspaceAgentConversation(message: string): WorkspaceAgentConversation {
  return decodeEnvelope(message) ?? { priorRequests: [], currentRequest: message };
}

export function workspaceAgentConversationMode(currentRequest: string): WorkspaceAgentConversationMode {
  const request = currentRequest.trim();
  return EXPLICIT_ENGLISH_CONTINUATION.test(request)
    || EXPLICIT_CHINESE_CONTINUATION.test(request)
    || (REFERENTIAL_ENGLISH_CONTINUATION.test(request) && ENGLISH_PRIOR_REFERENCE.test(request))
    || (REFERENTIAL_CHINESE_CONTINUATION.test(request) && CHINESE_PRIOR_REFERENCE.test(request))
    ? "continue"
    : "replace";
}

export function composeWorkspaceAgentConversation(
  currentRequest: string,
  previousMessage?: string | null,
): string {
  if (!previousMessage) return currentRequest;
  const previous = decodeWorkspaceAgentConversation(previousMessage);
  let priorRequests = [...previous.priorRequests, previous.currentRequest]
    .filter((request) => request.length > 0);
  if (priorRequests.length >= MAX_CONVERSATION_REQUESTS) {
    priorRequests = [
      priorRequests[0]!,
      ...priorRequests.slice(-(MAX_CONVERSATION_REQUESTS - 2)),
    ];
  }
  priorRequests = priorRequests.map((request) => clipUtf8(request, MAX_PRIOR_REQUEST_BYTES));
  const encode = (): string => JSON.stringify({
    protocol: WORKSPACE_AGENT_CONVERSATION_PROTOCOL,
    requests: [
      ...priorRequests.map((content) => ({ role: "prior", content })),
      { role: "current", content: currentRequest },
    ],
  });
  let encoded = encode();
  while (utf8Bytes(encoded) > MAX_WORKSPACE_AGENT_MESSAGE_BYTES && priorRequests.length > 1) {
    priorRequests.splice(1, 1);
    encoded = encode();
  }
  if (utf8Bytes(encoded) > MAX_WORKSPACE_AGENT_MESSAGE_BYTES && priorRequests.length === 1) {
    const excess = utf8Bytes(encoded) - MAX_WORKSPACE_AGENT_MESSAGE_BYTES;
    priorRequests[0] = clipUtf8(
      priorRequests[0]!,
      Math.max(0, utf8Bytes(priorRequests[0]!) - excess - 4),
    );
    encoded = encode();
  }
  return utf8Bytes(encoded) <= MAX_WORKSPACE_AGENT_MESSAGE_BYTES && priorRequests.some(Boolean)
    ? encoded
    : currentRequest;
}
