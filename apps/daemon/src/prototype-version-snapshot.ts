import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, extname, join, normalize, relative } from "node:path";
import { projectDir } from "./serve-static.ts";

// This directory is served without the daemon token so a sandboxed historical document can load
// its pixels. Keep the surface deliberately narrower than project source: no JS/JSON/config/text,
// no dot-directory inputs (.refs/.research), and no symlinks.
const RENDER_ASSET_EXTENSIONS = new Set([
  ".avif",
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".m4v",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".png",
  ".svg",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
]);
const PRIVATE_PATH_SEGMENTS = new Set([
  ".dev",
  ".git",
  ".variants",
  ".versions",
  ".visual-qa",
  "node_modules",
]);
const EXTENSIONLESS_RENDER_DIRS = new Set(["assets", "fonts", "images", "img", "media", "static"]);
const VERSION_ENTRY_RE = /^([a-zA-Z0-9-]+)\.(html|files)$/;
const PRIVATE_VISUAL_ROUND_RE = /-visual-round-[a-zA-Z0-9-]+$/;
const STAGED_VERSION_TMP_RE = /^\.[a-zA-Z0-9-]+\.(?:html|files)\.tmp$/;

function readDirectoryEntries(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9-]/g, "");
}

export function prototypeVersionHtmlPath(dataDir: string, projectId: string, runId: string): string {
  return join(projectDir(dataDir, projectId), ".versions", `${safeRunId(runId)}.html`);
}

export function prototypeVersionFilesDir(dataDir: string, projectId: string, runId: string): string {
  return join(projectDir(dataDir, projectId), ".versions", `${safeRunId(runId)}.files`);
}

