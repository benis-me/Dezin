/**
 * GET /api/projects/:id/export — zip the project's on-disk artifact folder and
 * return it as a download. With ?scope=full, also includes project metadata and
 * conversations so the archive can be imported on another Dezin instance.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { dirname, join, relative, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError, sendJson, readRawBody } from "./http-util.ts";
import { streamZip, type StreamingZipEntry } from "./zip.ts";
import type { AppDeps } from "./app.ts";
import { activeArtifactDir, standardVariantArtifactDir, variantArtifactDir } from "./variant-workspaces.ts";
import { projectDir, safeJoin } from "./serve-static.ts";
import { setupImportedStandardProject } from "./project-runtime.ts";
import type { MessageRole, Project, QualityFinding, RunStatus } from "../../../packages/core/src/index.ts";
import type { ProjectMode } from "../../../packages/core/src/types.ts";
import { BoundedTextBuffer } from "../../../packages/agent/src/index.ts";

export interface FileRef {
  rel: string;
  abs: string;
}

// Keep source-level dotfiles, but skip dependency output, build caches,
// Dezin runtime internals, git history, and local secrets.
const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".refs",
  ".versions",
  ".runs",
  ".variants",
  ".dev",
  ".vite",
  ".turbo",
  ".next",
  ".cache",
]);
const IGNORE_FILES = new Set([".DS_Store", ".cover.png"]);
const MANIFEST_PATH = "dezin-project.json";
const IMPORT_REQUEST_SCOPE_ID = "__daemon_project_import__";
export const MAX_PROJECT_ARCHIVE_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_PROJECT_ARCHIVE_ENTRIES = 20_000;
export const MAX_EXPORT_ENTRIES = 10_000;
export const MAX_EXPORT_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_EXPORT_TOTAL_BYTES = 512 * 1024 * 1024;

function isSecretEnvFile(name: string): boolean {
  if (name === ".env" || name === ".envrc") return true;
  if (!name.startsWith(".env.")) return false;
  return ![".env.example", ".env.sample", ".env.template"].some(
    (allowed) => name === allowed || name.startsWith(`${allowed}.`),
  );
}

function shouldSkipFileName(name: string): boolean {
  return IGNORE_FILES.has(name) || isSecretEnvFile(name);
}

function shouldSkipArchiveSourcePath(rel: string): boolean {
  const parts = rel.split("/");
  return parts.some((part) => IGNORE_DIRS.has(part)) || shouldSkipFileName(parts[parts.length - 1] ?? "");
}

export async function walkFiles(
  root: string,
  dir: string = root,
  out: FileRef[] = [],
  options: { signal?: AbortSignal; maxFiles?: number } = {},
): Promise<FileRef[]> {
  options.signal?.throwIfAborted();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const e of entries) {
    options.signal?.throwIfAborted();
    if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
    if (e.isFile() && shouldSkipFileName(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(root, abs, out, options);
    else if (e.isFile()) {
      out.push({ rel: relative(root, abs).split(sep).join("/"), abs });
      if (out.length > (options.maxFiles ?? Number.POSITIVE_INFINITY)) throw new ExportLimitError("export has too many entries");
    }
  }
  return out;
}

export class ExportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportLimitError";
  }
}

/** One budget shared by every logical section in a project export. */
export class ExportBudget {
  private readonly paths = new Set<string>();
  private count = 0;
  private bytes = 0;

  remainingEntries(): number {
    return Math.max(0, MAX_EXPORT_ENTRIES - this.count);
  }

  reserve(path: string, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) throw new ExportLimitError(`invalid export size for ${path}`);
    if (this.paths.has(path)) throw new ExportLimitError(`duplicate export path: ${path}`);
    if (size > MAX_EXPORT_FILE_BYTES) throw new ExportLimitError(`export entry exceeds 64 MiB: ${path}`);
    if (this.count + 1 > MAX_EXPORT_ENTRIES) throw new ExportLimitError("export has more than 10,000 entries");
    if (this.bytes + size > MAX_EXPORT_TOTAL_BYTES) throw new ExportLimitError("export exceeds 512 MiB uncompressed");
    this.paths.add(path);
    this.count += 1;
    this.bytes += size;
  }
}

interface PreparedExport {
  entries: StreamingZipEntry[];
  cleanup(): Promise<void>;
}

function memoryExportEntry(path: string, data: Uint8Array | string, budget: ExportBudget): StreamingZipEntry {
  const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  budget.reserve(path, buffer.length);
  return {
    path,
    expectedSize: buffer.length,
    async *open() {
      if (buffer.length) yield buffer;
    },
  };
}

