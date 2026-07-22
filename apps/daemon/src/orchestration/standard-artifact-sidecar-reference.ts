import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";

const MAX_TREE_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_FILES = 4_096;
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_PATH_BYTES = 8 * 1024;
const MAX_GIT_DIAGNOSTIC_BYTES = 64 * 1024;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const REGULAR_BLOB_MODES = new Set(["100644", "100755"]);
const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".cts",
  ".htm",
  ".html",
  ".js",
  ".json",
  ".json5",
  ".jsx",
  ".less",
  ".mdx",
  ".mjs",
  ".mts",
  ".sass",
  ".scss",
  ".svelte",
  ".svg",
  ".ts",
  ".tsx",
  ".vue",
]);
const SLASH_COMMENT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".js",
  ".json5",
  ".jsx",
  ".less",
  ".mdx",
  ".mjs",
  ".mts",
  ".sass",
  ".scss",
  ".ts",
  ".tsx",
]);
const HTML_COMMENT_EXTENSIONS = new Set([
  ".astro",
  ".htm",
  ".html",
  ".mdx",
  ".svelte",
  ".svg",
  ".vue",
]);
const EXCLUDED_DEPENDENCY_FILES = new Set(["npm-shrinkwrap.json", "package-lock.json"]);
// A browser can resolve all of these to the QA-only `public/_assets` mount,
// depending on the document or stylesheet directory. Keep the matcher scoped
// to a complete path segment so ordinary identifiers such as `cached_assets`
// are not rejected.
const ASSET_SIDECAR_REFERENCE = /(?:^|[^A-Za-z0-9._~%/-])((?:(?:\.\.\/)+|\.\/|\/)?_assets(?=\/|[?#]|$|[^A-Za-z0-9._~-]))/;

interface CandidateSourceBlob {
  path: string;
  oid: string;
  size: number;
}

export interface InspectCandidateSidecarReferencesInput {
  repositoryDir: string;
  commitHash: string;
  signal: AbortSignal;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason
    ?? new DOMException("Standard Artifact sidecar-reference inspection aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMPDIR",
    "TMP",
    "TEMP",
  ] as const) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

function gitBuffer(input: {
  cwd: string;
  args: readonly string[];
  signal: AbortSignal;
  maxOutputBytes: number;
  stdin?: Buffer;
}): Promise<Buffer> {
  checkAbort(input.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "--no-replace-objects",
        "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c", "core.fsmonitor=false",
        "-c", "core.attributesFile=/dev/null",
        ...input.args,
      ],
      {
        cwd: input.cwd,
        env: gitEnvironment(),
        signal: input.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > input.maxOutputBytes) {
        failure ??= new Error("Candidate source inspection exceeded its bounded Git output");
        child.kill("SIGKILL");
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_GIT_DIAGNOSTIC_BYTES) {
        failure ??= new Error("Candidate source inspection exceeded its bounded Git diagnostics");
        child.kill("SIGKILL");
        return;
      }
      stderr.push(Buffer.from(chunk));
    });
    child.on("error", (error) => finish(() => reject(
      input.signal.aborted ? abortReason(input.signal) : error,
    )));
    child.on("close", (code) => finish(() => {
      if (input.signal.aborted) {
        reject(abortReason(input.signal));
      } else if (failure) {
        reject(failure);
      } else if (code !== 0) {
        // Git diagnostics can contain repository paths. Keep the public error
        // deliberately content-free while still failing the quality gate.
        reject(new Error("Candidate source inspection Git command failed"));
      } else {
        resolve(Buffer.concat(stdout));
      }
    }));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") finish(() => reject(error));
    });
    child.stdin.end(input.stdin);
  });
}

