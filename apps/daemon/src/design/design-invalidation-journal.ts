import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type {
  DesignInvalidationEvent,
  DesignInvalidationMessage,
  DesignInvalidationReset,
  DesignInvalidationTopic,
} from "@dezin/design-canvas-contracts";

const JOURNAL_SCHEMA_VERSION = 1 as const;
const MAX_RETAINED_EVENTS = 256;
const JOURNAL_FILE = "invalidation-journal.json";
const TOPIC_PATTERN = /^(?:canvas|jobs|thread:main|thread:node:[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

interface StoredJournal {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  epoch: string;
  sequence: number;
  events: DesignInvalidationEvent[];
}

export interface DesignInvalidationSubscription {
  initial: DesignInvalidationMessage[];
  unsubscribe: () => void;
}

type Listener = (event: DesignInvalidationEvent) => void;

const journalLocks = new Map<string, Promise<void>>();
const journalListeners = new Map<string, Set<Listener>>();

export function designInvalidationRoot(dataDir: string, projectId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(projectId) || projectId === "." || projectId === "..") {
    throw new TypeError("Design Project id is invalid");
  }
  return join(dataDir, "projects", projectId, "design");
}

function journalPath(root: string): string {
  return join(root, "events", JOURNAL_FILE);
}

function cursor(epoch: string, sequence: number): string {
  return `${epoch}:${sequence}`;
}

function freshJournal(): StoredJournal {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    epoch: randomUUID(),
    sequence: 0,
    events: [],
  };
}

function validTopic(value: unknown): value is DesignInvalidationTopic {
  return typeof value === "string" && TOPIC_PATTERN.test(value);
}

function validEvent(value: unknown, epoch: string): value is DesignInvalidationEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<DesignInvalidationEvent>;
  return event.type === "invalidate"
    && event.epoch === epoch
    && Number.isSafeInteger(event.sequence)
    && (event.sequence ?? 0) > 0
    && event.cursor === cursor(epoch, event.sequence!)
    && Array.isArray(event.topics)
    && event.topics.length > 0
    && event.topics.every(validTopic);
}

function parseJournal(value: unknown): StoredJournal | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Partial<StoredJournal>;
  if (state.schemaVersion !== JOURNAL_SCHEMA_VERSION
    || typeof state.epoch !== "string"
    || !/^[A-Za-z0-9-]{1,128}$/.test(state.epoch)
    || !Number.isSafeInteger(state.sequence)
    || (state.sequence ?? -1) < 0
    || !Array.isArray(state.events)
    || state.events.length > MAX_RETAINED_EVENTS
    || !state.events.every((event) => validEvent(event, state.epoch!))) {
    return null;
  }
  const events = state.events as DesignInvalidationEvent[];
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence !== events[index - 1]!.sequence + 1) return null;
  }
  if (events.length > 0 && events.at(-1)!.sequence !== state.sequence) return null;
  return state as StoredJournal;
}

async function writeAtomic(path: string, value: StoredJournal): Promise<void> {
  const parent = resolve(path, "..");
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJournal(root: string): Promise<StoredJournal> {
  const path = journalPath(root);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const state = freshJournal();
    await writeAtomic(path, state);
    return state;
  }
  try {
    const parsed = parseJournal(JSON.parse(raw) as unknown);
    if (parsed) return parsed;
  } catch {
    // Replacing a corrupt journal changes the epoch, forcing every client to
    // reset from canonical GETs without making Canvas authority unavailable.
  }
  const state = freshJournal();
  await writeAtomic(path, state);
  return state;
}

async function withJournalLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const prior = journalLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const tail = prior.then(() => current);
  journalLocks.set(root, tail);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (journalLocks.get(root) === tail) journalLocks.delete(root);
  }
}

function parseCursor(value: string): { epoch: string; sequence: number } | null {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const epoch = value.slice(0, separator);
  const rawSequence = value.slice(separator + 1);
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawSequence)) return null;
  const sequence = Number(rawSequence);
  if (!Number.isSafeInteger(sequence)) return null;
  return { epoch, sequence };
}