async function fileExportEntry(path: string, abs: string, budget: ExportBudget, signal?: AbortSignal): Promise<StreamingZipEntry> {
  signal?.throwIfAborted();
  const info = await stat(abs);
  signal?.throwIfAborted();
  if (!info.isFile()) throw new ExportLimitError(`export source is not a file: ${path}`);
  budget.reserve(path, info.size);
  return {
    path,
    expectedSize: info.size,
    open: () => createReadStream(abs, { highWaterMark: 64 * 1024, signal }),
  };
}

async function fileEntries(
  prefix: string,
  root: string,
  budget: ExportBudget,
  signal?: AbortSignal,
): Promise<StreamingZipEntry[]> {
  const files = await walkFiles(root, root, [], { signal, maxFiles: budget.remainingEntries() });
  const out: StreamingZipEntry[] = [];
  for (const file of files) {
    signal?.throwIfAborted();
    out.push(await fileExportEntry(entryPath(prefix, file.rel), file.abs, budget, signal));
  }
  return out;
}

export async function handleExport(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  const id = params.id!;
  const project = deps.store.getProject(id);
  if (!project) return sendError(res, 404, "project not found");

  const full = new URL(req.url ?? "/", "http://localhost").searchParams.get("scope") === "full";
  let prepared: PreparedExport | undefined;
  try {
    prepared = await prepareExport(project, deps, full, signal);
    if (prepared.entries.length === 0) return sendError(res, 404, "no artifacts to export");
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof ExportLimitError) return sendError(res, 413, error.message);
    throw error;
  }

  try {
    signal?.throwIfAborted();
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${full ? "dezin-full-project" : "dezin-project"}-${id}.zip"`,
    });
    await streamZip(
      prepared.entries,
      (chunk) => writeResponseChunk(res, chunk, signal),
      {
        signal,
        onEntryBytes: (entry, bytesRead) => {
          if (bytesRead > MAX_EXPORT_FILE_BYTES) throw new ExportLimitError(`export entry exceeds 64 MiB: ${entry.path}`);
        },
      },
    );
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (!res.headersSent) {
      if (error instanceof ExportLimitError) return sendError(res, 413, error.message);
      throw error;
    }
    res.destroy(error instanceof Error ? error : undefined);
  } finally {
    await prepared.cleanup();
  }
}

function entryPath(prefix: string, rel: string): string {
  const base = prefix.replace(/\/$/, "");
  return base ? `${base}/${rel}` : rel;
}