function sourceExtension(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

function isImmutableSidecarPath(path: string): boolean {
  if (path === ".sharingan" || path.startsWith(".sharingan/")) return true;
  return path === "public/_assets" || path.startsWith("public/_assets/");
}

function isDependencyMetadata(path: string): boolean {
  const fileName = path.split("/").at(-1)?.toLowerCase();
  return fileName !== undefined && EXCLUDED_DEPENDENCY_FILES.has(fileName);
}

function safeSourcePath(pathBytes: Buffer): string | undefined {
  if (pathBytes.length === 0 || pathBytes.length > MAX_SOURCE_PATH_BYTES) return undefined;
  let path: string;
  try {
    path = FATAL_UTF8.decode(pathBytes);
  } catch {
    return undefined;
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return undefined;
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) return undefined;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return path;
}

async function listCandidateSourceBlobs(
  input: InspectCandidateSidecarReferencesInput,
): Promise<{ blobs: CandidateSourceBlob[]; unsafePath?: string }> {
  const output = await gitBuffer({
    cwd: input.repositoryDir,
    args: ["ls-tree", "-r", "-z", "-l", input.commitHash],
    signal: input.signal,
    maxOutputBytes: MAX_TREE_OUTPUT_BYTES,
  });
  checkAbort(input.signal);
  const blobs: CandidateSourceBlob[] = [];
  let totalBytes = 0;
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    if (end < 0) throw new Error("Candidate source tree listing is not NUL terminated");
    const record = output.subarray(offset, end);
    offset = end + 1;
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error("Candidate source tree listing is malformed");
    const header = record.subarray(0, tab).toString("ascii");
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\s+(\d+|-)$/u.exec(header);
    if (!match) throw new Error("Candidate source tree entry is malformed");
    const mode = match[1];
    const type = match[2];
    const oid = match[3];
    const sizeText = match[4];
    if (mode === undefined || type === undefined || oid === undefined || sizeText === undefined) {
      throw new Error("Candidate source tree entry is incomplete");
    }
    const path = safeSourcePath(record.subarray(tab + 1));
    if (path === undefined) return { blobs, unsafePath: "<unportable-path>" };
    if (isImmutableSidecarPath(path)) continue;
    // Validate every candidate-owned tree entry before filtering source text.
    // Otherwise a binary-looking symlink can point into the ephemeral sidecar
    // while HTML references a seemingly candidate-owned URL.
    if (type !== "blob" || !REGULAR_BLOB_MODES.has(mode)) {
      return { blobs, unsafePath: path };
    }
    if (isDependencyMetadata(path) || !SOURCE_EXTENSIONS.has(sourceExtension(path))) continue;
    if (sizeText === "-") return { blobs, unsafePath: path };
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SOURCE_FILE_BYTES) {
      return { blobs, unsafePath: path };
    }
    totalBytes += size;
    if (blobs.length >= MAX_SOURCE_FILES || totalBytes > MAX_SOURCE_TOTAL_BYTES) {
      return { blobs, unsafePath: path };
    }
    blobs.push({ path, oid, size });
  }
  return { blobs };
}

function lineNumber(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function maskCommentCharacter(characters: string[], index: number): void {
  if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
}

function maskSlashComments(text: string): string {
  const characters = [...text];
  let state: "code" | "single" | "double" | "template" | "line" | "block" = "code";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    const next = characters[index + 1];
    if (state === "line") {
      if (character === "\n" || character === "\r") state = "code";
      else maskCommentCharacter(characters, index);
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        maskCommentCharacter(characters, index);
        maskCommentCharacter(characters, index + 1);
        index += 1;
        state = "code";
      } else {
        maskCommentCharacter(characters, index);
      }
      continue;
    }
    if (state !== "code") {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if ((state === "single" && character === "'")
        || (state === "double" && character === '"')
        || (state === "template" && character === "`")) {
        state = "code";
      }
      continue;
    }
    if (character === "'") {
      state = "single";
    } else if (character === '"') {
      state = "double";
    } else if (character === "`") {
      state = "template";
    } else if (character === "/" && next === "/") {
      maskCommentCharacter(characters, index);
      maskCommentCharacter(characters, index + 1);
      index += 1;
      state = "line";
    } else if (character === "/" && next === "*") {
      maskCommentCharacter(characters, index);
      maskCommentCharacter(characters, index + 1);
      index += 1;
      state = "block";
    }
  }
  return characters.join("");
}