export function prototypeVersionFilesPath(projectId: string, runId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(runId)}/files/`;
}

/** Sweep only daemon-owned `.versions` metadata left by a process crash.
 *
 * HTML is the publication completion marker. A files bundle without that marker is safe to remove;
 * HTML-only snapshots predate asset capture and remain valid legacy history. Private visual-review
 * rounds and dot-prefixed staging paths are never public version identities and are always removed.
 */
export function cleanupPrototypeVersionSnapshotResidue(dataDir: string): number {
  const projectsDir = join(dataDir, "projects");
  const projects = readDirectoryEntries(projectsDir);

  let removed = 0;
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const versionsDir = join(projectsDir, project.name, ".versions");
    try {
      // Never follow a project-controlled symlink outside the reserved metadata directory.
      if (!lstatSync(versionsDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const entries = readDirectoryEntries(versionsDir);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const targets = new Set<string>();
    for (const entry of entries) {
      if (STAGED_VERSION_TMP_RE.test(entry.name)) {
        targets.add(entry.name);
        continue;
      }
      const match = VERSION_ENTRY_RE.exec(entry.name);
      if (!match) continue;
      const [, runId, kind] = match;
      if (PRIVATE_VISUAL_ROUND_RE.test(runId!)) {
        targets.add(entry.name);
        continue;
      }
      if (kind === "files" && byName.get(`${runId}.html`)?.isFile() !== true) targets.add(entry.name);
    }

    for (const target of targets) {
      try {
        rmSync(join(versionsDir, target), { recursive: true, force: true });
        removed += 1;
      } catch {
        // Startup cleanup is best-effort; one unreadable project must not block the daemon.
      }
    }
  }
  return removed;
}

export function isPrototypeVersionRenderAssetPath(relPath: string): boolean {
  const segments = relPath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some((segment) => segment === ".." || segment.startsWith(".") || PRIVATE_PATH_SEGMENTS.has(segment))) return false;
  const extension = extname(segments.at(-1)!).toLowerCase();
  if (RENDER_ASSET_EXTENSIONS.has(extension)) return true;
  return !extension && segments.slice(0, -1).some((segment) => EXTENSIONLESS_RENDER_DIRS.has(segment.toLowerCase()));
}

async function hasRenderAssetSignature(path: string): Promise<boolean> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return false;
  try {
    const bytes = Buffer.alloc(32);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const b = bytes.subarray(0, bytesRead);
    const ascii = b.toString("ascii");
    return (
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
      (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
      ascii.startsWith("GIF87a") ||
      ascii.startsWith("GIF89a") ||
      (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") ||
      (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") ||
      ascii.startsWith("OggS") ||
      ascii.startsWith("ID3") ||
      (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) ||
      ascii.slice(4, 8) === "ftyp" ||
      ascii.startsWith("wOFF") ||
      ascii.startsWith("wOF2") ||
      ascii.startsWith("OTTO") ||
      (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) ||
      (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)
    );
  } finally {
    await file.close();
  }
}

/** Validate a public historical asset against both its path and, for extensionless files, bytes. */
export async function isPrototypeVersionRenderAssetFile(root: string, relPath: string): Promise<boolean> {
  if (!isPrototypeVersionRenderAssetPath(relPath)) return false;
  if (extname(relPath)) return true;
  return hasRenderAssetSignature(join(root, relPath));
}

function localVersionAssetPath(url: string): { path: string; suffix: string } | null {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const suffixAt = trimmed.search(/[?#]/);
  const rawPath = suffixAt >= 0 ? trimmed.slice(0, suffixAt) : trimmed;
  const suffix = suffixAt >= 0 ? trimmed.slice(suffixAt) : "";
  const pathname = rawPath.replace(/^\/+/, "");
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const normalized = normalize(decoded).replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../") || !isPrototypeVersionRenderAssetPath(normalized)) return null;
  return { path: normalized, suffix };
}

function rewriteVersionAssetUrl(url: string, filesPath: string): string {
  const local = localVersionAssetPath(url);
  return local ? `${filesPath}${local.path}${local.suffix}` : url;
}

function rewriteRootRelativeAssetSurface(html: string, filesPath: string): string {
  let rewritten = html.replace(
    /(\b(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi,
    (_match, prefix: string, quote: string, url: string) => `${prefix}${quote}${rewriteVersionAssetUrl(url, filesPath)}${quote}`,
  );
  rewritten = rewritten.replace(
    /(\b(?:src|href|poster)\s*=\s*)(?!["'])([^\s>]+)/gi,
    (_match, prefix: string, url: string) => `${prefix}${rewriteVersionAssetUrl(url, filesPath)}`,
  );
  rewritten = rewritten.replace(
    /(\bsrcset\s*=\s*)(["'])([^"']*)\2/gi,
    (_match, prefix: string, quote: string, value: string) => {
      const entries = value.split(",").map((entry) => entry.replace(
        /^(\s*)(\S+)(.*)$/,
        (_entry, before: string, url: string, after: string) => `${before}${rewriteVersionAssetUrl(url, filesPath)}${after}`,
      ));
      return `${prefix}${quote}${entries.join(",")}${quote}`;
    },
  );
  rewritten = rewritten.replace(
    /(\burl\(\s*)(["']?)([^"')]+)\2(\s*\))/gi,
    (_match, prefix: string, quote: string, url: string, suffix: string) =>
      `${prefix}${quote}${rewriteVersionAssetUrl(url.trim(), filesPath)}${quote}${suffix}`,
  );
  return rewritten.replace(
    /(\@import\s+)(["'])([^"']+)\2/gi,
    (_match, prefix: string, quote: string, url: string) =>
      `${prefix}${quote}${rewriteVersionAssetUrl(url.trim(), filesPath)}${quote}`,
  );
}

/** Rebase single-slash render URLs while leaving https:// and protocol-relative URLs untouched. */
export function rewritePrototypeVersionAssetUrls(html: string, projectId: string, runId: string): string {
  const filesPath = prototypeVersionFilesPath(projectId, runId);
  return html
    .split(/(<script\b[\s\S]*?<\/script\s*>)/gi)
    .map((part) => (/^<script\b/i.test(part) ? part : rewriteRootRelativeAssetSurface(part, filesPath)))
    .join("");
}

/** Rebase root-relative references inside external historical stylesheets. Relative CSS URLs
 * already resolve against the run-scoped stylesheet URL and are intentionally left untouched. */
export function rewritePrototypeVersionCssAssetUrls(css: string, projectId: string, runId: string): string {
  const filesPath = prototypeVersionFilesPath(projectId, runId);
  let rewritten = css.replace(
    /(\burl\(\s*)(["']?)([^"')]+)\2(\s*\))/gi,
    (_match, prefix: string, quote: string, url: string, suffix: string) =>
      `${prefix}${quote}${url.trim().startsWith("/") ? rewriteVersionAssetUrl(url.trim(), filesPath) : url}${quote}${suffix}`,
  );
  rewritten = rewritten.replace(
    /(\@import\s+)(["'])([^"']+)\2/gi,
    (_match, prefix: string, quote: string, url: string) =>
      `${prefix}${quote}${url.trim().startsWith("/") ? rewriteVersionAssetUrl(url.trim(), filesPath) : url}${quote}`,
  );
  return rewritten;
}

async function listRenderAssets(root: string, dir = root): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || PRIVATE_PATH_SEGMENTS.has(entry.name)) continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listRenderAssets(root, absolute));
    else if (entry.isFile()) {
      const rel = relative(root, absolute);
      if (await isPrototypeVersionRenderAssetFile(root, rel)) files.push(rel);
    }
  }
  return files;
}

async function listRenderSymlinks(root: string, dir = root): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const links: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || PRIVATE_PATH_SEGMENTS.has(entry.name)) continue;
    const absolute = join(dir, entry.name);
    if (entry.isSymbolicLink()) links.push(relative(root, absolute));
    else if (entry.isDirectory()) links.push(...await listRenderSymlinks(root, absolute));
  }
  return links;
}

async function copyRenderSymlinks(source: string, destination: string): Promise<void> {
  for (const rel of await listRenderSymlinks(source)) {
    const target = join(destination, rel);
    await mkdir(dirname(target), { recursive: true });
    await symlink(await readlink(join(source, rel)), target);
  }
}

async function copyRenderAssets(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const rel of await listRenderAssets(source)) {
    const target = join(destination, rel);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, rel), target);
  }
}

function referencedRenderAssets(html: string): string[] {
  const references = new Set<string>();
  const collect = (value: string): void => {
    const local = localVersionAssetPath(value);
    if (local) references.add(local.path);
  };
  for (const match of html.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) collect(match[1]!);
  for (const match of html.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const entry of match[1]!.split(",")) collect(entry.trim().split(/\s+/, 1)[0] ?? "");
  }
  for (const part of html.split(/(<script\b[\s\S]*?<\/script\s*>)/gi)) {
    if (/^<script\b/i.test(part)) continue;
    for (const match of part.matchAll(/\burl\(\s*["']?([^"')]+)["']?\s*\)/gi)) collect(match[1]!);
    for (const match of part.matchAll(/\@import\s+["']([^"']+)["']/gi)) collect(match[1]!);
  }
  return [...references];
}

function referencedCssRenderAssets(css: string, stylesheetPath: string): string[] {
  const references = new Set<string>();
  const collect = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return;
    const suffixAt = trimmed.search(/[?#]/);
    const rawPath = suffixAt >= 0 ? trimmed.slice(0, suffixAt) : trimmed;
    let decoded = rawPath;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return;
    }
    const rooted = decoded.startsWith("/")
      ? decoded.replace(/^\/+/, "")
      : join(dirname(stylesheetPath), decoded);
    const normalized = normalize(rooted).replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized === ".." || normalized.startsWith("../") || !isPrototypeVersionRenderAssetPath(normalized)) return;
    references.add(normalized);
  };
  for (const match of css.matchAll(/\burl\(\s*["']?([^"')]+)["']?\s*\)/gi)) collect(match[1]!);
  for (const match of css.matchAll(/\@import\s+["']([^"']+)["']/gi)) collect(match[1]!);
  return [...references];
}

async function missingSnapshotRenderAssets(html: string, filesDir: string): Promise<string[]> {
  const pending = [...referencedRenderAssets(html)];
  const seen = new Set<string>();
  const missing = new Set<string>();
  while (pending.length) {
    const rel = pending.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const absolute = join(filesDir, rel);
    if (!existsSync(absolute)) {
      missing.add(rel);
      continue;
    }
    if (extname(rel).toLowerCase() !== ".css") continue;
    const css = await readFile(absolute, "utf8").catch(() => null);
    if (css === null) {
      missing.add(rel);
      continue;
    }
    pending.push(...referencedCssRenderAssets(css, rel));
  }
  return [...missing].sort();
}

async function removeRenderAssets(root: string): Promise<void> {
  const entries = [...await listRenderAssets(root), ...await listRenderSymlinks(root)];
  for (const rel of entries) await rm(join(root, rel), { recursive: true, force: true });
}

export async function prototypeVersionAssetManifest(root: string): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const manifest: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const path of await listRenderAssets(root)) {
    const bytes = await readFile(join(root, path));
    manifest.push({ path: path.replaceAll("\\", "/"), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength });
  }
  return manifest.sort((a, b) => a.path.localeCompare(b.path));
}

/** Persist the Prototype document plus its allowlisted, non-private render assets. */
export async function writePrototypeVersionSnapshot(input: {
  dataDir: string;
  projectId: string;
  runId: string;
  projectRoot: string;
  html: string;
}): Promise<void> {
  const htmlPath = prototypeVersionHtmlPath(input.dataDir, input.projectId, input.runId);
  const filesDir = prototypeVersionFilesDir(input.dataDir, input.projectId, input.runId);
  const versionsDir = dirname(htmlPath);
  const nonce = `${safeRunId(input.runId) || "snapshot"}-${randomUUID()}`;
  const stagedHtml = join(versionsDir, `.${nonce}.html.tmp`);
  const stagedFiles = join(versionsDir, `.${nonce}.files.tmp`);

  await mkdir(versionsDir, { recursive: true });
  // A Run snapshot is an immutable identity. Publishing replacements under the same URL would let
  // an already-open historical document read markup from one generation and pixels from another.
  if (existsSync(htmlPath) || existsSync(filesDir)) {
    throw new Error(`Prototype version snapshot already exists for run ${input.runId}.`);
  }
  try {
    await copyRenderAssets(input.projectRoot, stagedFiles);
    const missing = await missingSnapshotRenderAssets(input.html, stagedFiles);
    if (missing.length) {
      throw new Error(`Prototype version snapshot is missing referenced local render assets: ${missing.join(", ")}`);
    }
    await writeFile(stagedHtml, input.html, "utf8");
    // Re-check after staging to close the concurrent-writer window. Assets publish first; the HTML
    // rename is the one-way completion marker, so readers can see either 404 or one complete pair,
    // never an old document backed by newly swapped files.
    if (existsSync(htmlPath) || existsSync(filesDir)) {
      throw new Error(`Prototype version snapshot already exists for run ${input.runId}.`);
    }
    await rename(stagedFiles, filesDir);
    try {
      await rename(stagedHtml, htmlPath);
    } catch (error) {
      await rm(filesDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  } finally {
    await rm(stagedFiles, { recursive: true, force: true }).catch(() => {});
    await rm(stagedHtml, { force: true }).catch(() => {});
  }
}

/** Give a restored Run its own immutable file identity; legacy HTML-only snapshots stay restorable. */
export async function clonePrototypeVersionFiles(input: {
  dataDir: string;
  projectId: string;
  sourceRunId: string;
  restoredRunId: string;
}): Promise<boolean> {
  const source = prototypeVersionFilesDir(input.dataDir, input.projectId, input.sourceRunId);
  if (!existsSync(source)) return false;
  const destination = prototypeVersionFilesDir(input.dataDir, input.projectId, input.restoredRunId);
  await rm(destination, { recursive: true, force: true });
  await copyRenderAssets(source, destination);
  return true;
}

/** Restore the document and its public render assets as one rollback-safe filesystem mutation. */
export async function restorePrototypeVersionSnapshot(input: {
  dataDir: string;
  projectId: string;
  sourceRunId: string;
  projectRoot: string;
  html: string;
  afterRestore?: (assetsRestored: boolean) => void | Promise<void>;
}): Promise<boolean> {
  const sourceAssets = prototypeVersionFilesDir(input.dataDir, input.projectId, input.sourceRunId);
  const liveHtml = join(input.projectRoot, "index.html");
  const backup = join(input.projectRoot, ".versions", `.restore-${safeRunId(input.sourceRunId)}.backup`);
  const backupAssets = join(backup, "assets");
  const backupHtml = join(backup, "index.html");
  const hadHtml = existsSync(liveHtml);
  const assetsRestored = existsSync(sourceAssets);

  await rm(backup, { recursive: true, force: true });
  await mkdir(backup, { recursive: true });
  if (hadHtml) await copyFile(liveHtml, backupHtml);
  await copyRenderAssets(input.projectRoot, backupAssets);
  await copyRenderSymlinks(input.projectRoot, backupAssets);

  try {
    // Never mix a legacy HTML-only snapshot with assets from the current design. Missing
    // historical assets are represented honestly as absent resources.
    await removeRenderAssets(input.projectRoot);
    if (assetsRestored) await copyRenderAssets(sourceAssets, input.projectRoot);
    await writeFile(liveHtml, input.html, "utf8");
    await input.afterRestore?.(assetsRestored);
    return assetsRestored;
  } catch (error) {
    await removeRenderAssets(input.projectRoot).catch(() => {});
    await copyRenderAssets(backupAssets, input.projectRoot).catch(() => {});
    await copyRenderSymlinks(backupAssets, input.projectRoot).catch(() => {});
    if (hadHtml) await copyFile(backupHtml, liveHtml).catch(() => {});
    else await rm(liveHtml, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}

/** The first document <base> wins, so insert ours immediately after <head>. */
export function injectPrototypeVersionBase(html: string, projectId: string, runId: string): string {
  const tag = `<base data-dezin-version-base href="${prototypeVersionFilesPath(projectId, runId)}">`;
  const head = html.match(/<head[^>]*>/i);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}