function writeResponseChunk(res: ServerResponse, chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (res.write(Buffer.from(chunk))) return Promise.resolve();
  return new Promise((resolveWrite, reject) => {
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      res.off("drain", onDrain);
      res.off("error", onError);
      res.off("close", onClose);
    };
    const finish = (error?: unknown): void => {
      cleanup();
      if (error) reject(error);
      else resolveWrite();
    };
    const onDrain = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error("export response closed"));
    const onAbort = (): void => finish(signal?.reason ?? new Error("export aborted"));
    res.once("drain", onDrain);
    res.once("error", onError);
    res.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ code: number; out: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const out = new BoundedTextBuffer(1024 * 1024);
    let spawnError: Error | undefined;
    let settled = false;
    let terminationPromise: Promise<void> | undefined;
    const kill = (killSignal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, killSignal);
        else child.kill(killSignal);
      } catch {
        // Process already exited.
      }
    };
    const groupAlive = (): boolean => {
      if (!child.pid || process.platform === "win32") return child.exitCode === null && child.signalCode === null;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const waitForGroup = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (groupAlive() && Date.now() < deadline) {
        await new Promise<void>((resolveDelay) => {
          const timer = setTimeout(resolveDelay, 10);
          timer.unref?.();
        });
      }
      return !groupAlive();
    };
    const terminate = (): Promise<void> => {
      if (terminationPromise) return terminationPromise;
      kill("SIGTERM");
      terminationPromise = (async () => {
        if (await waitForGroup(1_000)) return;
        kill("SIGKILL");
        await waitForGroup(1_000);
      })();
      return terminationPromise;
    };
    const onAbort = (): void => { void terminate(); };
    const append = (chunk: Buffer | Uint8Array): void => out.append(chunk);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      void (async () => {
        await terminationPromise?.catch(() => {});
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        resolve({ code: code ?? 1, out: spawnError?.message ?? out.toString() });
      })();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function maybeGitBundleEntry(
  root: string,
  deps: AppDeps,
  projectId: string,
  budget: ExportBudget,
  signal?: AbortSignal,
): Promise<{ entry: StreamingZipEntry; tmp: string } | null> {
  if (!existsSync(join(root, ".git"))) return null;
  const tmp = join(deps.dataDir, ".exports", `${projectId}-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
  try {
    await mkdir(dirname(tmp), { recursive: true });
    const res = await runCommand("git", ["bundle", "create", tmp, "--all"], root, signal);
    signal?.throwIfAborted();
    if (res.code !== 0) {
      await rm(tmp, { force: true }).catch(() => {});
      return null;
    }
    return { entry: await fileExportEntry("standard/git.bundle", tmp, budget, signal), tmp };
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function prepareExport(
  project: Project,
  deps: AppDeps,
  full: boolean,
  signal?: AbortSignal,
): Promise<PreparedExport> {
  const root = projectDir(deps.dataDir, project.id);
  const activeDir = await activeArtifactDir(deps, project);
  const budget = new ExportBudget();
  const temporary: string[] = [];
  if (!full) {
    return {
      entries: await fileEntries("", activeDir, budget, signal),
      cleanup: async () => {},
    };
  }
  deps.store.ensureMainVariant(project.id);
  const variants = deps.store.listVariants(project.id);
  const runs = deps.store.listRuns(project.id);
  const manifest = {
    format: "dezin-project",
    version: 2,
    exportedAt: Date.now(),
    project: {
      id: project.id,
      name: project.name,
      skillId: project.skillId,
      designSystemId: project.designSystemId,
      mode: project.mode,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      archivedAt: project.archivedAt,
    },
    variants: variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      createdAt: variant.createdAt,
      active: Boolean(variant.active),
    })),
    conversations: deps.store.listConversations(project.id).map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      messages: deps.store.listMessages(conversation.id).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })),
    })),
    runs: runs.map((run) => ({
      id: run.id,
      conversationId: run.conversationId,
      userMessageId: run.userMessageId,
      assistantMessageId: run.assistantMessageId,
      variantId: run.variantId,
      commitHash: run.commitHash,
      status: run.status,
      repairRounds: run.repairRounds,
      lintPassed: run.lintPassed,
      score: run.score,
      findings: run.findings,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
    })),
    artifacts: deps.store.listArtifacts(project.id).map((artifact) => ({
      path: artifact.path,
      lintPassed: artifact.lintPassed,
      createdAt: artifact.createdAt,
    })),
  };
  try {
    const sourceEntries = await fileEntries("source", activeDir, budget, signal);
    if (sourceEntries.length === 0) return { entries: [], cleanup: async () => {} };
    const entries: StreamingZipEntry[] = [
      memoryExportEntry(MANIFEST_PATH, JSON.stringify(manifest, null, 2), budget),
      ...sourceEntries,
    ];
    entries.push(...await fileEntries("refs", join(root, ".refs"), budget, signal));
    const activeVariantId = deps.store.getActiveVariantId(project.id);
    for (const variant of variants) {
      signal?.throwIfAborted();
      if (variant.id === activeVariantId) continue;
      const dir = await variantArtifactDir(deps, project, variant.id).catch(() => null);
      if (!dir) continue;
      entries.push(...await fileEntries(`variants/${variant.id}`, dir, budget, signal));
    }
    entries.push(...await fileEntries("versions", join(root, ".versions"), budget, signal));
    for (const run of runs) {
      signal?.throwIfAborted();
      const log = join(deps.dataDir, ".runs", `${run.id}.jsonl`);
      if (existsSync(log)) entries.push(await fileExportEntry(`runs/${run.id}.jsonl`, log, budget, signal));
      entries.push(...await fileEntries(`runs/${run.id}`, join(deps.dataDir, ".runs", run.id), budget, signal));
    }
    const gitBundle = project.mode === "standard" ? await maybeGitBundleEntry(root, deps, project.id, budget, signal) : null;
    if (gitBundle) {
      entries.push(gitBundle.entry);
      temporary.push(gitBundle.tmp);
    }
    const cover = join(root, ".cover.png");
    if (existsSync(cover)) entries.push(await fileExportEntry("cover.png", cover, budget, signal));
    return {
      entries,
      cleanup: async () => {
        await Promise.all(temporary.map((path) => rm(path, { force: true }).catch(() => {})));
      },
    };
  } catch (error) {
    await Promise.all(temporary.map((path) => rm(path, { force: true }).catch(() => {})));
    throw error;
  }
}

interface ImportManifest {
  format?: string;
  version?: unknown;
  project?: {
    id?: unknown;
    name?: unknown;
    skillId?: unknown;
    designSystemId?: unknown;
    mode?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    archivedAt?: unknown;
  };
  variants?: Array<{
    id?: unknown;
    name?: unknown;
    createdAt?: unknown;
    active?: unknown;
  }>;
  conversations?: Array<{
    id?: unknown;
    title?: unknown;
    createdAt?: unknown;
    messages?: Array<{
      id?: unknown;
      role?: unknown;
      content?: unknown;
      createdAt?: unknown;
    }>;
  }>;
  runs?: Array<{
    id?: unknown;
    conversationId?: unknown;
    userMessageId?: unknown;
    assistantMessageId?: unknown;
    variantId?: unknown;
    commitHash?: unknown;
    status?: unknown;
    repairRounds?: unknown;
    lintPassed?: unknown;
    score?: unknown;
    findings?: unknown;
    createdAt?: unknown;
    finishedAt?: unknown;
  }>;
  artifacts?: Array<{
    path?: unknown;
    lintPassed?: unknown;
    createdAt?: unknown;
  }>;
}

interface ZipFileEntry {
  path: string;
  data: Buffer;
}

function inflateZipEntry(raw: Buffer, maxOutputLength: number): Buffer {
  try {
    return inflateRawSync(raw, { maxOutputLength });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/larger than/i.test(message)) throw new Error("archive exceeds decompressed size limit");
    throw err;
  }
}

function decodeZipEntry(
  zip: Buffer,
  input: { path: string; method: number; compSize: number; uncompSize: number; dataStart: number },
  remaining: number,
): Buffer {
  const dataEnd = input.dataStart + input.compSize;
  if (dataEnd > zip.length) throw new Error("truncated zip entry");
  if (input.method !== 0 && input.method !== 8) throw new Error("unsupported zip compression");
  const declaredSize = input.method === 0 ? input.compSize : input.uncompSize;
  if (declaredSize > remaining) throw new Error("archive exceeds decompressed size limit");
  const raw = zip.subarray(input.dataStart, dataEnd);
  return input.method === 0 ? Buffer.from(raw) : inflateZipEntry(raw, Math.min(remaining, input.uncompSize));
}

function findEndOfCentralDirectory(zip: Buffer): number {
  if (zip.length < 22) return -1;
  const start = Math.max(0, zip.length - 0xffff - 22);
  for (let offset = zip.length - 22; offset >= start; offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readCentralZipEntries(zip: Buffer, eocd: number): ZipFileEntry[] {
  const out: ZipFileEntry[] = [];
  const count = zip.readUInt16LE(eocd + 10);
  if (count > MAX_PROJECT_ARCHIVE_ENTRIES) throw new Error("archive has too many entries");
  let offset = zip.readUInt32LE(eocd + 16);
  const centralSize = zip.readUInt32LE(eocd + 12);
  if (offset + centralSize > eocd) throw new Error("invalid zip central directory");
  const centralEnd = offset + centralSize;
  let uncompressedBytes = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid zip central directory");
    const method = zip.readUInt16LE(offset + 10);
    const compSize = zip.readUInt32LE(offset + 20);
    const uncompSize = zip.readUInt32LE(offset + 24);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    if (offset + 46 + nameLen + extraLen + commentLen > centralEnd) throw new Error("truncated zip central entry");
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("invalid zip local header");
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const path = zip.toString("utf8", offset + 46, offset + 46 + nameLen);
    const remaining = MAX_PROJECT_ARCHIVE_UNCOMPRESSED_BYTES - uncompressedBytes;
    const data = decodeZipEntry(zip, {
      path,
      method,
      compSize,
      uncompSize,
      dataStart: localOffset + 30 + localNameLen + localExtraLen,
    }, remaining);
    uncompressedBytes += data.length;
    if (uncompressedBytes > MAX_PROJECT_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error("archive exceeds decompressed size limit");
    out.push({ path, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readLocalZipEntries(zip: Buffer): ZipFileEntry[] {
  const out: ZipFileEntry[] = [];
  let offset = 0;
  let uncompressedBytes = 0;
  while (offset + 4 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    if (out.length >= MAX_PROJECT_ARCHIVE_ENTRIES) throw new Error("archive has too many entries");
    const method = zip.readUInt16LE(offset + 8);
    const compSize = zip.readUInt32LE(offset + 18);
    const uncompSize = zip.readUInt32LE(offset + 22);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const path = zip.toString("utf8", offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;
    const remaining = MAX_PROJECT_ARCHIVE_UNCOMPRESSED_BYTES - uncompressedBytes;
    const data = decodeZipEntry(zip, { path, method, compSize, uncompSize, dataStart }, remaining);
    uncompressedBytes += data.length;
    out.push({ path, data });
    offset = dataStart + compSize;
  }
  return out;
}

function readZipEntries(zip: Buffer): ZipFileEntry[] {
  const eocd = findEndOfCentralDirectory(zip);
  return eocd >= 0 ? readCentralZipEntries(zip, eocd) : readLocalZipEntries(zip);
}

function safeArchivePath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return null;
  const parts = normalized.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

function asImportManifest(value: unknown): ImportManifest | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as ImportManifest;
  if (manifest.format !== "dezin-project") return null;
  if (!manifest.project || typeof manifest.project.name !== "string" || manifest.project.name.trim().length === 0) return null;
  return manifest;
}

function asProjectMode(value: unknown): ProjectMode {
  return value === "standard" ? "standard" : "prototype";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asMessageRole(value: unknown): MessageRole | null {
  return value === "user" || value === "assistant" || value === "system" ? value : null;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return asOptionalNumber(value);
}

function asRunStatus(value: unknown): RunStatus {
  return value === "pending" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled"
    ? value
    : "cancelled";
}

function asQualityFindings(value: unknown): QualityFinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is QualityFinding => {
    if (!item || typeof item !== "object") return false;
    const finding = item as Record<string, unknown>;
    return (
      (finding.severity === "P0" || finding.severity === "P1" || finding.severity === "P2") &&
      typeof finding.id === "string" &&
      typeof finding.message === "string" &&
      (finding.fix === undefined || typeof finding.fix === "string") &&
      (finding.snippet === undefined || typeof finding.snippet === "string")
    );
  });
}

function archiveFiles(archive: ZipFileEntry[], prefix: string): Array<{ rel: string; data: Buffer }> | null {
  const files: Array<{ rel: string; data: Buffer }> = [];
  for (const entry of archive.filter((item) => item.path.startsWith(prefix))) {
    const rel = safeArchivePath(entry.path.slice(prefix.length));
    if (!rel) return null;
    files.push({ rel, data: entry.data });
  }
  return files;
}

async function writeArchiveFiles(root: string, files: Array<{ rel: string; data: Buffer }>, signal?: AbortSignal): Promise<boolean> {
  for (const entry of files) {
    signal?.throwIfAborted();
    const target = safeJoin(root, entry.rel);
    if (!target) return false;
    await mkdir(dirname(target), { recursive: true });
    signal?.throwIfAborted();
    await writeFile(target, entry.data);
  }
  return true;
}

function splitScopedArchiveFiles(
  archive: ZipFileEntry[],
  prefix: string,
): Array<{ scope: string; rel: string; data: Buffer }> | null {
  const out: Array<{ scope: string; rel: string; data: Buffer }> = [];
  for (const entry of archive.filter((item) => item.path.startsWith(prefix))) {
    const rel = safeArchivePath(entry.path.slice(prefix.length));
    if (!rel) return null;
    const [scope, ...rest] = rel.split("/");
    if (!scope || rest.length === 0) return null;
    out.push({ scope, rel: rest.join("/"), data: entry.data });
  }
  return out;
}

async function restoreGitBundle(root: string, dataDir: string, bundle: Buffer, signal?: AbortSignal): Promise<boolean> {
  const tmp = join(dataDir, ".imports", `${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
  try {
    signal?.throwIfAborted();
    await mkdir(dirname(tmp), { recursive: true });
    await mkdir(dirname(root), { recursive: true });
    await writeFile(tmp, bundle);
    signal?.throwIfAborted();
    await rm(root, { recursive: true, force: true });
    const res = await runCommand("git", ["clone", "--quiet", tmp, root], dirname(root), signal);
    signal?.throwIfAborted();
    return res.code === 0;
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

function standardVariantBranch(variantId: string): string {
  return `dezin/variant/${variantId}`;
}

async function renameStandardVariantBranches(root: string, variantMap: Map<string, string>, signal?: AbortSignal): Promise<void> {
  if (!existsSync(join(root, ".git"))) return;
  for (const [oldId, newId] of variantMap) {
    signal?.throwIfAborted();
    if (oldId === newId) continue;
    const oldBranch = standardVariantBranch(oldId);
    const newBranch = standardVariantBranch(newId);
    const hasOld = (await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${oldBranch}`], root, signal)).code === 0;
    if (!hasOld) continue;
    const hasNew = (await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${newBranch}`], root, signal)).code === 0;
    if (hasNew) continue;
    await runCommand("git", ["branch", "-m", oldBranch, newBranch], root, signal);
  }
}

function rewriteMappedJson(value: unknown, maps: Record<string, Map<string, string>>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteMappedJson(item, maps));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const map = maps[key];
    out[key] = map && typeof item === "string" ? map.get(item) ?? item : rewriteMappedJson(item, maps);
  }
  return out;
}

