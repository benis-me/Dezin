/**
 * GET /api/projects/:id/export — zip the project's on-disk artifact folder and
 * return it as a download. With ?scope=full, also includes project metadata and
 * conversations so the archive can be imported on another Dezin instance.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { dirname, join, relative, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError, sendJson, readRawBody } from "./http-util.ts";
import { createZip, type ZipEntry } from "./zip.ts";
import type { AppDeps } from "./app.ts";
import { activeArtifactDir, standardVariantArtifactDir, variantArtifactDir } from "./variant-workspaces.ts";
import { projectDir, safeJoin } from "./serve-static.ts";
import { setupImportedStandardProject } from "./project-runtime.ts";
import type { MessageRole, Project, QualityFinding, RunStatus } from "../../../packages/core/src/index.ts";
import type { ProjectMode } from "../../../packages/core/src/types.ts";

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

export async function walkFiles(root: string, dir: string = root, out: FileRef[] = []): Promise<FileRef[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
    if (e.isFile() && shouldSkipFileName(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(root, abs, out);
    else if (e.isFile()) out.push({ rel: relative(root, abs).split(sep).join("/"), abs });
  }
  return out;
}

export async function handleExport(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const id = params.id!;
  const project = deps.store.getProject(id);
  if (!project) return sendError(res, 404, "project not found");

  const dir = await activeArtifactDir(deps, project);
  const files = await walkFiles(dir);
  if (files.length === 0) return sendError(res, 404, "no artifacts to export");

  const entries: ZipEntry[] = await Promise.all(
    files.map(async (f) => ({ path: f.rel, data: await readFile(f.abs) })),
  );
  const full = new URL(req.url ?? "/", "http://localhost").searchParams.get("scope") === "full";
  const zip = createZip(full ? await fullProjectEntries(project, files, deps) : entries);

  res.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${full ? "dezin-full-project" : "dezin-project"}-${id}.zip"`,
    "content-length": String(zip.length),
  });
  res.end(zip);
}

function entryPath(prefix: string, rel: string): string {
  return `${prefix.replace(/\/$/, "")}/${rel}`;
}

async function entriesFromFiles(prefix: string, files: FileRef[]): Promise<ZipEntry[]> {
  return Promise.all(files.map(async (f) => ({ path: entryPath(prefix, f.rel), data: await readFile(f.abs) })));
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.stderr?.on("data", (d: string) => (out += d));
    child.on("error", (err) => resolve({ code: 1, out: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function maybeGitBundleEntry(root: string, deps: AppDeps, projectId: string): Promise<ZipEntry | null> {
  if (!existsSync(join(root, ".git"))) return null;
  const tmp = join(deps.dataDir, ".exports", `${projectId}-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
  try {
    await mkdir(dirname(tmp), { recursive: true });
    const res = await runCommand("git", ["bundle", "create", tmp, "--all"], root);
    if (res.code !== 0) return null;
    return { path: "standard/git.bundle", data: await readFile(tmp) };
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

async function fullProjectEntries(project: Project, files: FileRef[], deps: AppDeps): Promise<ZipEntry[]> {
  const root = projectDir(deps.dataDir, project.id);
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
  const sourceEntries = await entriesFromFiles("source", files);
  const refEntries = await entriesFromFiles("refs", await walkFiles(join(root, ".refs")));
  const activeVariantId = deps.store.getActiveVariantId(project.id);
  const variantEntries: ZipEntry[] = [];
  for (const variant of variants) {
    if (variant.id === activeVariantId) continue;
    const dir = await variantArtifactDir(deps, project, variant.id).catch(() => null);
    if (!dir) continue;
    variantEntries.push(...(await entriesFromFiles(`variants/${variant.id}`, await walkFiles(dir))));
  }
  const versionEntries = await entriesFromFiles("versions", await walkFiles(join(root, ".versions")));
  const runEntries: ZipEntry[] = [];
  for (const run of runs) {
    try {
      runEntries.push({ path: `runs/${run.id}.jsonl`, data: await readFile(join(deps.dataDir, ".runs", `${run.id}.jsonl`)) });
    } catch {
      /* run logs are optional for older projects */
    }
    runEntries.push(...(await entriesFromFiles(`runs/${run.id}`, await walkFiles(join(deps.dataDir, ".runs", run.id)))));
  }
  const entries: ZipEntry[] = [
    { path: MANIFEST_PATH, data: JSON.stringify(manifest, null, 2) },
    ...sourceEntries,
    ...variantEntries,
    ...refEntries,
    ...versionEntries,
    ...runEntries,
  ];
  const gitBundle = project.mode === "standard" ? await maybeGitBundleEntry(root, deps, project.id) : null;
  if (gitBundle) entries.push(gitBundle);
  try {
    entries.push({ path: "cover.png", data: await readFile(join(root, ".cover.png")) });
  } catch {
    /* cover is optional */
  }
  return entries;
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

function readZipEntries(zip: Buffer): ZipFileEntry[] {
  const out: ZipFileEntry[] = [];
  let offset = 0;
  while (offset + 4 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8);
    const compSize = zip.readUInt32LE(offset + 18);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > zip.length) throw new Error("truncated zip entry");
    const path = zip.toString("utf8", nameStart, nameStart + nameLen);
    const raw = zip.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error("unsupported zip compression");
    out.push({ path, data });
    offset = dataEnd;
  }
  return out;
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

