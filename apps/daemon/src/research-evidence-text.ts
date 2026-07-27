import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { types as nodeUtilTypes } from "node:util";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_PDF_PAGES = 64;
export const PRODUCTION_RESEARCH_EVIDENCE_EXTRACTION_TIMEOUT_MS = 5_000;
const MAX_EXTRACTION_STDOUT_BYTES = 768 * 1024;
const MAX_EXTRACTION_STDERR_BYTES = 64 * 1024;

export interface ProductionResearchEvidenceText {
  readonly protocol: "dezin.research-evidence-text.v1";
  readonly sourceMimeType: string;
  readonly sourceByteLength: number;
  readonly sourceChecksum: string;
  readonly text: string;
  readonly textByteLength: number;
  readonly textChecksum: string;
  readonly extractor: {
    readonly id: "dezin.html-visible-text" | "dezin.pdf-text" | "dezin.utf8-text";
    readonly version: 1;
  };
}

export interface ExtractProductionResearchEvidenceTextInput {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly signal: AbortSignal;
}

export class ResearchEvidenceTextError extends Error {
  readonly reason:
    | "unsupported-media-type"
    | "content-extraction-failed";

  constructor(
    reason: ResearchEvidenceTextError["reason"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ResearchEvidenceTextError";
    this.reason = reason;
  }
}

function fail(
  reason: ResearchEvidenceTextError["reason"],
  message: string,
  cause?: unknown,
): never {
  throw new ResearchEvidenceTextError(
    reason,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException(
    "Research evidence extraction aborted",
    "AbortError",
  );
}

function checksum(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function baseMimeType(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255
    || value !== value.trim() || value.includes("\0")) {
    return fail("unsupported-media-type", "Research evidence media type is invalid");
  }
  const base = value.split(";", 1)[0]!.trim().toLowerCase();
  if (base.length === 0) {
    return fail("unsupported-media-type", "Research evidence media type is invalid");
  }
  return base;
}

function normalizedText(value: string): string {
  const text = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  const byteLength = Buffer.byteLength(text, "utf8");
  if (text.length === 0 || byteLength > MAX_TEXT_BYTES) {
    return fail(
      "content-extraction-failed",
      "Research evidence canonical text is empty or exceeds its byte budget",
    );
  }
  return text;
}

function utf8Text(bytes: Uint8Array): string {
  try {
    return normalizedText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ResearchEvidenceTextError) throw error;
    return fail("content-extraction-failed", "Research text evidence is not UTF-8", error);
  }
}

type IsolatedExtractorId = "dezin.html-visible-text" | "dezin.pdf-text";

function decodeChildResult(
  value: unknown,
  expectedExtractorId: IsolatedExtractorId,
): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("content-extraction-failed", "Research extraction process returned an invalid result");
  }
  const result = value as {
    ok?: unknown;
    text?: unknown;
    extractorId?: unknown;
    message?: unknown;
    processId?: unknown;
  };
  if (!Number.isSafeInteger(result.processId) || Number(result.processId) < 1
    || result.processId === process.pid) {
    return fail(
      "content-extraction-failed",
      "Research extraction did not run in an isolated process",
    );
  }
  if (result.ok === false) {
    return fail(
      "content-extraction-failed",
      typeof result.message === "string" && result.message.length > 0
        ? result.message.slice(0, 1_024)
        : "Research evidence extraction failed",
    );
  }
  if (result.ok !== true || result.extractorId !== expectedExtractorId
    || typeof result.text !== "string") {
    return fail("content-extraction-failed", "Research extraction process returned an invalid result");
  }
  return normalizedText(result.text);
}

