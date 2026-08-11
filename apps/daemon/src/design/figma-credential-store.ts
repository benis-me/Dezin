import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

import type { FigmaCredentialStatus } from "@dezin/design-canvas-contracts";

const FIGMA_CREDENTIAL_SCHEMA_VERSION = 1;
const MAX_SECRET_FILE_BYTES = 8 * 1024;
const MAX_SECRET_ROOT_ENTRIES = 256;
const OWNED_SECRET_TEMP = /^\.figma-pat\.json\.p([1-9][0-9]{0,9})\.s([a-f0-9]{32})\.([a-f0-9-]{36})\.tmp$/i;
const LEGACY_OWNED_SECRET_TEMP = /^\.figma-pat\.json\.[a-f0-9-]{36}\.tmp$/i;
const OWNED_SECRET_TEMP_SHAPE = /^\.figma-pat\.json\..+\.tmp$/i;
const MALFORMED_SECRET_TEMP_GRACE_MS = 2_000;
const credentialStoreTails = new Map<string, Promise<void>>();
const execFile = promisify(execFileCallback);

export interface ResolvedFigmaCredential {
  token: string;
  mode: "personal-access-token";
  source: "environment" | "local";
  subject: string;
}

export interface FigmaCredentialStoreOptions {
  dataDir: string;
  env?: Readonly<Record<string, string | undefined>>;
  testHooks?: {
    afterCredentialStat?: (path: string) => void | Promise<void>;
    afterCredentialPendingSync?: (path: string) => void | Promise<void>;
    afterDirectorySync?: (path: string) => void | Promise<void>;
  };
}

export class FigmaCredentialStoreError extends Error {
  readonly code: "invalid-input" | "corrupt";

  constructor(code: FigmaCredentialStoreError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FigmaCredentialStoreError";
    this.code = code;
  }
}

function secretRoot(dataDir: string): string {
  return join(dataDir, "secrets");
}

function secretPath(dataDir: string): string {
  return join(secretRoot(dataDir), "figma-pat.json");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function processStartIdentity(pid: number): Promise<string> {
  const result = await execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    timeout: 2_000,
    maxBuffer: 8_192,
    // `lstart` is display text. Pin every observer to one non-secret locale/timezone so the
    // same process identity hashes identically across daemon and helper environments.
    env: { TZ: "UTC", LC_ALL: "C", LANG: "C" },
  });
  const identity = result.stdout.trim();
  if (!identity || Buffer.byteLength(identity, "utf8") > 256) {
    throw new Error("process start identity is unavailable");
  }
  return identity;
}

function processIdentityDigest(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

async function livePendingOwner(pid: number, identityDigest: string): Promise<boolean> {
  if (!processIsAlive(pid)) return false;
  try {
    return processIdentityDigest(await processStartIdentity(pid)) === identityDigest;
  } catch {
    // A live process whose stable identity cannot be inspected retains ownership.
    return true;
  }
}

async function ownedSecretTempPath(path: string): Promise<string> {
  let identity: string;
  try {
    identity = await processStartIdentity(process.pid);
  } catch (error) {
    throw new FigmaCredentialStoreError(
      "corrupt",
      "Could not establish a stable owner for the Figma credential update",
      { cause: error },
    );
  }
  return join(
    dirname(path),
    `.${basename(path)}.p${process.pid}.s${processIdentityDigest(identity)}.${randomUUID()}.tmp`,
  );
}

async function withCredentialStoreLock<T>(dataDir: string, operation: () => Promise<T>): Promise<T> {
  const key = resolvePath(dataDir);
  const predecessor = credentialStoreTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = predecessor.then(() => gate, () => gate);
  credentialStoreTails.set(key, tail);
  await predecessor.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (credentialStoreTails.get(key) === tail) credentialStoreTails.delete(key);
  }
}

function token(value: unknown, code: FigmaCredentialStoreError["code"]): string {
  if (typeof value !== "string" || !/^figd_[A-Za-z0-9._-]{15,4091}$/.test(value)) {
    throw new FigmaCredentialStoreError(code, code === "corrupt"
      ? "Stored Figma credential is corrupt"
      : "Figma personal access token is invalid");
  }
  return value;
}