async function writeArchiveFiles(root: string, files: Array<{ rel: string; data: Buffer }>): Promise<boolean> {
  for (const entry of files) {
    const target = safeJoin(root, entry.rel);
    if (!target) return false;
    await mkdir(dirname(target), { recursive: true });
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

async function restoreGitBundle(root: string, dataDir: string, bundle: Buffer): Promise<boolean> {
  const tmp = join(dataDir, ".imports", `${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
  try {
    await mkdir(dirname(tmp), { recursive: true });
    await mkdir(dirname(root), { recursive: true });
    await writeFile(tmp, bundle);
    await rm(root, { recursive: true, force: true });
    const res = await runCommand("git", ["clone", "--quiet", tmp, root], dirname(root));
    return res.code === 0;
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

function standardVariantBranch(variantId: string): string {
  return `dezin/variant/${variantId}`;
}

async function renameStandardVariantBranches(root: string, variantMap: Map<string, string>): Promise<void> {
  if (!existsSync(join(root, ".git"))) return;
  for (const [oldId, newId] of variantMap) {
    if (oldId === newId) continue;
    const oldBranch = standardVariantBranch(oldId);
    const newBranch = standardVariantBranch(newId);
    const hasOld = (await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${oldBranch}`], root)).code === 0;
    if (!hasOld) continue;
    const hasNew = (await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${newBranch}`], root)).code === 0;
    if (hasNew) continue;
    await runCommand("git", ["branch", "-m", oldBranch, newBranch], root);
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

export async function handleImportProject(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  let archive: ZipFileEntry[];
  try {
    archive = readZipEntries(await readRawBody(req));
  } catch {
    return sendError(res, 422, "invalid project archive");
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

  const projectIdMap = new Map<string, string>();
  if (typeof manifest.project!.id === "string") projectIdMap.set(manifest.project!.id, project.id);

  const variantMap = new Map<string, string>();
  const importedVariants: Array<{ oldId: string; newId: string; active: boolean }> = [];
  for (const importedVariant of Array.isArray(manifest.variants) ? manifest.variants : []) {
    const oldId = typeof importedVariant.id === "string" ? importedVariant.id : null;
    if (!oldId) continue;
    const name = typeof importedVariant.name === "string" && importedVariant.name.trim() ? importedVariant.name.trim() : "Variant";
    const variant = deps.store.createImportedVariant(project.id, { name, createdAt: asOptionalNumber(importedVariant.createdAt) });
    variantMap.set(oldId, variant.id);
    importedVariants.push({ oldId, newId: variant.id, active: importedVariant.active === true });
  }
  const activeImportedVariant = importedVariants.find((variant) => variant.active) ?? importedVariants[0];
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
  const restoredGit = project.mode === "standard" && gitBundle ? await restoreGitBundle(root, deps.dataDir, gitBundle.data) : false;
  if (restoredGit) await renameStandardVariantBranches(root, variantMap);

  let sourceRoot = root;
  const rootVariantId = deps.store.listVariants(project.id)[0]?.id;
  if (project.mode === "standard" && activeImportedVariant && rootVariantId && activeImportedVariant.newId !== rootVariantId) {
    sourceRoot = await standardVariantArtifactDir(deps, project.id, activeImportedVariant.newId).catch(() => root);
  }
  if (!(await writeArchiveFiles(sourceRoot, sourceFiles))) return sendError(res, 422, "invalid source path");

  if (!(await writeArchiveFiles(join(root, ".refs"), refFiles))) return sendError(res, 422, "invalid source path");
  const cover = archive.find((entry) => entry.path === "cover.png");
  await mkdir(root, { recursive: true });
  if (cover) await writeFile(join(root, ".cover.png"), cover.data);

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
    if (!(await writeArchiveFiles(targetRoot, files))) return sendError(res, 422, "invalid source path");
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
    const oldRunId = file.rel.endsWith(".html") ? file.rel.slice(0, -".html".length) : file.rel;
    const newRunId = runMap.get(oldRunId);
    if (!newRunId) continue;
    const target = safeJoin(root, join(".versions", `${newRunId}.html`));
    if (!target) return sendError(res, 422, "invalid source path");
    await mkdir(dirname(target), { recursive: true });
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
    if (file.rel.includes("/") || !file.rel.endsWith(".jsonl")) continue;
    const oldRunId = file.rel.endsWith(".jsonl") ? file.rel.slice(0, -".jsonl".length) : file.rel;
    const newRunId = runMap.get(oldRunId);
    if (!newRunId) continue;
    const target = join(deps.dataDir, ".runs", `${newRunId}.jsonl`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, rewriteRunLog(file.data, rewriteMaps));
  }

  for (const file of runLogFiles) {
    const [oldRunId, ...restParts] = file.rel.split("/");
    if (!oldRunId || restParts.length === 0) continue;
    const newRunId = runMap.get(oldRunId);
    if (!newRunId) continue;
    const rel = restParts.join("/");
    const target = safeJoin(join(deps.dataDir, ".runs", newRunId), rel);
    if (!target) return sendError(res, 422, "invalid source path");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, rewriteRunBundleFile(rel, file.data, rewriteMaps, join(deps.dataDir, ".runs", newRunId, "moodboards")));
  }

  if (project.mode === "standard") void setupImportedStandardProject(project.id, root);
  sendJson(res, 201, project);
}
