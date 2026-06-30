/**
 * GET /api/projects/:id/export — zip the project's on-disk artifact folder and
 * return it as a download. With ?scope=full, also includes project metadata and
 * conversations so the archive can be imported on another Dezin instance.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { dirname, join, relative, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError, sendJson, readRawBody } from "./http-util.ts";
import { createZip, type ZipEntry } from "./zip.ts";
import type { AppDeps } from "./app.ts";
import { activeArtifactDir } from "./variant-workspaces.ts";
import { projectDir, safeJoin } from "./serve-static.ts";
import { setupImportedStandardProject } from "./project-runtime.ts";
import type { MessageRole, Project } from "../../../packages/core/src/index.ts";
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

async function fullProjectEntries(project: Project, files: FileRef[], deps: AppDeps): Promise<ZipEntry[]> {
  const root = projectDir(deps.dataDir, project.id);
  const manifest = {
    format: "dezin-project",
    version: 1,
    exportedAt: Date.now(),
    project: {
      name: project.name,
      skillId: project.skillId,
      designSystemId: project.designSystemId,
      mode: project.mode,
    },
    conversations: deps.store.listConversations(project.id).map((conversation) => ({
      title: conversation.title,
      messages: deps.store.listMessages(conversation.id).map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })),
    })),
  };
  const sourceEntries: ZipEntry[] = await Promise.all(
    files.map(async (f) => ({ path: `source/${f.rel}`, data: await readFile(f.abs) })),
  );
  const refEntries: ZipEntry[] = await Promise.all(
    (await walkFiles(join(root, ".refs"))).map(async (f) => ({ path: `refs/${f.rel}`, data: await readFile(f.abs) })),
  );
  const entries: ZipEntry[] = [{ path: MANIFEST_PATH, data: JSON.stringify(manifest, null, 2) }, ...sourceEntries, ...refEntries];
  try {
    entries.push({ path: "cover.png", data: await readFile(join(root, ".cover.png")) });
  } catch {
    /* cover is optional */
  }
  return entries;
}

interface ImportManifest {
  format?: string;
  project?: {
    name?: unknown;
    skillId?: unknown;
    designSystemId?: unknown;
    mode?: unknown;
  };
  conversations?: Array<{
    title?: unknown;
    messages?: Array<{
      role?: unknown;
      content?: unknown;
    }>;
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

  const source = archive.filter((entry) => entry.path.startsWith("source/"));
  if (source.length === 0) return sendError(res, 422, "project archive contains no source files");
  const sourceFiles: Array<{ rel: string; data: Buffer }> = [];
  for (const entry of source) {
    const rel = safeArchivePath(entry.path.slice("source/".length));
    if (!rel) return sendError(res, 422, "invalid source path");
    if (shouldSkipArchiveSourcePath(rel)) continue;
    sourceFiles.push({ rel, data: entry.data });
  }
  if (sourceFiles.length === 0) return sendError(res, 422, "project archive contains no source files");
  const refFiles = archive
    .filter((entry) => entry.path.startsWith("refs/"))
    .map((entry) => {
      const rel = safeArchivePath(entry.path.slice("refs/".length));
      return rel ? { rel, data: entry.data } : null;
    });
  if (refFiles.some((entry) => entry === null)) return sendError(res, 422, "invalid source path");

  const project = deps.store.createProject({
    name: manifest.project!.name as string,
    skillId: asNullableString(manifest.project!.skillId),
    designSystemId: asNullableString(manifest.project!.designSystemId),
    mode: asProjectMode(manifest.project!.mode),
  });
  const root = projectDir(deps.dataDir, project.id);
  for (const entry of sourceFiles) {
    const target = safeJoin(root, entry.rel);
    if (!target) return sendError(res, 422, "invalid source path");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data);
  }
  for (const entry of refFiles) {
    if (!entry) continue;
    const target = safeJoin(root, join(".refs", entry.rel));
    if (!target) return sendError(res, 422, "invalid source path");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data);
  }
  const cover = archive.find((entry) => entry.path === "cover.png");
  if (cover) await writeFile(join(root, ".cover.png"), cover.data);

  for (const importedConversation of Array.isArray(manifest.conversations) ? manifest.conversations : []) {
    const title = typeof importedConversation.title === "string" && importedConversation.title.trim() ? importedConversation.title.trim() : "Untitled";
    const conversation = deps.store.createConversation(project.id, title);
    for (const importedMessage of Array.isArray(importedConversation.messages) ? importedConversation.messages : []) {
      const role = asMessageRole(importedMessage.role);
      if (!role || typeof importedMessage.content !== "string") continue;
      deps.store.addMessage(conversation.id, role, importedMessage.content);
    }
  }

  if (project.mode === "standard") void setupImportedStandardProject(project.id, root);
  sendJson(res, 201, project);
}
