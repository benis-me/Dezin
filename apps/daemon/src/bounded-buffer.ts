export const RUN_JOURNAL_MAX_EVENTS = 2_000;
export const RUN_JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
export const RUN_JOURNAL_TRUNCATED = "run-journal-truncated";

interface BufferedEvent {
  event: unknown;
  line: string;
  bytes: number;
  terminal: boolean;
  seq: number | null;
}

interface TruncationState {
  markerSeq: number;
  droppedEvents: number;
  droppedBytes: number;
  droppedThroughSeq: number;
}

function eventSeq(event: unknown): number | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  try {
    const seq = (event as { seq?: unknown }).seq;
    return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
  } catch {
    return null;
  }
}

function eventType(event: unknown): string {
  if (!event || typeof event !== "object" || Array.isArray(event)) return "";
  try {
    return typeof (event as { type?: unknown }).type === "string" ? (event as { type: string }).type : "";
  } catch {
    return "";
  }
}

function isTerminal(event: unknown): boolean {
  return ["run-done", "run-error", "run-cancelled"].includes(eventType(event));
}

function jsonLine(event: unknown): string | null {
  try {
    const encoded = JSON.stringify(event);
    return encoded === undefined ? null : `${encoded}\n`;
  } catch {
    return null;
  }
}

function compactTerminal(event: unknown, seq: number | null, maxBytes: number): Record<string, unknown> {
  let runId: string | undefined;
  try {
    const candidate = event && typeof event === "object" && !Array.isArray(event)
      ? (event as { runId?: unknown }).runId
      : undefined;
    if (typeof candidate === "string") runId = candidate;
  } catch {
    // A hostile getter must not prevent terminalization.
  }
  const base = {
    type: eventType(event),
    ...(seq === null ? {} : { seq }),
    truncated: true,
  };
  const withRunId = runId ? { ...base, runId } : base;
  const encoded = jsonLine(withRunId);
  return encoded && Buffer.byteLength(encoded, "utf8") < maxBytes ? withRunId : base;
}

/** A byte-and-count bounded replay buffer with one stable truncation marker. */
export class BoundedEventBuffer {
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly markerType: string;
  private readonly items: BufferedEvent[] = [];
  private itemBytes = 0;
  private truncation: TruncationState | null = null;

  constructor(maxEvents = RUN_JOURNAL_MAX_EVENTS, maxBytes = RUN_JOURNAL_MAX_BYTES, markerType = RUN_JOURNAL_TRUNCATED) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new Error("maxEvents must be positive");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new Error("maxBytes is too small");
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    this.markerType = markerType;
  }

  push(event: unknown): void {
    const seq = eventSeq(event);
    const terminal = isTerminal(event);
    let stored = event;
    let line = jsonLine(stored);
    if (!line) {
      stored = terminal
        ? compactTerminal(event, seq, this.maxBytes)
        : { type: "run-event-unserializable", ...(seq === null ? {} : { seq }) };
      line = jsonLine(stored)!;
    }
    if (Buffer.byteLength(line, "utf8") >= this.maxBytes) {
      if (terminal) {
        stored = compactTerminal(event, seq, this.maxBytes);
        line = jsonLine(stored)!;
      } else {
        this.noteDrop({ event: stored, line, bytes: Buffer.byteLength(line), terminal: false, seq });
        this.enforce();
        return;
      }
    }
    const item = { event: stored, line, bytes: Buffer.byteLength(line, "utf8"), terminal: isTerminal(stored), seq };
    this.items.push(item);
    this.itemBytes += item.bytes;
    this.enforce();
  }

  values(): unknown[] {
    return [...(this.truncation ? [this.marker()] : []), ...this.items.map((item) => item.event)];
  }

  toJsonl(): string {
    return `${this.truncation ? this.markerLine() : ""}${this.items.map((item) => item.line).join("")}`;
  }

  get length(): number {
    return this.items.length + (this.truncation ? 1 : 0);
  }

  get byteLength(): number {
    return this.itemBytes + (this.truncation ? Buffer.byteLength(this.markerLine(), "utf8") : 0);
  }

  get truncated(): boolean {
    return this.truncation !== null;
  }

  /** Seed truncation metadata when loading only the bounded tail of a legacy journal. */
  recordDroppedPrefix(input: {
    droppedEvents: number;
    droppedBytes: number;
    droppedThroughSeq: number;
    markerSeq?: number;
  }): void {
    const droppedEvents = Math.max(1, Math.trunc(input.droppedEvents));
    const droppedBytes = Math.max(0, Math.trunc(input.droppedBytes));
    const droppedThroughSeq = Number.isFinite(input.droppedThroughSeq) ? input.droppedThroughSeq : 0;
    if (!this.truncation) {
      this.truncation = {
        markerSeq: Number.isFinite(input.markerSeq) ? input.markerSeq! : droppedThroughSeq,
        droppedEvents,
        droppedBytes,
        droppedThroughSeq,
      };
    } else {
      this.truncation.droppedEvents += droppedEvents;
      this.truncation.droppedBytes += droppedBytes;
      this.truncation.droppedThroughSeq = Math.max(this.truncation.droppedThroughSeq, droppedThroughSeq);
    }
    this.enforce();
  }

  private marker(): unknown {
    const state = this.truncation!;
    return {
      type: this.markerType,
      seq: state.markerSeq,
      droppedEvents: state.droppedEvents,
      droppedBytes: state.droppedBytes,
      droppedThroughSeq: state.droppedThroughSeq,
    };
  }

  private markerLine(): string {
    return jsonLine(this.marker())!;
  }

  private noteDrop(item: BufferedEvent): void {
    const seq = item.seq ?? this.truncation?.droppedThroughSeq ?? 0;
    if (!this.truncation) {
      this.truncation = {
        markerSeq: seq,
        droppedEvents: 0,
        droppedBytes: 0,
        droppedThroughSeq: seq,
      };
    }
    this.truncation.droppedEvents += 1;
    this.truncation.droppedBytes += item.bytes;
    this.truncation.droppedThroughSeq = Math.max(this.truncation.droppedThroughSeq, seq);
  }

  private enforce(): void {
    for (;;) {
      const overCount = this.length > this.maxEvents;
      const overBytes = this.byteLength > this.maxBytes;
      if (!overCount && !overBytes) return;
      const removeAt = this.items.findIndex((item) => !item.terminal);
      if (removeAt < 0) return;
      const [removed] = this.items.splice(removeAt, 1);
      if (!removed) return;
      this.itemBytes -= removed.bytes;
      this.noteDrop(removed);
    }
  }
}
