import type { IncomingMessage, ServerResponse } from "node:http";

import type { DesignInvalidationMessage } from "@dezin/design-canvas-contracts";

import {
  designInvalidationRoot,
  subscribeDesignInvalidations,
} from "./design-invalidation-journal.ts";
import { getDesignCanvas } from "./design-storage.ts";

function lastEventId(req: IncomingMessage): string | null {
  const value = req.headers["last-event-id"];
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.trim() || null;
}

function parsedCursor(value: string | null): { epoch: string; sequence: number } | null {
  if (value === null) return null;
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const rawSequence = value.slice(separator + 1);
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawSequence)) return null;
  const sequence = Number(rawSequence);
  if (!Number.isSafeInteger(sequence)) return null;
  return { epoch: value.slice(0, separator), sequence };
}

function writeEvent(res: ServerResponse, message: DesignInvalidationMessage): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`id: ${message.cursor}\nevent: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`);
}

export async function handleDesignInvalidationEvents(
  req: IncomingMessage,
  res: ServerResponse,
  input: { dataDir: string; projectId: string; signal: AbortSignal },
): Promise<void> {
  await getDesignCanvas(input.dataDir, input.projectId);
  input.signal.throwIfAborted();
  const root = designInvalidationRoot(input.dataDir, input.projectId);
  const requestedCursor = lastEventId(req);
  const queued: DesignInvalidationMessage[] = [];
  let acceptingLiveEvents = false;
  let lastWrittenEpoch: string | null = null;
  let lastWrittenSequence = -1;
  const writeNewEvent = (message: DesignInvalidationMessage): void => {
    if (message.epoch === lastWrittenEpoch && message.sequence <= lastWrittenSequence) return;
    writeEvent(res, message);
    lastWrittenEpoch = message.epoch;
    lastWrittenSequence = message.sequence;
  };
  const subscription = await subscribeDesignInvalidations(
    root,
    requestedCursor,
    (event) => {
      if (!acceptingLiveEvents) queued.push(event);
      else writeNewEvent(event);
    },
  );
  if (subscription.initial.length === 0) {
    const parsed = parsedCursor(requestedCursor);
    if (parsed) {
      lastWrittenEpoch = parsed.epoch;
      lastWrittenSequence = parsed.sequence;
    }
  }
  try {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    for (const message of subscription.initial) writeNewEvent(message);
    queued.sort((left, right) => (
      left.epoch === right.epoch ? left.sequence - right.sequence : 0
    ));
    for (const message of queued) writeNewEvent(message);
    queued.length = 0;
    acceptingLiveEvents = true;
  } catch (error) {
    subscription.unsubscribe();
    throw error;
  }

  await new Promise<void>((resolve) => {
    let finished = false;
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(": keepalive\n\n");
    }, 15_000);
    heartbeat.unref?.();
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      subscription.unsubscribe();
      req.off("aborted", finish);
      res.off("close", finish);
      input.signal.removeEventListener("abort", finish);
      if (!res.destroyed && !res.writableEnded) res.end();
      resolve();
    };
    req.once("aborted", finish);
    res.once("close", finish);
    input.signal.addEventListener("abort", finish, { once: true });
    if (input.signal.aborted || req.aborted || res.destroyed) finish();
  });
}