function maskHtmlComments(text: string): string {
  const characters = [...text];
  let quote: "'" | '"' | "`" | null = null;
  let comment = false;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (comment) {
      if (character === "-" && characters[index + 1] === "-" && characters[index + 2] === ">") {
        maskCommentCharacter(characters, index);
        maskCommentCharacter(characters, index + 1);
        maskCommentCharacter(characters, index + 2);
        index += 2;
        comment = false;
      } else {
        maskCommentCharacter(characters, index);
      }
      continue;
    }
    if (quote !== null) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "<" && characters[index + 1] === "!"
      && characters[index + 2] === "-" && characters[index + 3] === "-") {
      for (let marker = 0; marker < 4; marker += 1) {
        maskCommentCharacter(characters, index + marker);
      }
      index += 3;
      comment = true;
    }
  }
  return characters.join("");
}

function maskSourceComments(path: string, text: string): string {
  const extension = sourceExtension(path);
  let result = HTML_COMMENT_EXTENSIONS.has(extension) ? maskHtmlComments(text) : text;
  if (SLASH_COMMENT_EXTENSIONS.has(extension)) result = maskSlashComments(result);
  return result;
}

function inspectTextBlob(path: string, bytes: Buffer): string {
  if (bytes.indexOf(0) >= 0) return `!! unsafe candidate source blob: ${path}`;
  let text: string;
  try {
    text = FATAL_UTF8.decode(bytes);
  } catch {
    return `!! unsafe candidate source blob: ${path}`;
  }
  const match = ASSET_SIDECAR_REFERENCE.exec(maskSourceComments(path, text));
  if (!match) return "";
  const reference = match[1];
  if (reference === undefined) throw new Error("Candidate sidecar reference match is incomplete");
  const referenceIndex = match.index + match[0].lastIndexOf(reference);
  return `!! immutable Sharingan asset sidecar reference: ${path}:${lineNumber(text, referenceIndex)}`;
}

async function inspectCandidateSourceBlobs(input: {
  repositoryDir: string;
  blobs: readonly CandidateSourceBlob[];
  signal: AbortSignal;
}): Promise<string> {
  if (input.blobs.length === 0) return "";
  const totalBytes = input.blobs.reduce((sum, blob) => sum + blob.size, 0);
  const output = await gitBuffer({
    cwd: input.repositoryDir,
    args: ["cat-file", "--batch"],
    signal: input.signal,
    maxOutputBytes: totalBytes + input.blobs.length * 256,
    stdin: Buffer.from(`${input.blobs.map((blob) => blob.oid).join("\n")}\n`, "ascii"),
  });
  checkAbort(input.signal);
  let offset = 0;
  for (const blob of input.blobs) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) throw new Error("Candidate source blob response is malformed");
    const header = output.subarray(offset, headerEnd).toString("ascii");
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob (\d+)$/u.exec(header);
    if (!match || match[1] !== blob.oid || Number(match[2]) !== blob.size) {
      throw new Error("Candidate source blob identity changed during inspection");
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + blob.size;
    if (contentEnd >= output.length || output[contentEnd] !== 10) {
      throw new Error("Candidate source blob response is truncated");
    }
    const status = inspectTextBlob(blob.path, output.subarray(contentStart, contentEnd));
    if (status !== "") return status;
    offset = contentEnd + 1;
  }
  if (offset !== output.length) throw new Error("Candidate source blob response has trailing data");
  return "";
}

/**
 * Inspects only bounded regular text blobs from the exact candidate commit.
 * It never reads the mutable worktree, so the visible immutable sidecars,
 * symlink targets, and binary payloads cannot escape this check. Source-like
 * blobs remain in scope even below dependency/generated directory names,
 * because the committed runtime may import or serve any of those paths.
 * The literal check is intentionally conservative defense in depth; the
 * runtime asset fence is the authoritative dynamic dependency gate.
 */
export async function inspectCandidateSidecarReferences(
  input: InspectCandidateSidecarReferencesInput,
): Promise<string> {
  checkAbort(input.signal);
  const listed = await listCandidateSourceBlobs(input);
  if (listed.unsafePath !== undefined) {
    return `!! unsafe candidate source blob: ${listed.unsafePath}`;
  }
  return inspectCandidateSourceBlobs({
    repositoryDir: input.repositoryDir,
    blobs: listed.blobs,
    signal: input.signal,
  });
}