function reset(state: StoredJournal, reason: DesignInvalidationReset["reason"]): DesignInvalidationReset {
  return {
    type: "reset",
    cursor: cursor(state.epoch, state.sequence),
    epoch: state.epoch,
    sequence: state.sequence,
    reason,
  };
}

function replay(state: StoredJournal, lastEventId: string | null): DesignInvalidationMessage[] {
  if (lastEventId === null || lastEventId.trim() === "") return [reset(state, "initial")];
  const parsed = parseCursor(lastEventId.trim());
  if (!parsed) return [reset(state, "invalid-cursor")];
  if (parsed.epoch !== state.epoch) return [reset(state, "epoch-mismatch")];
  if (parsed.sequence > state.sequence) return [reset(state, "cursor-ahead")];
  const oldestRetained = state.events[0]?.sequence ?? state.sequence + 1;
  if (parsed.sequence < oldestRetained - 1) return [reset(state, "history-compacted")];
  return state.events.filter((event) => event.sequence > parsed.sequence);
}

async function persistDesignInvalidationUnlocked(
  root: string,
  topics: readonly DesignInvalidationTopic[],
): Promise<DesignInvalidationEvent> {
  const normalized = [...new Set(topics)];
  if (normalized.length === 0 || !normalized.every(validTopic)) {
    throw new TypeError("Design invalidation topics are invalid");
  }
  const state = await readJournal(root);
  const sequence = state.sequence + 1;
  const event: DesignInvalidationEvent = {
    type: "invalidate",
    cursor: cursor(state.epoch, sequence),
    epoch: state.epoch,
    sequence,
    topics: normalized,
  };
  state.sequence = sequence;
  state.events.push(event);
  state.events = state.events.slice(-MAX_RETAINED_EVENTS);
  await writeAtomic(journalPath(root), state);
  return event;
}

export async function persistDesignInvalidation(
  root: string,
  topics: readonly DesignInvalidationTopic[],
): Promise<DesignInvalidationEvent> {
  return withJournalLock(root, () => persistDesignInvalidationUnlocked(root, topics));
}

export function broadcastDesignInvalidation(root: string, event: DesignInvalidationEvent): void {
  for (const listener of journalListeners.get(root) ?? []) {
    try {
      listener(event);
    } catch {
      // A broken response listener cannot affect committed Canvas authority.
    }
  }
}

export async function publishDesignInvalidation(
  root: string,
  topics: readonly DesignInvalidationTopic[],
): Promise<DesignInvalidationEvent> {
  const event = await persistDesignInvalidation(root, topics);
  broadcastDesignInvalidation(root, event);
  return event;
}

/**
 * Persist the cursor before the authority write so a crash cannot lose its
 * invalidation, but keep the journal lock until the authority write commits.
 * A same-process subscriber therefore cannot replay the durable reservation
 * before canonical authority is readable. After a crash the process lock is
 * gone and replaying that reservation is a safe extra canonical GET.
 */
export async function commitDesignAuthorityChange<T>(
  root: string,
  topics: readonly DesignInvalidationTopic[],
  commit: () => Promise<T>,
): Promise<{ event: DesignInvalidationEvent; result: T }> {
  return withJournalLock(root, async () => {
    const event = await persistDesignInvalidationUnlocked(root, topics);
    const result = await commit();
    broadcastDesignInvalidation(root, event);
    return { event, result };
  });
}

export async function subscribeDesignInvalidations(
  root: string,
  lastEventId: string | null,
  listener: Listener,
): Promise<DesignInvalidationSubscription> {
  return withJournalLock(root, async () => {
    const listeners = journalListeners.get(root) ?? new Set<Listener>();
    listeners.add(listener);
    journalListeners.set(root, listeners);
    let subscribed = true;
    return {
      initial: replay(await readJournal(root), lastEventId),
      unsubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
        if (listeners.size === 0 && journalListeners.get(root) === listeners) {
          journalListeners.delete(root);
        }
      },
    };
  });
}
