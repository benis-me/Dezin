import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import {
  AgentOutputLimitError,
  NodeSpawner,
} from "../../../../packages/agent/src/index.ts";

const PROTOCOL = "dezin.capture-fd-reader.v1";
const TIMEOUT_MS = 60_000;
const MAX_PARENT_DEPTH = 32;
const MAX_PINNED_DIRECTORIES = 512;
const MAX_FILE_SPECS = 20_000;
const HELPER_ENVIRONMENT_FENCE: NodeJS.ProcessEnv = Object.freeze({
  NODE_OPTIONS: "",
  NODE_PATH: "",
  LD_PRELOAD: "",
  LD_AUDIT: "",
  LD_LIBRARY_PATH: "",
  DYLD_INSERT_LIBRARIES: "",
  DYLD_LIBRARY_PATH: "",
  DYLD_FRAMEWORK_PATH: "",
  DYLD_FALLBACK_LIBRARY_PATH: "",
  DYLD_FALLBACK_FRAMEWORK_PATH: "",
});

const HELPER = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const protocol = "dezin.capture-fd-reader.v1";
function emit(value) { process.stdout.write(JSON.stringify(value)); }
function identity(value) {
  return { dev: String(value.dev), ino: String(value.ino), size: String(value.size), mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) };
}
function sameDirectory(value, expected) {
  return value.isDirectory() && String(value.dev) === expected.dev && String(value.ino) === expected.ino;
}
function failureCode(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  if (code === "ELOOP") return "unsafe";
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ESTALE") return "drifted";
  return "unavailable";
}
function finish(code) { emit({ protocol, ok: false, code }); }
const forbiddenEnvironmentKeys = [
  "DEZIN_DAEMON_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEZIN_CAPTURE_FD_READER_AMBIENT_CANARY",
];
if (forbiddenEnvironmentKeys.some((key) => typeof process.env[key] === "string" && process.env[key].length > 0)) {
  finish("unsafe");
  process.exit(90);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let fd;
  try {
    if (!Number.isInteger(fs.constants.O_NOFOLLOW) || fs.constants.O_NOFOLLOW <= 0
      || !Number.isInteger(fs.constants.O_NONBLOCK) || fs.constants.O_NONBLOCK <= 0) {
      finish("unsafe"); return;
    }
    const request = JSON.parse(input);
    const rootPath = process.cwd();
    if (request.protocol !== protocol || !sameDirectory(fs.statSync(".", { bigint: true }), request.rootIdentity)) {
      finish("unsafe"); return;
    }
    if (!Array.isArray(request.directories)) { finish("unsafe"); return; }
    const directoryByRelative = new Map();
    for (const entry of request.directories) {
      if (!entry || typeof entry.relative !== "string" || directoryByRelative.has(entry.relative)) {
        finish("unsafe"); return;
      }
      directoryByRelative.set(entry.relative, entry);
    }
    let total = 0;
    const files = [];
    for (const spec of request.files) {
      process.chdir(rootPath);
      if (!sameDirectory(fs.statSync(".", { bigint: true }), request.rootIdentity)) { finish("drifted"); return; }
      if (spec.parent) process.chdir(spec.parent.split("/").join(path.sep));
      const expectedDirectory = directoryByRelative.get(spec.parent);
      if (!expectedDirectory || !sameDirectory(fs.statSync(".", { bigint: true }), expectedDirectory.identity)) {
        finish("unsafe"); return;
      }
      try {
        fd = fs.openSync(
          spec.base,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
      } catch (error) {
        finish(failureCode(error)); return;
      }
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 0n
        || before.size > BigInt(spec.hardMaximumBytes)) { finish("unsafe"); return; }
      total += Number(before.size);
      if (!Number.isSafeInteger(total) || total > request.totalBudgetBytes) { finish("budget"); return; }
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) { finish("drifted"); return; }
        offset += count;
      }
      if (fs.readSync(fd, Buffer.allocUnsafe(1), 0, 1, offset) !== 0) { finish("drifted"); return; }
      const after = fs.fstatSync(fd, { bigint: true });
      const beforeIdentity = identity(before);
      if (JSON.stringify(beforeIdentity) !== JSON.stringify(identity(after))) { finish("drifted"); return; }
      const current = fs.lstatSync(spec.base, { bigint: true });
      if (current.isSymbolicLink() || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino
        || !sameDirectory(fs.statSync(".", { bigint: true }), expectedDirectory.identity)) {
        finish("drifted"); return;
      }
      fs.closeSync(fd); fd = undefined;
      files.push({
        path: spec.path,
        bytesBase64: bytes.toString("base64"),
        checksum: crypto.createHash("sha256").update(bytes).digest("hex"),
        identity: beforeIdentity,
      });
    }
    process.chdir(rootPath);
    if (!sameDirectory(fs.statSync(".", { bigint: true }), request.rootIdentity)) { finish("drifted"); return; }
    emit({ protocol, ok: true, files });
  } catch (error) {
    finish(failureCode(error));
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
});
`;

export type ProductionCaptureFdReadErrorCode = "unsafe" | "drifted" | "budget" | "unavailable";

export class ProductionCaptureFdReadError extends Error {
  readonly code: ProductionCaptureFdReadErrorCode;

  constructor(code: ProductionCaptureFdReadErrorCode, cause?: unknown) {
    super(`Production capture fd-relative read failed: ${code}`);
    this.name = "ProductionCaptureFdReadError";
    this.code = code;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export interface ProductionCaptureFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface ProductionCaptureFileRead {
  readonly bytes: Buffer;
  readonly checksum: string;
  readonly identity: ProductionCaptureFileIdentity;
}

export interface ProductionCaptureFileSpec {
  readonly path: string;
  readonly hardMaximumBytes: number;
}

interface PinnedDirectory {
  readonly relative: string;
  readonly path: string;
  readonly canonical: string;
  readonly identity: ProductionCaptureFileIdentity;
  readonly handle: Awaited<ReturnType<typeof open>>;
}

export interface ProductionCaptureSecureOpenFlags {
  readonly noFollow: number;
  readonly directory: number;
  readonly nonBlock: number;
}

export function resolveProductionCaptureSecureOpenFlags(
  source: {
    readonly O_NOFOLLOW?: number;
    readonly O_DIRECTORY?: number;
    readonly O_NONBLOCK?: number;
  } = constants,
): ProductionCaptureSecureOpenFlags | null {
  if (!Number.isInteger(source.O_NOFOLLOW) || (source.O_NOFOLLOW ?? 0) <= 0
    || !Number.isInteger(source.O_DIRECTORY) || (source.O_DIRECTORY ?? 0) <= 0
    || !Number.isInteger(source.O_NONBLOCK) || (source.O_NONBLOCK ?? 0) <= 0) {
    return null;
  }
  return Object.freeze({
    noFollow: source.O_NOFOLLOW!,
    directory: source.O_DIRECTORY!,
    nonBlock: source.O_NONBLOCK!,
  });
}

function fail(code: ProductionCaptureFdReadErrorCode, cause?: unknown): never {
  throw new ProductionCaptureFdReadError(code, cause);
}

function pathFailureCode(error: unknown): ProductionCaptureFdReadErrorCode {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ELOOP") return "unsafe";
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ESTALE") return "drifted";
  return "unavailable";
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Capture fd-relative read aborted", "AbortError");
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function identityOf(value: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): ProductionCaptureFileIdentity {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  });
}

function sameIdentity(left: ProductionCaptureFileIdentity, right: ProductionCaptureFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function wireIdentity(identity: ProductionCaptureFileIdentity) {
  return {
    dev: String(identity.dev),
    ino: String(identity.ino),
    size: String(identity.size),
    mtimeNs: String(identity.mtimeNs),
    ctimeNs: String(identity.ctimeNs),
  };
}

async function pinDirectory(
  rootPath: string,
  canonicalRoot: string,
  relativeDirectory: string,
  flags: ProductionCaptureSecureOpenFlags,
): Promise<PinnedDirectory> {
  const path = relativeDirectory === "" ? rootPath : join(rootPath, ...relativeDirectory.split("/"));
  const lexical = relative(resolve(rootPath), resolve(path));
  if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) fail("unsafe");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | flags.directory | flags.noFollow);
  } catch (error) {
    return fail(pathFailureCode(error), error);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    const canonical = await realpath(path);
    const confined = relativeDirectory === "" ? canonical === canonicalRoot : inside(canonicalRoot, canonical);
    if (!opened.isDirectory() || opened.isSymbolicLink() || current.isSymbolicLink() || !current.isDirectory()
      || current.dev !== opened.dev || current.ino !== opened.ino || !confined) fail("unsafe");
    return Object.freeze({
      relative: relativeDirectory,
      path,
      canonical,
      identity: identityOf(opened),
      handle,
    });
  } catch (error) {
    await handle.close().catch(() => {});
    if (error instanceof ProductionCaptureFdReadError) throw error;
    return fail(pathFailureCode(error), error);
  }
}

async function verifyPinnedDirectory(pin: PinnedDirectory, canonicalRoot: string): Promise<void> {
  try {
    const opened = await pin.handle.stat({ bigint: true });
    const current = await lstat(pin.path, { bigint: true });
    const canonical = await realpath(pin.path);
    const confined = pin.relative === "" ? canonical === canonicalRoot : inside(canonicalRoot, canonical);
    if (!opened.isDirectory() || opened.isSymbolicLink() || !sameIdentity(pin.identity, identityOf(opened))
      || current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(pin.identity, identityOf(current))
      || canonical !== pin.canonical || !confined) fail("drifted");
  } catch (error) {
    if (error instanceof ProductionCaptureFdReadError) throw error;
    fail("drifted", error);
  }
}

function parentPrefixes(specs: readonly ProductionCaptureFileSpec[]): string[] {
  if (specs.length > MAX_FILE_SPECS) fail("unsafe");
  const parents = new Set<string>([""]);
  const paths = new Set<string>();
  for (const spec of specs) {
    if (!spec || typeof spec.path !== "string" || spec.path.length === 0
      || !Number.isSafeInteger(spec.hardMaximumBytes) || spec.hardMaximumBytes < 1
      || paths.has(spec.path)) fail("unsafe");
    paths.add(spec.path);
    const parent = posix.dirname(spec.path);
    if (parent === ".") continue;
    const segments = parent.split("/");
    if (segments.length > MAX_PARENT_DEPTH) fail("unsafe");
    let cursor = "";
    for (const segment of segments) {
      cursor = cursor ? `${cursor}/${segment}` : segment;
      parents.add(cursor);
      if (parents.size > MAX_PINNED_DIRECTORIES) fail("unsafe");
    }
  }
  return [...parents].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export function decodeProductionCaptureFileIdentity(value: unknown): ProductionCaptureFileIdentity {
  const fields = ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail("drifted");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key as typeof fields[number]))) {
    fail("drifted");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const item = {} as Record<typeof fields[number], string>;
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string"
      || !/^(?:0|[1-9]\d*)$/.test(descriptor.value)) fail("drifted");
    item[field] = descriptor.value;
  }
  return Object.freeze({
    dev: BigInt(item.dev),
    ino: BigInt(item.ino),
    size: BigInt(item.size),
    mtimeNs: BigInt(item.mtimeNs),
    ctimeNs: BigInt(item.ctimeNs),
  });
}

export async function readProductionCaptureFilesFdRelative(input: {
  readonly rootPath: string;
  readonly canonicalRoot: string;
  readonly specs: readonly ProductionCaptureFileSpec[];
  readonly totalBudgetBytes: number;
  readonly signal: AbortSignal;
  readonly afterPathFence?: (paths: readonly string[]) => void | Promise<void>;
}): Promise<ReadonlyMap<string, ProductionCaptureFileRead>> {
  checkAbort(input.signal);
  if (!Number.isSafeInteger(input.totalBudgetBytes) || input.totalBudgetBytes < 0 || input.specs.length === 0) fail("unsafe");
  const secureOpenFlags = resolveProductionCaptureSecureOpenFlags();
  if (secureOpenFlags === null) fail("unsafe");
  const pins: PinnedDirectory[] = [];
  try {
    for (const parent of parentPrefixes(input.specs)) {
      checkAbort(input.signal);
      pins.push(await pinDirectory(input.rootPath, input.canonicalRoot, parent, secureOpenFlags));
    }
    await input.afterPathFence?.(input.specs.map((spec) => spec.path));
    checkAbort(input.signal);
    const pinByRelative = new Map(pins.map((pin) => [pin.relative, pin]));
    const root = pinByRelative.get("");
    if (!root) fail("unsafe");
    const request = {
      protocol: PROTOCOL,
      rootIdentity: wireIdentity(root.identity),
      directories: pins.map((pin) => ({ relative: pin.relative, identity: wireIdentity(pin.identity) })),
      files: input.specs.map((spec) => {
        const parent = posix.dirname(spec.path);
        return {
          path: spec.path,
          parent: parent === "." ? "" : parent,
          base: posix.basename(spec.path),
          hardMaximumBytes: spec.hardMaximumBytes,
        };
      }),
      totalBudgetBytes: input.totalBudgetBytes,
    };
    let output;
    try {
      output = await new NodeSpawner({
        timeoutMs: TIMEOUT_MS,
        stdoutLimitBytes: Math.min(128 * 1024 * 1024, Math.max(1024 * 1024, input.totalBudgetBytes * 2 + 4 * 1024 * 1024)),
        stderrLimitBytes: 64 * 1024,
        killDelayMs: 250,
        inheritEnvironment: false,
      }).run({
        command: process.execPath,
        args: ["-e", HELPER],
        cwd: input.rootPath,
        stdin: JSON.stringify(request),
        timeoutMs: TIMEOUT_MS,
        signal: input.signal,
        env: HELPER_ENVIRONMENT_FENCE,
      });
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error;
      return fail(error instanceof AgentOutputLimitError ? "budget" : pathFailureCode(error), error);
    }
    if (output.exitCode !== 0) fail("unavailable");
    let envelope: any;
    try {
      envelope = JSON.parse(output.stdout);
    } catch (error) {
      return fail("unavailable", error);
    }
    if (!envelope || envelope.protocol !== PROTOCOL) fail("unavailable");
    if (envelope.ok !== true) fail(
      envelope.code === "unsafe" || envelope.code === "drifted" || envelope.code === "budget"
        ? envelope.code
        : "unavailable",
    );
    if (!Array.isArray(envelope.files) || envelope.files.length !== input.specs.length) fail("drifted");
    const expected = new Map(input.specs.map((spec) => [spec.path, spec]));
    const result = new Map<string, ProductionCaptureFileRead>();
    for (const raw of envelope.files) {
      const spec = typeof raw?.path === "string" ? expected.get(raw.path) : undefined;
      if (!spec || result.has(raw.path) || typeof raw.bytesBase64 !== "string"
        || typeof raw.checksum !== "string" || !/^[a-f0-9]{64}$/.test(raw.checksum)) fail("drifted");
      const bytes = Buffer.from(raw.bytesBase64, "base64");
      const identity = decodeProductionCaptureFileIdentity(raw.identity);
      if (bytes.toString("base64") !== raw.bytesBase64 || bytes.byteLength > spec.hardMaximumBytes
        || identity.size !== BigInt(bytes.byteLength)
        || createHash("sha256").update(bytes).digest("hex") !== raw.checksum) fail("drifted");
      result.set(raw.path, Object.freeze({ bytes, checksum: raw.checksum, identity }));
    }
    for (const pin of pins) await verifyPinnedDirectory(pin, input.canonicalRoot);
    checkAbort(input.signal);
    return result;
  } finally {
    await Promise.all(pins.map((pin) => pin.handle.close().catch(() => {})));
  }
}
