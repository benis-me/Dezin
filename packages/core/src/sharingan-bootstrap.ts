export const SHARINGAN_BOOTSTRAP_STATE_PROTOCOL = "dezin.sharingan-bootstrap-state.v1" as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;

interface SharinganBootstrapStateBase {
  readonly protocol: typeof SHARINGAN_BOOTSTRAP_STATE_PROTOCOL;
  readonly projectId: string;
  readonly sourceUrl: string;
  /**
   * The first Workspace turn registered atomically with Project creation.
   * It is not a capability: the daemon still owns capture creation and exact
   * Context injection. It only identifies the one request whose pre-capture
   * graph fence may be rebound after bootstrap publishes its own Resource.
   */
  readonly initialTurnId: string | null;
  readonly bootstrapBaseGraphRevision: number | null;
  readonly bootstrapBaseSnapshotId: string | null;
  readonly attempt: number;
  readonly updatedAt: number;
}

export type SharinganBootstrapState =
  | (SharinganBootstrapStateBase & { readonly status: "pending" | "capturing" })
  | (SharinganBootstrapStateBase & {
      readonly status: "failed";
      readonly error: Readonly<{
        code: string;
        message: string;
        retryable: boolean;
      }>;
    })
  | (SharinganBootstrapStateBase & {
      readonly status: "ready";
      readonly resourceId: string;
      readonly revisionId: string;
      readonly readyGraphRevision: number;
      readonly readySnapshotId: string;
    });

export class SharinganBootstrapStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharinganBootstrapStateError";
  }
}

function fail(message: string): never {
  throw new SharinganBootstrapStateError(message);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("Sharingan bootstrap state must be an object");
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  const expected = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) fail(`Sharingan bootstrap state contains unsupported field ${field}`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) fail(`Sharingan bootstrap state is missing field ${field}`);
  }
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    return fail(`${label} is invalid`);
  }
  return value;
}

function sourceUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    return fail("Sharingan bootstrap source URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail("Sharingan bootstrap source URL is invalid");
  }
  // Keep the user's exact URL (including an intentional fragment) because it
  // is also the requested capture identity. URL serialization is deliberately
  // not required: common valid input such as https://example.com must survive.
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username || parsed.password) {
    return fail("Sharingan bootstrap source URL is invalid");
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail(`${label} is invalid`);
  return Number(value);
}

export function normalizeSharinganBootstrapState(value: unknown): SharinganBootstrapState {
  const input = record(value);
  const status = input.status;
  if (status !== "pending" && status !== "capturing" && status !== "failed" && status !== "ready") {
    return fail("Sharingan bootstrap status is invalid");
  }
  const commonFields = [
    "protocol",
    "projectId",
    "sourceUrl",
    "initialTurnId",
    "bootstrapBaseGraphRevision",
    "bootstrapBaseSnapshotId",
    "status",
    "attempt",
    "updatedAt",
  ] as const;
  exactFields(
    input,
    status === "failed"
      ? [...commonFields, "error"]
      : status === "ready"
        ? [...commonFields, "resourceId", "revisionId", "readyGraphRevision", "readySnapshotId"]
        : commonFields,
  );
  if (input.protocol !== SHARINGAN_BOOTSTRAP_STATE_PROTOCOL) {
    return fail("Sharingan bootstrap state protocol is unsupported");
  }
  const base = {
    protocol: SHARINGAN_BOOTSTRAP_STATE_PROTOCOL,
    projectId: safeId(input.projectId, "Sharingan bootstrap Project id"),
    sourceUrl: sourceUrl(input.sourceUrl),
    initialTurnId: input.initialTurnId === null
      ? null
      : safeId(input.initialTurnId, "Sharingan bootstrap initial turn id"),
    bootstrapBaseGraphRevision: input.bootstrapBaseGraphRevision === null
      ? null
      : safeInteger(input.bootstrapBaseGraphRevision, "Sharingan bootstrap base graph Revision"),
    bootstrapBaseSnapshotId: input.bootstrapBaseSnapshotId === null
      ? null
      : safeId(input.bootstrapBaseSnapshotId, "Sharingan bootstrap base Snapshot id"),
    attempt: safeInteger(input.attempt, "Sharingan bootstrap attempt"),
    updatedAt: safeInteger(input.updatedAt, "Sharingan bootstrap updatedAt"),
  } as const;
  if (status === "failed") {
    const error = record(input.error);
    exactFields(error, ["code", "message", "retryable"]);
    if (typeof error.code !== "string" || !SAFE_ERROR_CODE.test(error.code)
      || typeof error.message !== "string" || error.message.length === 0 || error.message.length > 4_096
      || typeof error.retryable !== "boolean") {
      return fail("Sharingan bootstrap failure is invalid");
    }
    return Object.freeze({
      ...base,
      status,
      error: Object.freeze({ code: error.code, message: error.message, retryable: error.retryable }),
    });
  }
  if (status === "ready") {
    return Object.freeze({
      ...base,
      status,
      resourceId: safeId(input.resourceId, "Sharingan bootstrap Resource id"),
      revisionId: safeId(input.revisionId, "Sharingan bootstrap Revision id"),
      readyGraphRevision: safeInteger(input.readyGraphRevision, "Sharingan bootstrap ready graph Revision"),
      readySnapshotId: safeId(input.readySnapshotId, "Sharingan bootstrap ready Snapshot id"),
    });
  }
  return Object.freeze({ ...base, status });
}