function rewriteSnapshotPaths(value: unknown, snapshotRoot: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteSnapshotPaths(item, snapshotRoot));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = rewriteSnapshotPaths(item, snapshotRoot);
  }
  if (typeof out.snapshotPath === "string") {
    const snapshotPath = safeArchivePath(out.snapshotPath);
    if (snapshotPath) out.path = join(snapshotRoot, snapshotPath);
  }
  return out;
}

function rewriteRunLog(data: Buffer, maps: Record<string, Map<string, string>>): Buffer {
  const lines = data.toString("utf8").split("\n").filter(Boolean);
  const rewritten = lines.map((line) => {
    try {
      return JSON.stringify(rewriteMappedJson(JSON.parse(line) as unknown, maps));
    } catch {
      return line;
    }
  });
  return Buffer.from(`${rewritten.join("\n")}${rewritten.length ? "\n" : ""}`);
}

function rewriteRunBundleFile(
  rel: string,
  data: Buffer,
  maps: Record<string, Map<string, string>>,
  snapshotRoot: string,
): Buffer {
  if (!rel.endsWith(".json")) return data;
  try {
    const mapped = rewriteMappedJson(JSON.parse(data.toString("utf8")) as unknown, maps);
    return Buffer.from(JSON.stringify(rewriteSnapshotPaths(mapped, snapshotRoot), null, 2));
  } catch {
    return data;
  }
}

