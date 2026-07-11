/**
 * In-process broker for live runs. A run's events are buffered + emitted (so multiple clients
 * can attach/reattach) and appended to a per-run JSONL log under <dataDir>/.runs/<id>.jsonl, so
 * a client that navigated away — or reconnects after an app restart — can replay what the run
 * reached. The run itself executes in the daemon and continues regardless of any one client's
 * connection; the only ways to stop it are an explicit cancel or the daemon exiting.
 */

import { EventEmitter } from "node:events";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeSupervisor } from "./runtime-supervisor.ts";
import { BoundedEventBuffer, RUN_JOURNAL_MAX_BYTES, RUN_JOURNAL_TRUNCATED } from "./bounded-buffer.ts";

interface RunEntry {
  runId: string;
  conversationId: string;
  logPath: string;
  buffer: BoundedEventBuffer;
  nextSeq: number;
  emitter: EventEmitter;
  ctrl: AbortController;
  writeQueue: Promise<void>;
  flushTimer?: ReturnType<typeof setTimeout>;
  settled: Promise<void>;
  resolveSettled: () => void;
  finishPromise?: Promise<void>;
  done: boolean;
}

const runs = new Map<string, RunEntry>();

export function runLogPath(dataDir: string, runId: string): string {
  return join(dataDir, ".runs", `${runId}.jsonl`);
}

/** Register a starting run + its abort controller. Call before emitting any events. */
export function createRun(meta: {
  runId: string;
  conversationId: string;
  dataDir: string;
  projectId?: string;
  variantId?: string;
  runtimeSupervisor?: RuntimeSupervisor;
}): AbortController {
  const logPath = runLogPath(meta.dataDir, meta.runId);
  try {
    mkdirSync(join(meta.dataDir, ".runs"), { recursive: true });
  } catch {
    /* best-effort */
  }
  const emitter = new EventEmitter();
  emitter.setMaxListeners(64);
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const entry: RunEntry = {
    runId: meta.runId,
    conversationId: meta.conversationId,
    logPath,
    buffer: new BoundedEventBuffer(),
    nextSeq: 1,
    emitter,
    ctrl: new AbortController(),
    writeQueue: Promise.resolve(),
    settled,
    resolveSettled,
    done: false,
  };
  runs.set(meta.runId, entry);
  if (meta.runtimeSupervisor && meta.projectId) {
    try {
      meta.runtimeSupervisor.registerRun({
        projectId: meta.projectId,
        ...(meta.variantId ? { variantId: meta.variantId } : {}),
        runId: meta.runId,
        controller: entry.ctrl,
        settled,
      });
    } catch (error) {
      runs.delete(meta.runId);
      resolveSettled();
      throw error;
    }
  }
  return entry.ctrl;
}