function subject(value: string): string {
  return `pat-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

async function existingSecretRoot(dataDir: string): Promise<boolean> {
  const root = secretRoot(dataDir);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new FigmaCredentialStoreError("corrupt", "Figma secret root must be a private regular directory");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new FigmaCredentialStoreError("corrupt", "Figma secret root permissions are not private");
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function ensureSecretRoot(dataDir: string): Promise<void> {
  if (!(await existingSecretRoot(dataDir))) {
    await mkdir(dataDir, { recursive: true });
    let created = false;
    try {
      await mkdir(secretRoot(dataDir), { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    if (created) await chmod(secretRoot(dataDir), 0o700);
  }
  await existingSecretRoot(dataDir);
}

async function syncDirectory(path: string, options: FigmaCredentialStoreOptions): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  await options.testHooks?.afterDirectorySync?.(path);
}

async function cleanupOwnedSecretTemps(options: FigmaCredentialStoreOptions): Promise<void> {
  if (!(await existingSecretRoot(options.dataDir))) return;
  const root = secretRoot(options.dataDir);
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > MAX_SECRET_ROOT_ENTRIES) {
    throw new FigmaCredentialStoreError("corrupt", "Figma secret root exceeds its entry budget");
  }
  let changed = false;
  for (const entry of entries) {
    const owner = OWNED_SECRET_TEMP.exec(entry.name);
    const ownedShape = owner !== null || LEGACY_OWNED_SECRET_TEMP.test(entry.name)
      || OWNED_SECRET_TEMP_SHAPE.test(entry.name);
    if (!ownedShape) continue;
    const path = join(root, entry.name);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !info.isFile() || info.isSymbolicLink()
      || (info.mode & 0o077) !== 0) {
      throw new FigmaCredentialStoreError("corrupt", "Figma credential temporary authority is corrupt");
    }
    if (owner !== null) {
      const pid = Number(owner[1]);
      if (!Number.isSafeInteger(pid) || pid < 1) {
        throw new FigmaCredentialStoreError("corrupt", "Figma credential temporary authority owner is corrupt");
      }
      if (await livePendingOwner(pid, owner[2]!)) continue;
    } else if (Date.now() - info.mtimeMs < MALFORMED_SECRET_TEMP_GRACE_MS) {
      // Legacy or malformed owned temps have no verifiable owner. A short grace prevents
      // racing publication; once it expires they are non-authoritative crash residue.
      continue;
    }
    await rm(path, { force: true });
    changed = true;
  }
  if (changed) await syncDirectory(root, options);
}

async function readLocalToken(options: FigmaCredentialStoreOptions): Promise<string | null> {
  const { dataDir } = options;
  if (!(await existingSecretRoot(dataDir))) return null;
  await cleanupOwnedSecretTemps(options);
  const path = secretPath(dataDir);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_SECRET_FILE_BYTES
      || (info.mode & 0o077) !== 0) {
      throw new FigmaCredentialStoreError("corrupt", "Stored Figma credential must be a private regular file");
    }
    await options.testHooks?.afterCredentialStat?.(path);
    const bytes = Buffer.allocUnsafe(info.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (bytesRead !== info.size || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size
      || pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.dev !== info.dev
      || pathAfter.ino !== info.ino || pathAfter.size !== info.size) {
      throw new FigmaCredentialStoreError("corrupt", "Stored Figma credential changed while being read");
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } catch (error) {
      throw new FigmaCredentialStoreError("corrupt", "Stored Figma credential is corrupt", { cause: error });
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new FigmaCredentialStoreError("corrupt", "Stored Figma credential is corrupt");
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.schemaVersion !== FIGMA_CREDENTIAL_SCHEMA_VERSION
      || Object.keys(record).some((key) => !["schemaVersion", "token"].includes(key))) {
      throw new FigmaCredentialStoreError("corrupt", "Stored Figma credential is corrupt");
    }
    return token(record.token, "corrupt");
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new FigmaCredentialStoreError("corrupt", "Stored Figma credential may not be a symlink", { cause: error });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertReplaceableLocalSecret(dataDir: string): Promise<void> {
  try {
    const info = await lstat(secretPath(dataDir));
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new FigmaCredentialStoreError("corrupt", "Stored Figma credential must be a regular file, not a symlink");
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function environmentToken(options: FigmaCredentialStoreOptions): string | null {
  const value = (options.env ?? process.env).FIGMA_ACCESS_TOKEN;
  return value === undefined || value === "" ? null : token(value, "invalid-input");
}

async function resolveFigmaCredentialUnlocked(
  options: FigmaCredentialStoreOptions,
): Promise<ResolvedFigmaCredential | null> {
  const fromEnvironment = environmentToken(options);
  if (fromEnvironment !== null) {
    return {
      token: fromEnvironment,
      mode: "personal-access-token",
      source: "environment",
      subject: subject(fromEnvironment),
    };
  }
  const local = await readLocalToken(options);
  return local === null ? null : {
    token: local,
    mode: "personal-access-token",
    source: "local",
    subject: subject(local),
  };
}

export async function resolveFigmaCredential(
  options: FigmaCredentialStoreOptions,
): Promise<ResolvedFigmaCredential | null> {
  return withCredentialStoreLock(options.dataDir, () => resolveFigmaCredentialUnlocked(options));
}

async function getFigmaCredentialStatusUnlocked(
  options: FigmaCredentialStoreOptions,
): Promise<FigmaCredentialStatus> {
  await cleanupOwnedSecretTemps(options);
  const credential = await resolveFigmaCredentialUnlocked(options);
  return credential === null
    ? { configured: false, source: null }
    : { configured: true, source: credential.source };
}

export async function getFigmaCredentialStatus(
  options: FigmaCredentialStoreOptions,
): Promise<FigmaCredentialStatus> {
  return withCredentialStoreLock(options.dataDir, () => getFigmaCredentialStatusUnlocked(options));
}

async function putLocalFigmaCredentialUnlocked(
  options: FigmaCredentialStoreOptions & { token: string },
): Promise<FigmaCredentialStatus> {
  const value = token(options.token, "invalid-input");
  await ensureSecretRoot(options.dataDir);
  await syncDirectory(options.dataDir, options);
  await cleanupOwnedSecretTemps(options);
  await assertReplaceableLocalSecret(options.dataDir);
  const path = secretPath(options.dataDir);
  const pending = await ownedSecretTempPath(path);
  let pendingHandle;
  try {
    pendingHandle = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await pendingHandle.writeFile(`${JSON.stringify({ schemaVersion: FIGMA_CREDENTIAL_SCHEMA_VERSION, token: value })}\n`);
    await pendingHandle.sync();
    await options.testHooks?.afterCredentialPendingSync?.(pending);
    await pendingHandle.close();
    pendingHandle = undefined;
    await chmod(pending, 0o600);
    await rename(pending, path);
    await syncDirectory(secretRoot(options.dataDir), options);
  } finally {
    await pendingHandle?.close().catch(() => {});
    await rm(pending, { force: true }).catch(() => {});
  }
  return getFigmaCredentialStatusUnlocked(options);
}

export async function putLocalFigmaCredential(
  options: FigmaCredentialStoreOptions & { token: string },
): Promise<FigmaCredentialStatus> {
  return withCredentialStoreLock(options.dataDir, () => putLocalFigmaCredentialUnlocked(options));
}

async function deleteLocalFigmaCredentialUnlocked(
  options: FigmaCredentialStoreOptions,
): Promise<FigmaCredentialStatus> {
  if (await existingSecretRoot(options.dataDir)) {
    await cleanupOwnedSecretTemps(options);
    await assertReplaceableLocalSecret(options.dataDir);
    await rm(secretPath(options.dataDir), { force: true });
    await syncDirectory(secretRoot(options.dataDir), options);
  }
  return getFigmaCredentialStatusUnlocked(options);
}

export async function deleteLocalFigmaCredential(
  options: FigmaCredentialStoreOptions,
): Promise<FigmaCredentialStatus> {
  return withCredentialStoreLock(options.dataDir, () => deleteLocalFigmaCredentialUnlocked(options));
}
