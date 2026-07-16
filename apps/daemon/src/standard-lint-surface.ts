import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const STANDARD_LINT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".jsx", ".ts", ".tsx"]);
const STANDARD_LINT_SKIP_DIRS = new Set([".git", ".sharingan", "dist", "node_modules", "version-worktrees"]);

export class StandardLintSurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StandardLintSurfaceError";
  }
}

async function readExactSourceFile(path: string, remainingBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size < 0) {
      throw new StandardLintSurfaceError("Standard lint source is not a bounded regular file");
    }
    if (metadata.size > remainingBytes) {
      throw new StandardLintSurfaceError(
        `Standard lint source exceeds its exact ${remainingBytes}-byte remaining budget`,
      );
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        throw new StandardLintSurfaceError("Standard lint source changed while it was inspected");
      }
      offset += read.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, bytes.length)).bytesRead !== 0) {
      throw new StandardLintSurfaceError("Standard lint source grew while it was inspected");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new StandardLintSurfaceError("Standard lint source is not valid UTF-8");
    }
  } finally {
    await handle.close();
  }
}

/**
 * Collect a deterministic, bounded source surface for Standard-mode linting.
 * Kept independent from the HTTP run handler so orchestration adapters can use
 * the same policy without loading the daemon's request/runtime composition.
 */
export async function collectStandardLintSurface(root: string, maxBytes = 2_000_000): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new StandardLintSurfaceError("Standard lint byte budget is invalid");
  }
  const chunks: string[] = [];
  let used = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!STANDARD_LINT_SKIP_DIRS.has(entry.name)) await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (!STANDARD_LINT_EXTENSIONS.has(ext)) continue;
      const relativePath = relative(root, path).split(sep).join("/");
      const safeLabel = JSON.stringify(relativePath).replaceAll("*/", "*\\/");
      const header = `\n/* file: ${safeLabel} */\n`;
      const headerBytes = Buffer.byteLength(header, "utf8");
      if (used + headerBytes > maxBytes) {
        throw new StandardLintSurfaceError(
          `Standard lint source exceeds its exact ${maxBytes}-byte aggregate budget`,
        );
      }
      const text = await readExactSourceFile(path, maxBytes - used - headerBytes);
      if (text.length === 0) continue;
      const chunk = `${header}${text}`;
      used += Buffer.byteLength(chunk, "utf8");
      chunks.push(chunk);
    }
  };
  await walk(root);
  return chunks.join("");
}