function eventSeq(ev: unknown): number | null {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null;
  const seq = (ev as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

function withSeq(ev: unknown, seq: number): unknown {
  if (ev && typeof ev === "object" && !Array.isArray(ev)) return { ...ev, seq };
  return { type: "event", value: ev, seq };
}

/** Buffer + persist + broadcast one event. */
export function pushEvent(runId: string, ev: unknown): void {
  const e = runs.get(runId);
  if (!e || e.done) return;
  const event = withSeq(ev, e.nextSeq++);
  e.buffer.push(event);
  scheduleFlush(e);
  e.emitter.emit("event", event);
}

function queueSnapshot(e: RunEntry): Promise<void> {
  const snapshot = e.buffer.toJsonl();
  e.writeQueue = e.writeQueue
    .catch(() => {})
    .then(() => writeFile(e.logPath, snapshot, "utf8"))
    .catch(() => {});
  return e.writeQueue;
}

function scheduleFlush(e: RunEntry): void {
  if (e.flushTimer) return;
  e.flushTimer = setTimeout(() => {
    e.flushTimer = undefined;
    void queueSnapshot(e);
  }, 50);
  e.flushTimer.unref?.();
}

function forceFlush(e: RunEntry): Promise<void> {
  if (e.flushTimer) {
    clearTimeout(e.flushTimer);
    e.flushTimer = undefined;
  }
  return queueSnapshot(e);
}

/** Mark the run finished; late subscribers fall back to the persisted log. */
export function finishRun(runId: string): Promise<void> {
  const e = runs.get(runId);
  if (!e) return Promise.resolve();
  e.done = true;
  e.finishPromise ??= forceFlush(e)
    .catch(() => {})
    .then(() => {
      if (runs.get(runId) !== e) return;
      try {
        e.emitter.emit("done");
      } finally {
        if (runs.get(runId) === e) runs.delete(runId);
      }
    })
    .catch(() => {})
    .finally(e.resolveSettled);
  return e.finishPromise;
}

export function cancelRun(runId: string): boolean {
  const e = runs.get(runId);
  if (!e) return false;
  e.ctrl.abort();
  return true;
}

/**
 * Attach to a run: replays everything buffered so far, then streams live events until done.
 * If the run isn't in memory (already finished, or the daemon restarted), replays the
 * persisted log instead and ends — so a reconnecting client still sees the reached state.
 */
function shouldReplay(ev: unknown, afterSeq: number, seen: Set<number>): boolean {
  const seq = eventSeq(ev);
  if (ev && typeof ev === "object" && !Array.isArray(ev)) {
    const marker = ev as { type?: unknown; droppedThroughSeq?: unknown };
    if (marker.type === RUN_JOURNAL_TRUNCATED && typeof marker.droppedThroughSeq === "number" && Number.isFinite(marker.droppedThroughSeq)) {
      if (afterSeq >= marker.droppedThroughSeq) return false;
      if (seq !== null) {
        if (seen.has(seq)) return false;
        seen.add(seq);
      }
      return true;
    }
  }
  if (seq === null) return afterSeq <= 0;
  if (seq <= afterSeq || seen.has(seq)) return false;
  seen.add(seq);
  return true;
}

export function subscribe(
  runId: string,
  dataDir: string,
  onEvent: (ev: unknown) => void,
  onEnd: () => void,
  options: { afterSeq?: number } = {},
): () => void {
  const afterSeq = typeof options.afterSeq === "number" && Number.isFinite(options.afterSeq) ? options.afterSeq : 0;
  const seen = new Set<number>();
  const e = runs.get(runId);
  if (!e) {
    for (const ev of readRunLog(runLogPath(dataDir, runId))) {
      if (shouldReplay(ev, afterSeq, seen)) onEvent(ev);
    }
    onEnd();
    return () => {};
  }
  let ended = false;
  let replaying = true;
  const pending: unknown[] = [];
  const deliver = (ev: unknown): void => {
    if (shouldReplay(ev, afterSeq, seen)) onEvent(ev);
  };
  const onEv = (ev: unknown): void => {
    if (replaying) pending.push(ev);
    else deliver(ev);
  };
  const onDone = (): void => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  try {
    if (!e.done) {
      e.emitter.on("event", onEv);
      e.emitter.once("done", onDone);
    }
    for (const ev of e.buffer.values()) deliver(ev);
    for (let index = 0; index < pending.length; index++) deliver(pending[index]);
    replaying = false;
    if (e.done) onDone();
  } catch (err) {
    replaying = false;
    e.emitter.off("event", onEv);
    e.emitter.off("done", onDone);
    throw err;
  }
  return () => {
    e.emitter.off("event", onEv);
    e.emitter.off("done", onDone);
  };
}

export function readRunLog(logPath: string): unknown[] {
  if (!existsSync(logPath)) return [];
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return [];
  }
  const start = Math.max(0, size - RUN_JOURNAL_MAX_BYTES);
  const data = Buffer.alloc(Math.min(size, RUN_JOURNAL_MAX_BYTES));
  let bytesRead = 0;
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    while (bytesRead < data.length) {
      const count = readSync(fd, data, bytesRead, data.length - bytesRead, start + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close on a concurrently removed journal.
      }
    }
  }

  let text = data.subarray(0, bytesRead).toString("utf8");
  let droppedPrefixBytes = start;
  if (start > 0) {
    const newline = text.indexOf("\n");
    if (newline < 0) text = "";
    else {
      droppedPrefixBytes += Buffer.byteLength(text.slice(0, newline + 1), "utf8");
      text = text.slice(newline + 1);
    }
  }

  const bounded = new BoundedEventBuffer();
  let seededPrefix = start === 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!seededPrefix) {
      const seq = eventSeq(event);
      const throughSeq = seq === null ? 0 : Math.max(0, seq - 1);
      bounded.recordDroppedPrefix({
        droppedEvents: 1,
        droppedBytes: droppedPrefixBytes,
        droppedThroughSeq: throughSeq,
        markerSeq: throughSeq,
      });
      seededPrefix = true;
    }
    bounded.push(event);
  }
  if (!seededPrefix) {
    bounded.recordDroppedPrefix({
      droppedEvents: 1,
      droppedBytes: droppedPrefixBytes,
      droppedThroughSeq: 0,
      markerSeq: 0,
    });
  }
  return bounded.values();
}