function spawnExtractionProcess(kind: "html" | "pdf"): ChildProcessWithoutNullStreams {
  const childPath = fileURLToPath(
    new URL("./research-evidence-extraction-child.ts", import.meta.url),
  );
  try {
    return spawn(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      "--max-old-space-size=128",
      "--max-semi-space-size=16",
      "--stack-size=4096",
      childPath,
      kind,
    ], {
      argv0: process.execPath,
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      detached: false,
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return fail("content-extraction-failed", "Research extraction process could not start", error);
  }
}

async function isolatedText(
  kind: "html" | "pdf",
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<{ text: string; extractorId: IsolatedExtractorId }> {
  checkAbort(signal);
  const child = spawnExtractionProcess(kind);
  const extractorId: IsolatedExtractorId = kind === "html"
    ? "dezin.html-visible-text"
    : "dezin.pdf-text";
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stdoutByteLength = 0;
    let stderrByteLength = 0;
    let spawnError: unknown;
    let forcedFailure: ResearchEvidenceTextError | null = null;
    const stdout: Buffer[] = [];
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      child.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
    };
    const settle = (readResult: () => string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve({ text: readResult(), extractorId });
      } catch (error) {
        reject(error);
      }
    };
    const terminate = (failure: ResearchEvidenceTextError): void => {
      if (settled) return;
      forcedFailure = failure;
      child.kill("SIGKILL");
    };
    const onAbort = (): void => {
      terminate(new ResearchEvidenceTextError(
        "content-extraction-failed",
        "Research evidence extraction aborted",
      ));
    };
    child.stdout.on("data", (raw: Buffer) => {
      const chunk = Buffer.from(raw);
      stdoutByteLength += chunk.byteLength;
      if (stdoutByteLength > MAX_EXTRACTION_STDOUT_BYTES) {
        terminate(new ResearchEvidenceTextError(
          "content-extraction-failed",
          "Research extraction process exceeded its output budget",
        ));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (raw: Buffer) => {
      stderrByteLength += raw.byteLength;
      if (stderrByteLength > MAX_EXTRACTION_STDERR_BYTES) {
        terminate(new ResearchEvidenceTextError(
          "content-extraction-failed",
          "Research extraction process exceeded its diagnostic budget",
        ));
      }
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, childSignal) => settle(() => {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException(
          "Research evidence extraction aborted",
          "AbortError",
        );
      }
      if (forcedFailure !== null) throw forcedFailure;
      if (spawnError !== undefined) {
        return fail(
          "content-extraction-failed",
          "Research extraction process failed to start",
          spawnError,
        );
      }
      if (code !== 0 || childSignal !== null) {
        return fail(
          "content-extraction-failed",
          "Research extraction process exited before returning evidence",
        );
      }
      let decoded: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(stdout, stdoutByteLength),
        );
        decoded = JSON.parse(text) as unknown;
      } catch (error) {
        return fail(
          "content-extraction-failed",
          "Research extraction process returned an invalid result",
          error,
        );
      }
      return decodeChildResult(decoded, extractorId);
    }));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    timer = setTimeout(() => terminate(new ResearchEvidenceTextError(
      "content-extraction-failed",
      "Research evidence extraction timed out",
    )), PRODUCTION_RESEARCH_EVIDENCE_EXTRACTION_TIMEOUT_MS);
    timer.unref();
    child.stdin.once("error", (error) => {
      spawnError ??= error;
      child.kill("SIGKILL");
    });
    child.stdin.end(Buffer.from(bytes));
  });
}

export async function extractProductionResearchEvidenceText(
  input: ExtractProductionResearchEvidenceTextInput,
): Promise<ProductionResearchEvidenceText> {
  if (!input || typeof input !== "object"
    || !(input.bytes instanceof Uint8Array) || nodeUtilTypes.isProxy(input.bytes)
    || input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_SOURCE_BYTES
    || !input.signal || typeof input.signal.aborted !== "boolean") {
    return fail("content-extraction-failed", "Research evidence extraction input is invalid");
  }
  checkAbort(input.signal);
  const sourceMimeType = baseMimeType(input.mimeType);
  const bytes = Buffer.from(input.bytes);
  let text: string;
  let extractor: ProductionResearchEvidenceText["extractor"];
  if (sourceMimeType === "text/html" || sourceMimeType === "application/xhtml+xml") {
    const isolated = await isolatedText("html", bytes, input.signal);
    text = isolated.text;
    extractor = { id: isolated.extractorId, version: 1 };
  } else if (sourceMimeType === "application/pdf") {
    const isolated = await isolatedText("pdf", bytes, input.signal);
    text = isolated.text;
    extractor = { id: isolated.extractorId, version: 1 };
  } else if (sourceMimeType.startsWith("text/")
    || sourceMimeType === "application/json" || sourceMimeType.endsWith("+json")
    || sourceMimeType === "application/xml" || sourceMimeType.endsWith("+xml")) {
    text = utf8Text(bytes);
    extractor = { id: "dezin.utf8-text", version: 1 };
  } else {
    return fail(
      "unsupported-media-type",
      "Research evidence media type does not expose bounded canonical text",
    );
  }
  checkAbort(input.signal);
  return Object.freeze({
    protocol: "dezin.research-evidence-text.v1",
    sourceMimeType,
    sourceByteLength: bytes.byteLength,
    sourceChecksum: checksum(bytes),
    text,
    textByteLength: Buffer.byteLength(text, "utf8"),
    textChecksum: checksum(text),
    extractor: Object.freeze(extractor),
  });
}

export const researchEvidenceTextLimits = Object.freeze({
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxTextBytes: MAX_TEXT_BYTES,
  maxPdfPages: MAX_PDF_PAGES,
});