async function completeImportRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AppDeps,
  requestSignal?: AbortSignal,
): Promise<void> {
  let archive: ZipFileEntry[];
  try {
    archive = readZipEntries(await readRawBody(req, undefined, requestSignal));
  } catch (err) {
    if (requestSignal?.aborted) throw requestSignal.reason;
    return sendError(res, 422, err instanceof Error ? err.message : "invalid project archive");
  }
  const manifestEntry = archive.find((entry) => entry.path === MANIFEST_PATH);
  if (!manifestEntry) return sendError(res, 422, "missing project manifest");

  let manifest: ImportManifest | null;
  try {
    manifest = asImportManifest(JSON.parse(manifestEntry.data.toString("utf8")) as unknown);
  } catch {
    return sendError(res, 422, "invalid project manifest");
  }
  if (!manifest) return sendError(res, 422, "invalid project manifest");

  const rawSourceFiles = archiveFiles(archive, "source/");
  if (!rawSourceFiles) return sendError(res, 422, "invalid source path");
  const sourceFiles = rawSourceFiles.filter((entry) => !shouldSkipArchiveSourcePath(entry.rel));
  if (sourceFiles.length === 0) return sendError(res, 422, "project archive contains no source files");

  const refFiles = archiveFiles(archive, "refs/");
  if (!refFiles) return sendError(res, 422, "invalid source path");
  const variantFiles = splitScopedArchiveFiles(archive, "variants/");
  if (!variantFiles) return sendError(res, 422, "invalid source path");
  const versionFiles = archiveFiles(archive, "versions/");
  if (!versionFiles) return sendError(res, 422, "invalid source path");
  const runLogFiles = archiveFiles(archive, "runs/");
  if (!runLogFiles) return sendError(res, 422, "invalid source path");

  const project = deps.store.createImportedProject({
    name: manifest.project!.name as string,
    skillId: asNullableString(manifest.project!.skillId),
    designSystemId: asNullableString(manifest.project!.designSystemId),
    mode: asProjectMode(manifest.project!.mode),
    createdAt: asOptionalNumber(manifest.project!.createdAt),
    updatedAt: asOptionalNumber(manifest.project!.updatedAt),
    archivedAt: asNullableNumber(manifest.project!.archivedAt),
  });
  const root = projectDir(deps.dataDir, project.id);

  const completeImport = async (projectSignal?: AbortSignal): Promise<void> => {
    await deps.importProjectCreated?.(project.id, projectSignal);
    projectSignal?.throwIfAborted();

  const projectIdMap = new Map<string, string>();
  if (typeof manifest.project!.id === "string") projectIdMap.set(manifest.project!.id, project.id);

  const variantMap = new Map<string, string>();
  const importedVariants: Array<{ oldId: string; newId: string; active: boolean }> = [];
  const variantLeases: Array<{ release: () => void }> = [];
  try {
    for (const importedVariant of Array.isArray(manifest.variants) ? manifest.variants : []) {
      const oldId = typeof importedVariant.id === "string" ? importedVariant.id : null;
      if (!oldId) continue;
      const name = typeof importedVariant.name === "string" && importedVariant.name.trim() ? importedVariant.name.trim() : "Variant";
      const variant = deps.store.createImportedVariant(project.id, { name, createdAt: asOptionalNumber(importedVariant.createdAt) });
      variantMap.set(oldId, variant.id);
      importedVariants.push({ oldId, newId: variant.id, active: importedVariant.active === true });
      if (deps.runtimeSupervisor) {
        variantLeases.push(deps.runtimeSupervisor.acquireOperationLease({
          projectId: project.id,
          variantId: variant.id,
        }));
      }
    }
    const activeImportedVariant = importedVariants.find((variant) => variant.active) ?? importedVariants[0];
    // Variant deletion waits on these ownership leases, but only project/request cancellation
    // aborts the indivisible import continuation. Once import settles, deletion recomputes and
    // removes the exact variant-owned Runs and files without leaving a partial project behind.
    const signal = projectSignal;

    if (activeImportedVariant) deps.store.setActiveVariant(project.id, activeImportedVariant.newId);

  const conversationMap = new Map<string, string>();
  const messageMap = new Map<string, string>();
  for (const importedConversation of Array.isArray(manifest.conversations) ? manifest.conversations : []) {
    const title = typeof importedConversation.title === "string" && importedConversation.title.trim() ? importedConversation.title.trim() : "Untitled";
    const conversation = deps.store.createImportedConversation(project.id, { title, createdAt: asOptionalNumber(importedConversation.createdAt) });
    if (typeof importedConversation.id === "string") conversationMap.set(importedConversation.id, conversation.id);
    for (const importedMessage of Array.isArray(importedConversation.messages) ? importedConversation.messages : []) {
      const role = asMessageRole(importedMessage.role);
      if (!role || typeof importedMessage.content !== "string") continue;
      const message = deps.store.addImportedMessage(conversation.id, {
        role,
        content: importedMessage.content,
        createdAt: asOptionalNumber(importedMessage.createdAt),
      });
      if (typeof importedMessage.id === "string") messageMap.set(importedMessage.id, message.id);
    }
  }

  const gitBundle = archive.find((entry) => entry.path === "standard/git.bundle");
  const restoredGit = project.mode === "standard" && gitBundle ? await restoreGitBundle(root, deps.dataDir, gitBundle.data, signal) : false;
  signal?.throwIfAborted();
  if (restoredGit) await renameStandardVariantBranches(root, variantMap, signal);

  let sourceRoot = root;
  const rootVariantId = deps.store.listVariants(project.id)[0]?.id;
  if (project.mode === "standard" && activeImportedVariant && rootVariantId && activeImportedVariant.newId !== rootVariantId) {
    sourceRoot = await standardVariantArtifactDir(deps, project.id, activeImportedVariant.newId).catch(() => root);
  }
  signal?.throwIfAborted();
  if (!(await writeArchiveFiles(sourceRoot, sourceFiles, signal))) return sendError(res, 422, "invalid source path");

  if (!(await writeArchiveFiles(join(root, ".refs"), refFiles, signal))) return sendError(res, 422, "invalid source path");
  const cover = archive.find((entry) => entry.path === "cover.png");
  signal?.throwIfAborted();
  await mkdir(root, { recursive: true });
  if (cover) {
    signal?.throwIfAborted();
    await writeFile(join(root, ".cover.png"), cover.data);
  }

  const groupedVariantFiles = new Map<string, Array<{ rel: string; data: Buffer }>>();
  for (const file of variantFiles.filter((entry) => !shouldSkipArchiveSourcePath(entry.rel))) {
    const newVariantId = variantMap.get(file.scope);
    if (!newVariantId) continue;
    const group = groupedVariantFiles.get(newVariantId) ?? [];
    group.push({ rel: file.rel, data: file.data });
    groupedVariantFiles.set(newVariantId, group);
  }
  for (const [variantId, files] of groupedVariantFiles) {
    const targetRoot =
      project.mode === "standard"
        ? await standardVariantArtifactDir(deps, project.id, variantId).catch(() => null)
        : join(root, ".variants", variantId);
    if (!targetRoot) continue;
    if (!(await writeArchiveFiles(targetRoot, files, signal))) return sendError(res, 422, "invalid source path");
  }

  const runMap = new Map<string, string>();
  for (const importedRun of Array.isArray(manifest.runs) ? manifest.runs : []) {
    const oldId = typeof importedRun.id === "string" ? importedRun.id : null;
    const oldConversationId = typeof importedRun.conversationId === "string" ? importedRun.conversationId : null;
    const conversationId = oldConversationId ? conversationMap.get(oldConversationId) : undefined;
    if (!oldId || !conversationId) continue;
    const run = deps.store.createImportedRun(project.id, conversationId, {
      variantId: typeof importedRun.variantId === "string" ? variantMap.get(importedRun.variantId) ?? null : null,
      userMessageId: typeof importedRun.userMessageId === "string" ? messageMap.get(importedRun.userMessageId) ?? null : null,
      assistantMessageId: typeof importedRun.assistantMessageId === "string" ? messageMap.get(importedRun.assistantMessageId) ?? null : null,
      commitHash: asNullableString(importedRun.commitHash),
      status: asRunStatus(importedRun.status),
      repairRounds: asOptionalNumber(importedRun.repairRounds),
      lintPassed: importedRun.lintPassed === true,
      score: asNullableNumber(importedRun.score) ?? null,
      findings: asQualityFindings(importedRun.findings),
      createdAt: asOptionalNumber(importedRun.createdAt),
      finishedAt: asNullableNumber(importedRun.finishedAt),
    });
    runMap.set(oldId, run.id);
  }

  for (const importedArtifact of Array.isArray(manifest.artifacts) ? manifest.artifacts : []) {
    if (typeof importedArtifact.path !== "string" || !safeArchivePath(importedArtifact.path)) continue;
    deps.store.importArtifact(project.id, {
      path: importedArtifact.path,
      lintPassed: importedArtifact.lintPassed === true,
      createdAt: asOptionalNumber(importedArtifact.createdAt),
    });
  }

  for (const file of versionFiles) {
    signal?.throwIfAborted();
    const oldRunId = file.rel.endsWith(".html") ? file.rel.slice(0, -".html".length) : file.rel;
    const newRunId = runMap.get(oldRunId);
    if (!newRunId) continue;
    const target = safeJoin(root, join(".versions", `${newRunId}.html`));
    if (!target) return sendError(res, 422, "invalid source path");
    await mkdir(dirname(target), { recursive: true });
    signal?.throwIfAborted();
    await writeFile(target, file.data);
  }

  const rewriteMaps = {
    projectId: projectIdMap,
    runId: runMap,
    conversationId: conversationMap,
    variantId: variantMap,
    userMessageId: messageMap,
    assistantMessageId: messageMap,
    messageId: messageMap,
  };
  for (const file of runLogFiles) {
    signal?.throwIfAborted();
    if (file.rel.includes("/") || !file.rel.endsWith(".jsonl")) continue;
    const oldRunId = file.rel.endsWith(".jsonl") ? file.rel.slice(0, -".jsonl".length) : file.rel;
    const newRunId = runMap.get(oldRunId);
    if (!newRunId) continue;
    const target = join(deps.dataDir, ".runs", `${newRunId}.jsonl`);
    await mkdir(dirname(target), { recursive: true });
    signal?.throwIfAborted();
    await writeFile(target, rewriteRunLog(file.data, rewriteMaps));
  }

  for (const file of runLogFiles) {
    signal?.throwIfAborted();
    const [oldRunId, ...restParts] = file.rel.split("/");
    if (!oldRunId || restParts.length === 0) continue;
    const newRunId = runMap.get(oldRunId);
    if (!newRunId) continue;
    const rel = restParts.join("/");
    const target = safeJoin(join(deps.dataDir, ".runs", newRunId), rel);
    if (!target) return sendError(res, 422, "invalid source path");
    await mkdir(dirname(target), { recursive: true });
    signal?.throwIfAborted();
    await writeFile(target, rewriteRunBundleFile(rel, file.data, rewriteMaps, join(deps.dataDir, ".runs", newRunId, "moodboards")));
  }

  if (project.mode === "standard") {
    const setup = deps.runtimeSupervisor
      ? deps.runtimeSupervisor.trackOperation(
          { projectId: project.id },
          (signal) => setupImportedStandardProject(project.id, root, signal),
        )
      : setupImportedStandardProject(project.id, root);
    void setup.catch(() => {});
  }
    sendJson(res, 201, project);
  } finally {
    for (const lease of variantLeases) lease.release();
  }
  };

  if (!deps.runtimeSupervisor) {
    await completeImport();
    return;
  }

  try {
    await deps.runtimeSupervisor.trackOperation(
      { projectId: project.id },
      (signal) => completeImport(signal),
    );
  } catch (err) {
    // Shutdown owns the request-level operation before a project id exists. If it wins after the
    // row is created, roll the just-created project back through the normal ownership boundary.
    if (requestSignal?.aborted && deps.store.getProject(project.id)) {
      await deps.runtimeSupervisor.releaseProject(project.id);
    }
    throw err;
  }
}

export async function handleImportProject(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  if (!deps.runtimeSupervisor) return completeImportRequest(req, res, deps);
  await deps.runtimeSupervisor.trackOperation(
    { projectId: IMPORT_REQUEST_SCOPE_ID },
    (signal) => completeImportRequest(req, res, deps, signal),
  );
}
