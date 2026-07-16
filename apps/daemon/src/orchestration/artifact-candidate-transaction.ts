import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { agentSpawnEnv } from "../../../../packages/agent/src/index.ts";

const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;
const EMPTY_HOOKS_PATH = "/dev/null";
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ZERO_BYTE = Buffer.from([0]);

export interface ArtifactCandidateAttempt {
  workspaceId: string;
  taskId: string;
  attempt: number;
  inputHash: string;
  createdAt: number;
  sourceCommitHash: string;
  sourceTreeHash: string;
}

export interface ArtifactCandidateIdentity {
  commitHash: string;
  treeHash: string;
}

export interface ArtifactCandidateResult extends ArtifactCandidateIdentity {
  attemptRef: string;
}

export interface BeginArtifactCandidateTransactionInput {
  repositoryDir: string;
  attempt: ArtifactCandidateAttempt;
  signal?: AbortSignal;
}

export interface ArtifactCandidateTransactionDeps {
  checkpoint?: (phase: "after-attempt-ref") => void | Promise<void>;
}

export interface CommitArtifactCandidateInput {
  message: string;
  signal?: AbortSignal;
}

export interface ArtifactCandidateTransaction {
  readonly dir: string;
  readonly worktreeDir: string;
  readonly attemptRef: string;
  fingerprint(signal: AbortSignal): Promise<string>;
  commit(message: string, signal: AbortSignal): Promise<ArtifactCandidateResult>;
  commitCandidate(input: CommitArtifactCandidateInput): Promise<ArtifactCandidateResult>;
  restore(candidate: ArtifactCandidateIdentity, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export interface ArtifactCandidateLifecycleInput {
  repositoryDir: string;
  attempt: ArtifactCandidateAttempt;
  revisionId: string;
  candidate: ArtifactCandidateIdentity & { attemptRef?: string };
  /** Exact ordered candidate versions recorded in immutable execution evidence. */
  history: readonly ArtifactCandidateIdentity[];
  /** Exact final Attempt head that retains every version, including rounds after the selection. */
  historyHead: ArtifactCandidateIdentity;
  signal?: AbortSignal;
}

export interface ReleaseOrphanArtifactCandidateAttemptRefInput {
  repositoryDir: string;
  attempt: ArtifactCandidateAttempt;
  signal?: AbortSignal;
}

export interface VerifyArtifactCandidateObjectInput {
  repositoryDir: string;
  commitHash: string;
  treeHash: string;
  signal?: AbortSignal;
}

export class ArtifactCandidateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactCandidateValidationError";
  }
}

export class ArtifactCandidateRevisionRefNotRetainedError extends ArtifactCandidateValidationError {
  readonly ref: string;
  readonly state: "missing" | "conflict";
  readonly actual: string | null;

  constructor(ref: string, actual: string | null) {
    super(actual === null
      ? `durable revision ref does not retain the candidate: ${ref} is missing`
      : `durable revision ref does not retain the candidate: ${ref} conflicts`);
    this.name = "ArtifactCandidateRevisionRefNotRetainedError";
    this.ref = ref;
    this.state = actual === null ? "missing" : "conflict";
    this.actual = actual;
  }
}

export class ArtifactCandidateRefConflictError extends Error {
  readonly ref: string;

  constructor(ref: string, message = `durable Artifact candidate ref ${ref} changed concurrently`) {
    super(message);
    this.name = "ArtifactCandidateRefConflictError";
    this.ref = ref;
  }
}

interface ResolvedRepository {
  root: string;
  commonGitDir: string;
  objectDir: string;
  objectIdLength: 40 | 64;
  objectFormat: "sha1" | "sha256";
}

interface GitCommandOptions {
  signal?: AbortSignal;
  input?: string | Buffer;
  gitEnv?: NodeJS.ProcessEnv;
  hooksPath?: string;
}

interface GitCommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Artifact candidate transaction aborted", "AbortError");
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function combinedSignal(left?: AbortSignal, right?: AbortSignal): AbortSignal | undefined {
  if (left === undefined) return right;
  if (right === undefined || right === left) return left;
  return AbortSignal.any([left, right]);
}

function safeGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = agentSpawnEnv();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  return {
    ...env,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_PAGER: "cat",
    ...extra,
  };
}

function hardenedGitArgs(args: readonly string[], hooksPath = EMPTY_HOOKS_PATH): string[] {
  return [
    "--no-replace-objects",
    "-c", `core.hooksPath=${hooksPath}`,
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "core.fsmonitor=false",
    "-c", "core.autocrlf=false",
    "-c", "core.attributesFile=/dev/null",
    ...args,
  ];
}

function captureGit(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  checkAbort(options.signal);
  return new Promise((resolveCommand, reject) => {
    const child = spawn("git", hardenedGitArgs(args, options.hooksPath), {
      cwd,
      env: safeGitEnvironment(options.gitEnv),
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > GIT_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        finish(() => reject(new ArtifactCandidateValidationError("Git output exceeded the Artifact transaction limit")));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => finish(() => reject(options.signal?.aborted ? abortReason(options.signal) : error)));
    child.on("close", (code) => finish(() => resolveCommand({
      code: code ?? 1,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    })));
    child.stdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") finish(() => reject(error));
    });
    child.stdin.end(options.input);
  });
}

function gitError(args: readonly string[], result: GitCommandResult): Error {
  const detail = Buffer.concat([result.stderr, result.stdout]).toString("utf8").trim();
  return new Error(`git ${args.join(" ")} failed: ${detail || `exit ${result.code}`}`);
}

async function gitBuffer(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<Buffer> {
  const result = await captureGit(cwd, args, options);
  if (result.code !== 0) throw gitError(args, result);
  checkAbort(options.signal);
  return result.stdout;
}

async function gitOutput(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<string> {
  return (await gitBuffer(cwd, args, options)).toString("utf8").trim();
}

async function gitVoid(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<void> {
  await gitBuffer(cwd, args, options);
}

function canonicalString(value: unknown, label: string, maxLength = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength
    || value.includes("\0") || !isWellFormed(value)) {
    throw new ArtifactCandidateValidationError(`${label} is invalid`);
  }
  return value;
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalObjectId(value: unknown, label: string, expectedLength?: 40 | 64): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)
    || (expectedLength !== undefined && value.length !== expectedLength)) {
    throw new ArtifactCandidateValidationError(`${label} is not a canonical Git object id`);
  }
  return value;
}

function canonicalAttempt(value: ArtifactCandidateAttempt, objectIdLength?: 40 | 64): ArtifactCandidateAttempt {
  const attempt = {
    workspaceId: canonicalString(value?.workspaceId, "Artifact Attempt workspace id", 256),
    taskId: canonicalString(value?.taskId, "Artifact Attempt Task id", 256),
    attempt: value?.attempt,
    inputHash: value?.inputHash,
    createdAt: value?.createdAt,
    sourceCommitHash: canonicalObjectId(
      value?.sourceCommitHash,
      "Artifact Attempt source commit hash",
      objectIdLength,
    ),
    sourceTreeHash: canonicalObjectId(
      value?.sourceTreeHash,
      "Artifact Attempt source tree hash",
      objectIdLength,
    ),
  };
  if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1
    || typeof attempt.inputHash !== "string" || !/^[0-9a-f]{64}$/.test(attempt.inputHash)
    || !Number.isSafeInteger(attempt.createdAt) || attempt.createdAt < 0) {
    throw new ArtifactCandidateValidationError("Artifact Attempt identity is invalid");
  }
  return attempt as ArtifactCandidateAttempt;
}

function safeRefDigest(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function artifactCandidateAttemptRef(attemptInput: ArtifactCandidateAttempt): string {
  const attempt = canonicalAttempt(attemptInput);
  return `refs/dezin/generation-attempts/artifacts/${safeRefDigest([
    "artifact-candidate-attempt-v1",
    attempt.workspaceId,
    attempt.taskId,
    attempt.attempt,
    attempt.inputHash,
  ])}`;
}

export function artifactRevisionRef(revisionIdInput: string): string {
  const revisionId = canonicalString(revisionIdInput, "Artifact Revision id", 256);
  // Keep one canonical Revision namespace with direct mutation and recovery flows.
  return `refs/dezin/artifact-revisions/${createHash("sha256").update(revisionId).digest("hex")}`;
}

/** Canonical durable head from which Task 15 viewers can derive a Revision's full version lineage. */
export function artifactRevisionHistoryRef(revisionIdInput: string): string {
  const revisionId = canonicalString(revisionIdInput, "Artifact Revision id", 256);
  return `refs/dezin/artifact-revision-history/${createHash("sha256").update(revisionId).digest("hex")}`;
}

async function resolveRepository(repositoryDir: string, signal?: AbortSignal): Promise<ResolvedRepository> {
  checkAbort(signal);
  const repositoryPath = canonicalString(repositoryDir, "Artifact repository path", 4_096);
  if (repositoryPath.includes("\n") || repositoryPath.includes("\r")) {
    throw new ArtifactCandidateValidationError("Artifact repository path is invalid");
  }
  const requested = await realpath(resolve(repositoryPath));
  const topLevelOutput = await gitOutput(requested, ["rev-parse", "--path-format=absolute", "--show-toplevel"], { signal });
  const topLevel = await realpath(topLevelOutput);
  if (requested !== topLevel) {
    throw new ArtifactCandidateValidationError("Artifact repository path must be the owned repository root");
  }
  const [bare, commonGitDirOutput, objectDirOutput, objectFormat] = await Promise.all([
    gitOutput(requested, ["rev-parse", "--is-bare-repository"], { signal }),
    gitOutput(requested, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal }),
    gitOutput(requested, ["rev-parse", "--path-format=absolute", "--git-path", "objects"], { signal }),
    gitOutput(requested, ["rev-parse", "--show-object-format"], { signal }),
  ]);
  if (bare !== "false" || (objectFormat !== "sha1" && objectFormat !== "sha256")) {
    throw new ArtifactCandidateValidationError("Artifact repository must be an owned non-bare SHA repository");
  }
  const commonGitDir = await realpath(commonGitDirOutput);
  const objectDir = await realpath(objectDirOutput);
  if (objectDir.includes("\n") || objectDir.includes("\r")) {
    throw new ArtifactCandidateValidationError("Artifact repository object directory is invalid");
  }
  return {
    root: topLevel,
    commonGitDir,
    objectDir,
    objectFormat,
    objectIdLength: objectFormat === "sha1" ? 40 : 64,
  };
}

async function verifyObjectInRepository(
  repository: ResolvedRepository,
  commitHashInput: string,
  treeHashInput: string,
  signal?: AbortSignal,
): Promise<ArtifactCandidateIdentity> {
  const commitHash = canonicalObjectId(commitHashInput, "Artifact candidate commit hash", repository.objectIdLength);
  const treeHash = canonicalObjectId(treeHashInput, "Artifact candidate tree hash", repository.objectIdLength);
  let commitType: string;
  let treeType: string;
  let exactTree: string;
  try {
    [commitType, treeType, exactTree] = await Promise.all([
      gitOutput(repository.root, ["cat-file", "-t", commitHash], { signal }),
      gitOutput(repository.root, ["cat-file", "-t", treeHash], { signal }),
      gitOutput(repository.root, ["rev-parse", "--verify", `${commitHash}^{tree}`], { signal }),
    ]);
  } catch {
    checkAbort(signal);
    throw new ArtifactCandidateValidationError("Artifact candidate commit or tree is not exactly readable in the owned repository");
  }
  if (commitType !== "commit" || treeType !== "tree" || exactTree !== treeHash) {
    throw new ArtifactCandidateValidationError("Artifact candidate commit does not name the exact expected tree");
  }
  return { commitHash, treeHash };
}

export async function verifyArtifactCandidateObject(
  input: VerifyArtifactCandidateObjectInput,
): Promise<ArtifactCandidateIdentity> {
  const repository = await resolveRepository(input.repositoryDir, input.signal);
  return verifyObjectInRepository(repository, input.commitHash, input.treeHash, input.signal);
}

async function verifyAttemptBase(
  repository: ResolvedRepository,
  attemptInput: ArtifactCandidateAttempt,
  signal?: AbortSignal,
): Promise<ArtifactCandidateAttempt> {
  const attempt = canonicalAttempt(attemptInput, repository.objectIdLength);
  let exactTree: string;
  try {
    const [commitType, treeType, resolvedTree] = await Promise.all([
      gitOutput(repository.root, ["cat-file", "-t", attempt.sourceCommitHash], { signal }),
      gitOutput(repository.root, ["cat-file", "-t", attempt.sourceTreeHash], { signal }),
      gitOutput(repository.root, ["rev-parse", "--verify", `${attempt.sourceCommitHash}^{tree}`], { signal }),
    ]);
    if (commitType !== "commit" || treeType !== "tree") throw new Error("wrong object type");
    exactTree = resolvedTree;
  } catch {
    checkAbort(signal);
    throw new ArtifactCandidateValidationError("immutable Artifact Attempt source commit or tree is not readable");
  }
  if (exactTree !== attempt.sourceTreeHash) {
    throw new ArtifactCandidateValidationError("immutable Artifact Attempt source tree does not match its exact commit");
  }
  return attempt;
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return FATAL_UTF8.decode(bytes);
  } catch {
    throw new ArtifactCandidateValidationError(`${label} is not valid UTF-8`);
  }
}

function assertSafeRepositoryPath(path: string): void {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path) || posix.normalize(path) !== path
    || path === ".." || path.startsWith("../")
    || path.split("/").some((part) => part.length === 0 || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new ArtifactCandidateValidationError("Artifact source tree contains an unsafe repository path");
  }
}

function assertConfinedSymlink(path: string, target: string): void {
  if (target.length === 0 || target.includes("\0") || isAbsolute(target)) {
    throw new ArtifactCandidateValidationError(`Artifact source symlink ${path} escapes the isolated worktree`);
  }
  const resolvedTarget = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolvedTarget === ".." || resolvedTarget.startsWith("../") || isAbsolute(resolvedTarget)) {
    throw new ArtifactCandidateValidationError(`Artifact source symlink ${path} escapes the isolated worktree`);
  }
}

async function clearMaterializedWorktree(worktreeDir: string): Promise<void> {
  const entries = await readdir(worktreeDir);
  await Promise.all(entries
    .filter((name) => name !== ".git")
    .map((name) => rm(join(worktreeDir, name), { recursive: true, force: true })));
}

interface TreeRecord {
  mode: string;
  type: string;
  objectId: string;
  path: string;
}

function parseTreeRecords(output: Buffer, objectIdLength: 40 | 64): TreeRecord[] {
  const records: TreeRecord[] = [];
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    if (end < 0) throw new ArtifactCandidateValidationError("Artifact source tree listing is truncated");
    const record = output.subarray(offset, end);
    offset = end + 1;
    if (record.length === 0) continue;
    const separator = record.indexOf(9);
    if (separator < 0) throw new ArtifactCandidateValidationError("Artifact source tree listing is invalid");
    const header = record.subarray(0, separator).toString("ascii");
    const match = /^(040000|100644|100755|120000|160000) (tree|blob|commit) ([0-9a-f]+)$/.exec(header);
    if (!match || match[3]!.length !== objectIdLength) {
      throw new ArtifactCandidateValidationError("Artifact source tree entry is invalid");
    }
    const path = decodeUtf8(record.subarray(separator + 1), "Artifact source path");
    assertSafeRepositoryPath(path);
    records.push({ mode: match[1]!, type: match[2]!, objectId: match[3]!, path });
  }
  return records;
}

async function materializeTree(
  repository: ResolvedRepository,
  treeHash: string,
  worktreeDir: string,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  await clearMaterializedWorktree(worktreeDir);
  const listing = await gitBuffer(repository.root, ["ls-tree", "-r", "-t", "-z", "--full-tree", treeHash], { signal });
  const records = parseTreeRecords(listing, repository.objectIdLength);
  for (const record of records) {
    checkAbort(signal);
    const absolutePath = resolve(worktreeDir, ...record.path.split("/"));
    const offset = relative(worktreeDir, absolutePath);
    if (offset.startsWith("..") || isAbsolute(offset)) {
      throw new ArtifactCandidateValidationError("Artifact source path escaped the isolated worktree");
    }
    if (record.mode === "040000" && record.type === "tree") {
      await mkdir(absolutePath, { recursive: true });
      continue;
    }
    if (record.mode === "160000" || record.type === "commit") {
      throw new ArtifactCandidateValidationError("Artifact source cannot contain Gitlinks or submodules");
    }
    await mkdir(resolve(absolutePath, ".."), { recursive: true });
    const bytes = await gitBuffer(repository.root, ["cat-file", "blob", record.objectId], { signal });
    if (record.mode === "120000") {
      const target = decodeUtf8(bytes, `Artifact symlink ${record.path}`);
      assertConfinedSymlink(record.path, target);
      await symlink(target, absolutePath);
    } else {
      await writeFile(absolutePath, bytes, { mode: record.mode === "100755" ? 0o755 : 0o644 });
      await chmod(absolutePath, record.mode === "100755" ? 0o755 : 0o644);
    }
  }
}

interface IsolatedGit {
  gitDir: string;
  realGitDir: string;
  hooksDir: string;
  objectEnvironment: NodeJS.ProcessEnv;
}

function isolatedArgs(isolated: IsolatedGit, worktreeDir: string, args: readonly string[]): string[] {
  return [`--git-dir=${isolated.gitDir}`, `--work-tree=${worktreeDir}`, ...args];
}

async function hashBlob(
  repository: ResolvedRepository,
  isolated: IsolatedGit,
  worktreeDir: string,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<string> {
  const hash = await gitOutput(worktreeDir, isolatedArgs(isolated, worktreeDir, [
    "hash-object", "-w", "--no-filters", "--stdin",
  ]), {
    signal,
    input: bytes,
    gitEnv: isolated.objectEnvironment,
    hooksPath: isolated.hooksDir,
  });
  return canonicalObjectId(hash, "Artifact candidate blob hash", repository.objectIdLength);
}

async function buildDirectoryTree(
  repository: ResolvedRepository,
  isolated: IsolatedGit,
  worktreeDir: string,
  directory: string,
  relativeDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  checkAbort(signal);
  const names = (await readdir(directory)).sort((left, right) => (
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  ));
  const records: Buffer[] = [];
  for (const name of names) {
    checkAbort(signal);
    if (relativeDirectory === "" && name === ".git") continue;
    canonicalString(name, "Artifact candidate path component", 4_096);
    if (name === "." || name === ".." || name.toLowerCase() === ".git" || name.includes("/")) {
      throw new ArtifactCandidateValidationError("Artifact candidate contains an unsafe path component");
    }
    const path = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    assertSafeRepositoryPath(path);
    const absolutePath = join(directory, name);
    const metadata = await lstat(absolutePath);
    let mode: string;
    let type: "blob" | "tree";
    let objectId: string;
    if (metadata.isDirectory()) {
      mode = "040000";
      type = "tree";
      objectId = await buildDirectoryTree(
        repository,
        isolated,
        worktreeDir,
        absolutePath,
        path,
        signal,
      );
    } else if (metadata.isFile()) {
      mode = (metadata.mode & 0o111) === 0 ? "100644" : "100755";
      type = "blob";
      objectId = await hashBlob(repository, isolated, worktreeDir, await readFile(absolutePath), signal);
    } else if (metadata.isSymbolicLink()) {
      mode = "120000";
      type = "blob";
      const target = await readlink(absolutePath);
      assertConfinedSymlink(path, target);
      objectId = await hashBlob(repository, isolated, worktreeDir, Buffer.from(target, "utf8"), signal);
    } else {
      throw new ArtifactCandidateValidationError(`Artifact candidate path ${path} has an unsupported file type`);
    }
    records.push(Buffer.concat([
      Buffer.from(`${mode} ${type} ${objectId}\t`, "utf8"),
      Buffer.from(name, "utf8"),
      ZERO_BYTE,
    ]));
  }
  const treeHash = await gitOutput(worktreeDir, isolatedArgs(isolated, worktreeDir, ["mktree", "-z"]), {
    signal,
    input: Buffer.concat(records),
    gitEnv: isolated.objectEnvironment,
    hooksPath: isolated.hooksDir,
  });
  return canonicalObjectId(treeHash, "Artifact candidate tree hash", repository.objectIdLength);
}

async function buildWorktreeTree(
  repository: ResolvedRepository,
  isolated: IsolatedGit,
  worktreeDir: string,
  signal?: AbortSignal,
): Promise<string> {
  const gitMetadata = await lstat(isolated.gitDir);
  if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()
    || await realpath(isolated.gitDir) !== isolated.realGitDir) {
    throw new ArtifactCandidateValidationError("isolated Artifact transaction Git metadata was replaced");
  }
  return buildDirectoryTree(repository, isolated, worktreeDir, worktreeDir, "", signal);
}

async function readRef(
  repository: ResolvedRepository,
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await captureGit(repository.root, [
    "for-each-ref", "--format=%(refname)%00%(objectname)", ref,
  ], { signal });
  if (result.code !== 0) throw gitError(["for-each-ref", ref], result);
  const values = result.stdout.toString("utf8").trim().split(/\r?\n/).filter(Boolean)
    .map((line) => line.split("\0"))
    .filter(([name]) => name === ref);
  if (values.length === 0) return null;
  if (values.length !== 1 || values[0]!.length !== 2) {
    throw new ArtifactCandidateValidationError(`durable ref ${ref} is ambiguous`);
  }
  return canonicalObjectId(values[0]![1], `durable ref ${ref}`, repository.objectIdLength);
}

async function advanceRef(
  repository: ResolvedRepository,
  ref: string,
  candidate: string,
  expected: string | null,
  signal?: AbortSignal,
): Promise<void> {
  const oldValue = expected ?? "0".repeat(repository.objectIdLength);
  const result = await captureGit(repository.root, ["update-ref", ref, candidate, oldValue], { signal });
  if (result.code === 0) return;
  checkAbort(signal);
  const actual = await readRef(repository, ref, signal);
  if (actual === candidate) return;
  throw new ArtifactCandidateRefConflictError(ref);
}

function canonicalCommitMessage(value: unknown): string {
  const message = canonicalString(value, "Artifact candidate commit message", 4_096)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 256);
  if (message.length === 0) throw new ArtifactCandidateValidationError("Artifact candidate commit message is empty");
  return message;
}

async function writeCandidateCommit(
  repository: ResolvedRepository,
  isolated: IsolatedGit,
  worktreeDir: string,
  attempt: ArtifactCandidateAttempt,
  parentCommitHash: string,
  treeHash: string,
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  const timestampSeconds = Math.floor(attempt.createdAt / 1_000);
  const identityEnvironment: NodeJS.ProcessEnv = {
    ...isolated.objectEnvironment,
    GIT_AUTHOR_NAME: "Dezin",
    GIT_AUTHOR_EMAIL: "daemon@dezin.local",
    GIT_AUTHOR_DATE: `@${timestampSeconds} +0000`,
    GIT_COMMITTER_NAME: "Dezin",
    GIT_COMMITTER_EMAIL: "daemon@dezin.local",
    GIT_COMMITTER_DATE: `@${timestampSeconds} +0000`,
  };
  const commitHash = await gitOutput(worktreeDir, isolatedArgs(isolated, worktreeDir, [
    "commit-tree", treeHash, "-p", parentCommitHash,
  ]), {
    signal,
    input: `${message}\n`,
    gitEnv: identityEnvironment,
    hooksPath: isolated.hooksDir,
  });
  return canonicalObjectId(commitHash, "Artifact candidate commit hash", repository.objectIdLength);
}

async function pointIsolatedHead(
  isolated: IsolatedGit,
  worktreeDir: string,
  commitHash: string,
  treeHash: string,
  signal?: AbortSignal,
): Promise<void> {
  await gitVoid(worktreeDir, isolatedArgs(isolated, worktreeDir, [
    "update-ref", "--no-deref", "HEAD", commitHash,
  ]), {
    signal,
    gitEnv: isolated.objectEnvironment,
    hooksPath: isolated.hooksDir,
  });
  await gitVoid(worktreeDir, isolatedArgs(isolated, worktreeDir, ["read-tree", treeHash]), {
    signal,
    gitEnv: isolated.objectEnvironment,
    hooksPath: isolated.hooksDir,
  });
}

export async function beginArtifactCandidateTransaction(
  input: BeginArtifactCandidateTransactionInput,
  deps: ArtifactCandidateTransactionDeps = {},
): Promise<ArtifactCandidateTransaction> {
  checkAbort(input.signal);
  const repository = await resolveRepository(input.repositoryDir, input.signal);
  const attempt = await verifyAttemptBase(repository, input.attempt, input.signal);
  const attemptRef = artifactCandidateAttemptRef(attempt);
  const transactionRoot = await mkdtemp(join(tmpdir(), "dezin-artifact-attempt-"));
  const worktreeDir = join(transactionRoot, "worktree");
  const hooksDir = join(transactionRoot, "empty-hooks");
  const gitDir = join(worktreeDir, ".git");
  let disposed = false;
  let durableHead: string | null = null;
  let durableTree = attempt.sourceTreeHash;
  let lastCandidate: ArtifactCandidateResult | null = null;
  let lastMessage: string | null = null;

  const isolated: IsolatedGit = {
    gitDir,
    realGitDir: gitDir,
    hooksDir,
    objectEnvironment: { GIT_OBJECT_DIRECTORY: repository.objectDir },
  };

  try {
    await mkdir(worktreeDir, { recursive: true });
    await mkdir(hooksDir, { recursive: true, mode: 0o700 });
    await gitVoid(transactionRoot, [
      "init", "-q", `--object-format=${repository.objectFormat}`, "--initial-branch=dezin-isolated", worktreeDir,
    ], { signal: input.signal, hooksPath: hooksDir });
    isolated.realGitDir = await realpath(gitDir);
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(join(gitDir, "objects", "info", "alternates"), `${repository.objectDir}\n`, { mode: 0o600 });
    await materializeTree(repository, attempt.sourceTreeHash, worktreeDir, input.signal);
    await pointIsolatedHead(isolated, worktreeDir, attempt.sourceCommitHash, attempt.sourceTreeHash, input.signal);
    const reproducedTree = await buildWorktreeTree(repository, isolated, worktreeDir, input.signal);
    if (reproducedTree !== attempt.sourceTreeHash) {
      throw new ArtifactCandidateValidationError("isolated Artifact worktree did not reproduce the exact Attempt tree");
    }
  } catch (error) {
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const ensureOpen = (): void => {
    if (disposed) throw new ArtifactCandidateValidationError("Artifact candidate transaction is already disposed");
  };

  const commitCandidate = async (commitInput: CommitArtifactCandidateInput): Promise<ArtifactCandidateResult> => {
    ensureOpen();
    const signal = combinedSignal(input.signal, commitInput.signal);
    checkAbort(signal);
    const message = canonicalCommitMessage(commitInput.message);
    const treeHash = await buildWorktreeTree(repository, isolated, worktreeDir, signal);
    if (lastCandidate !== null && lastCandidate.treeHash === treeHash && lastMessage === message) {
      await advanceRef(repository, attemptRef, lastCandidate.commitHash, durableHead, signal);
      durableHead = lastCandidate.commitHash;
      await pointIsolatedHead(
        isolated,
        worktreeDir,
        lastCandidate.commitHash,
        lastCandidate.treeHash,
        signal,
      );
      await Promise.resolve().then(() => deps.checkpoint?.("after-attempt-ref"));
      return { ...lastCandidate };
    }
    if (treeHash === durableTree) {
      throw new ArtifactCandidateValidationError("Artifact candidate has no project changes to commit");
    }
    const parentCommitHash = durableHead ?? attempt.sourceCommitHash;
    const commitHash = await writeCandidateCommit(
      repository,
      isolated,
      worktreeDir,
      attempt,
      parentCommitHash,
      treeHash,
      message,
      signal,
    );
    await verifyObjectInRepository(repository, commitHash, treeHash, signal);
    await advanceRef(repository, attemptRef, commitHash, durableHead, signal);
    durableHead = commitHash;
    durableTree = treeHash;
    lastCandidate = { commitHash, treeHash, attemptRef };
    lastMessage = message;
    await pointIsolatedHead(isolated, worktreeDir, commitHash, treeHash, signal);
    await Promise.resolve().then(() => deps.checkpoint?.("after-attempt-ref"));
    return { ...lastCandidate };
  };

  return {
    dir: worktreeDir,
    worktreeDir,
    attemptRef,
    async fingerprint(signal: AbortSignal): Promise<string> {
      ensureOpen();
      return buildWorktreeTree(repository, isolated, worktreeDir, combinedSignal(input.signal, signal));
    },
    async commit(message: string, signal: AbortSignal): Promise<ArtifactCandidateResult> {
      return commitCandidate({ message, signal });
    },
    commitCandidate,
    async restore(candidateInput: ArtifactCandidateIdentity, restoreSignal: AbortSignal): Promise<void> {
      ensureOpen();
      const signal = combinedSignal(input.signal, restoreSignal);
      const candidate = await verifyObjectInRepository(
        repository,
        candidateInput.commitHash,
        candidateInput.treeHash,
        signal,
      );
      if (durableHead === null) {
        throw new ArtifactCandidateValidationError("cannot restore before an Artifact candidate is durably retained");
      }
      if (!await exactLinearAncestor(repository, candidate.commitHash, durableHead, signal)) {
        throw new ArtifactCandidateValidationError("restore target is not retained by the current Attempt candidate lineage");
      }
      await materializeTree(repository, candidate.treeHash, worktreeDir, signal);
      lastCandidate = null;
      lastMessage = null;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await rm(transactionRoot, { recursive: true, force: true });
    },
  };
}

function candidateForLifecycle(
  repository: ResolvedRepository,
  attempt: ArtifactCandidateAttempt,
  candidateInput: ArtifactCandidateIdentity & { attemptRef?: string },
): ArtifactCandidateResult {
  const attemptRef = artifactCandidateAttemptRef(attempt);
  if (candidateInput.attemptRef !== undefined && candidateInput.attemptRef !== attemptRef) {
    throw new ArtifactCandidateValidationError("Artifact candidate Attempt ref does not match its immutable Attempt");
  }
  return {
    commitHash: canonicalObjectId(candidateInput.commitHash, "Artifact candidate commit hash", repository.objectIdLength),
    treeHash: canonicalObjectId(candidateInput.treeHash, "Artifact candidate tree hash", repository.objectIdLength),
    attemptRef,
  };
}

async function assertAttemptHeadRetainsCandidate(
  repository: ResolvedRepository,
  attemptRef: string,
  attemptHead: string,
  candidateCommitHash: string,
  signal?: AbortSignal,
): Promise<void> {
  canonicalObjectId(attemptHead, "durable Artifact Attempt head", repository.objectIdLength);
  if (await exactLinearAncestor(repository, candidateCommitHash, attemptHead, signal)) return;
  throw new ArtifactCandidateRefConflictError(
    attemptRef,
    "durable Artifact Attempt head is not a descendant of the selected candidate",
  );
}

async function exactLinearAncestor(
  repository: ResolvedRepository,
  ancestorCommitHash: string,
  descendantCommitHash: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const ancestor = canonicalObjectId(
    ancestorCommitHash,
    "Artifact candidate lineage ancestor",
    repository.objectIdLength,
  );
  let current = canonicalObjectId(
    descendantCommitHash,
    "Artifact candidate lineage descendant",
    repository.objectIdLength,
  );
  const visited = new Set<string>();
  for (let depth = 0; depth <= 256; depth += 1) {
    checkAbort(signal);
    if (current === ancestor) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    // Candidate commits are deliberately one-parent commits. A merge, graft-only
    // relationship, cycle, or overly deep chain is outside the Attempt lineage.
    const parent = await exactCandidateParent(repository, current, signal);
    if (parent === null) return false;
    current = parent;
  }
  return false;
}

async function exactCandidateParent(
  repository: ResolvedRepository,
  commitHash: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const rawCommit = await gitBuffer(repository.root, ["cat-file", "commit", commitHash], { signal });
  const headerEnd = rawCommit.indexOf(Buffer.from("\n\n"));
  const header = rawCommit.subarray(0, headerEnd < 0 ? rawCommit.length : headerEnd).toString("ascii");
  const parents = header.split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length));
  if (parents.length !== 1) return null;
  return canonicalObjectId(
    parents[0],
    "Artifact candidate lineage parent",
    repository.objectIdLength,
  );
}

async function verifyArtifactCandidateVersionHistory(
  repository: ResolvedRepository,
  attempt: ArtifactCandidateAttempt,
  candidate: ArtifactCandidateResult,
  historyInput: readonly ArtifactCandidateIdentity[],
  historyHead: ArtifactCandidateIdentity,
  signal?: AbortSignal,
): Promise<ArtifactCandidateIdentity[]> {
  if (!Array.isArray(historyInput) || historyInput.length < 1 || historyInput.length > 256) {
    throw new ArtifactCandidateValidationError("Artifact candidate version history is invalid");
  }
  const history: ArtifactCandidateIdentity[] = [];
  for (let index = 0; index < historyInput.length; index += 1) {
    checkAbort(signal);
    const version = await verifyObjectInRepository(
      repository,
      historyInput[index]?.commitHash,
      historyInput[index]?.treeHash,
      signal,
    );
    const expectedParent = index === 0
      ? attempt.sourceCommitHash
      : history[index - 1]!.commitHash;
    if (await exactCandidateParent(repository, version.commitHash, signal) !== expectedParent) {
      throw new ArtifactCandidateValidationError(
        "Artifact candidate version history is not the exact linear Attempt lineage",
      );
    }
    history.push(version);
  }
  const last = history.at(-1)!;
  if (last.commitHash !== historyHead.commitHash || last.treeHash !== historyHead.treeHash
    || !history.some((version) => (
      version.commitHash === candidate.commitHash && version.treeHash === candidate.treeHash
    ))) {
    throw new ArtifactCandidateValidationError(
      "Artifact candidate version history does not contain the exact selected Revision and head",
    );
  }
  return history;
}

async function assertCandidateFollowsAttemptBase(
  repository: ResolvedRepository,
  attempt: ArtifactCandidateAttempt,
  candidateCommitHash: string,
  signal?: AbortSignal,
): Promise<void> {
  if (candidateCommitHash === attempt.sourceCommitHash) {
    throw new ArtifactCandidateValidationError("selected Artifact commit is outside the generated candidate lineage");
  }
  if (await exactLinearAncestor(repository, attempt.sourceCommitHash, candidateCommitHash, signal)) return;
  throw new ArtifactCandidateValidationError("selected Artifact commit is outside the generated candidate lineage");
}

export async function promoteArtifactCandidateRef(
  input: ArtifactCandidateLifecycleInput,
): Promise<string> {
  const repository = await resolveRepository(input.repositoryDir, input.signal);
  const attempt = canonicalAttempt(input.attempt, repository.objectIdLength);
  const candidate = candidateForLifecycle(repository, attempt, input.candidate);
  const historyHead = await verifyObjectInRepository(
    repository,
    input.historyHead?.commitHash,
    input.historyHead?.treeHash,
    input.signal,
  );
  await verifyObjectInRepository(repository, candidate.commitHash, candidate.treeHash, input.signal);
  await assertCandidateFollowsAttemptBase(repository, attempt, candidate.commitHash, input.signal);
  await verifyArtifactCandidateVersionHistory(
    repository,
    attempt,
    candidate,
    input.history,
    historyHead,
    input.signal,
  );
  await assertAttemptHeadRetainsCandidate(
    repository,
    candidate.attemptRef,
    historyHead.commitHash,
    candidate.commitHash,
    input.signal,
  );
  const revisionRef = artifactRevisionRef(input.revisionId);
  const historyRef = artifactRevisionHistoryRef(input.revisionId);
  for (let retry = 0; retry < 4; retry += 1) {
    const [attemptHead, existingRevision, existingHistory] = await Promise.all([
      readRef(repository, candidate.attemptRef, input.signal),
      readRef(repository, revisionRef, input.signal),
      readRef(repository, historyRef, input.signal),
    ]);
    if (existingRevision !== null && existingRevision !== candidate.commitHash) {
      throw new ArtifactCandidateRefConflictError(revisionRef);
    }
    if (existingHistory !== null && existingHistory !== historyHead.commitHash) {
      throw new ArtifactCandidateRefConflictError(historyRef);
    }
    if ((existingRevision === null) !== (existingHistory === null)) {
      throw new ArtifactCandidateRefConflictError(
        existingRevision === null ? revisionRef : historyRef,
        "durable Artifact Revision retention pair is partial",
      );
    }
    // A fully completed promote + release is still an idempotent promote replay.
    if (attemptHead === null) {
      if (existingRevision === candidate.commitHash && existingHistory === historyHead.commitHash) {
        await verifyObjectInRepository(repository, candidate.commitHash, candidate.treeHash, input.signal);
        await verifyObjectInRepository(repository, historyHead.commitHash, historyHead.treeHash, input.signal);
        return revisionRef;
      }
      throw new ArtifactCandidateRefConflictError(
        candidate.attemptRef,
        "durable Artifact Attempt ref does not retain the selected candidate",
      );
    }
    await assertAttemptHeadRetainsCandidate(
      repository,
      candidate.attemptRef,
      attemptHead,
      candidate.commitHash,
      input.signal,
    );
    if (attemptHead !== historyHead.commitHash) {
      throw new ArtifactCandidateRefConflictError(
        candidate.attemptRef,
        "durable Artifact Attempt head does not exactly match the retained version history",
      );
    }
    const transaction = existingRevision === null
      ? [
        "start",
        `verify ${candidate.attemptRef} ${attemptHead}`,
        `create ${revisionRef} ${candidate.commitHash}`,
        `create ${historyRef} ${historyHead.commitHash}`,
        "prepare",
        "commit",
        "",
      ].join("\n")
      : [
        "start",
        `verify ${candidate.attemptRef} ${attemptHead}`,
        `verify ${revisionRef} ${candidate.commitHash}`,
        `verify ${historyRef} ${historyHead.commitHash}`,
        "prepare",
        "commit",
        "",
      ].join("\n");
    const promotion = await captureGit(repository.root, ["update-ref", "--stdin"], {
      signal: input.signal,
      input: transaction,
    });
    if (promotion.code === 0) {
      await verifyObjectInRepository(repository, candidate.commitHash, candidate.treeHash, input.signal);
      await verifyObjectInRepository(repository, historyHead.commitHash, historyHead.treeHash, input.signal);
      return revisionRef;
    }
    checkAbort(input.signal);
    const [promoted, retainedHistory, currentAttempt] = await Promise.all([
      readRef(repository, revisionRef, input.signal),
      readRef(repository, historyRef, input.signal),
      readRef(repository, candidate.attemptRef, input.signal),
    ]);
    if (promoted === candidate.commitHash
      && retainedHistory === historyHead.commitHash
      && (currentAttempt === null || currentAttempt === historyHead.commitHash)) {
      await verifyObjectInRepository(repository, candidate.commitHash, candidate.treeHash, input.signal);
      await verifyObjectInRepository(repository, historyHead.commitHash, historyHead.treeHash, input.signal);
      return revisionRef;
    }
    if (promoted !== null) throw new ArtifactCandidateRefConflictError(revisionRef);
    if (retainedHistory !== null) throw new ArtifactCandidateRefConflictError(historyRef);
    if (currentAttempt !== null && currentAttempt !== historyHead.commitHash) {
      throw new ArtifactCandidateRefConflictError(candidate.attemptRef);
    }
  }
  throw new ArtifactCandidateRefConflictError(
    candidate.attemptRef,
    "durable Artifact Attempt head kept changing during candidate promotion",
  );
}

export async function releaseArtifactCandidateAttemptRef(
  input: ArtifactCandidateLifecycleInput,
): Promise<boolean> {
  const repository = await resolveRepository(input.repositoryDir, input.signal);
  const attempt = canonicalAttempt(input.attempt, repository.objectIdLength);
  const candidate = candidateForLifecycle(repository, attempt, input.candidate);
  const revisionRef = artifactRevisionRef(input.revisionId);
  const historyRef = artifactRevisionHistoryRef(input.revisionId);
  const historyHead = await verifyObjectInRepository(
    repository,
    input.historyHead?.commitHash,
    input.historyHead?.treeHash,
    input.signal,
  );
  await verifyObjectInRepository(repository, candidate.commitHash, candidate.treeHash, input.signal);
  await assertCandidateFollowsAttemptBase(repository, attempt, candidate.commitHash, input.signal);
  await verifyArtifactCandidateVersionHistory(
    repository,
    attempt,
    candidate,
    input.history,
    historyHead,
    input.signal,
  );
  await assertAttemptHeadRetainsCandidate(
    repository,
    candidate.attemptRef,
    historyHead.commitHash,
    candidate.commitHash,
    input.signal,
  );
  const [retainedRevision, retainedHistory] = await Promise.all([
    readRef(repository, revisionRef, input.signal),
    readRef(repository, historyRef, input.signal),
  ]);
  if (retainedRevision !== candidate.commitHash) {
    throw new ArtifactCandidateRevisionRefNotRetainedError(revisionRef, retainedRevision);
  }
  if (retainedHistory !== historyHead.commitHash) {
    throw new ArtifactCandidateRevisionRefNotRetainedError(historyRef, retainedHistory);
  }
  for (let retry = 0; retry < 4; retry += 1) {
    const attemptHead = await readRef(repository, candidate.attemptRef, input.signal);
    if (attemptHead === null) return false;
    await assertAttemptHeadRetainsCandidate(
      repository,
      candidate.attemptRef,
      attemptHead,
      candidate.commitHash,
      input.signal,
    );
    if (attemptHead !== historyHead.commitHash) {
      throw new ArtifactCandidateRefConflictError(
        candidate.attemptRef,
        "durable Artifact Attempt head does not exactly match the retained version history",
      );
    }
    const transaction = [
      "start",
      `verify ${revisionRef} ${candidate.commitHash}`,
      `verify ${historyRef} ${historyHead.commitHash}`,
      `delete ${candidate.attemptRef} ${attemptHead}`,
      "prepare",
      "commit",
      "",
    ].join("\n");
    const result = await captureGit(repository.root, ["update-ref", "--stdin"], {
      signal: input.signal,
      input: transaction,
    });
    if (result.code === 0) {
      const [currentRevision, currentHistory] = await Promise.all([
        readRef(repository, revisionRef, input.signal),
        readRef(repository, historyRef, input.signal),
      ]);
      if (currentRevision !== candidate.commitHash) {
        throw new ArtifactCandidateRevisionRefNotRetainedError(revisionRef, currentRevision);
      }
      if (currentHistory !== historyHead.commitHash) {
        throw new ArtifactCandidateRevisionRefNotRetainedError(historyRef, currentHistory);
      }
      await verifyObjectInRepository(repository, candidate.commitHash, candidate.treeHash, input.signal);
      await verifyObjectInRepository(repository, historyHead.commitHash, historyHead.treeHash, input.signal);
      return true;
    }
    checkAbort(input.signal);
    const [currentRevision, currentHistory] = await Promise.all([
      readRef(repository, revisionRef, input.signal),
      readRef(repository, historyRef, input.signal),
    ]);
    if (currentRevision !== candidate.commitHash) {
      throw new ArtifactCandidateRevisionRefNotRetainedError(revisionRef, currentRevision);
    }
    if (currentHistory !== historyHead.commitHash) {
      throw new ArtifactCandidateRevisionRefNotRetainedError(historyRef, currentHistory);
    }
    if (await readRef(repository, candidate.attemptRef, input.signal) === null) return false;
  }
  throw new ArtifactCandidateRefConflictError(
    candidate.attemptRef,
    "durable Artifact Attempt head kept changing during ref release",
  );
}

/**
 * Deletes only the canonical ref for one exact immutable terminal Attempt.
 * The caller must obtain the terminal/no-candidate proof from Core; Git then
 * revalidates that every observed head is generated from the frozen source base
 * and compare-deletes that exact head in one ref transaction.
 */
export async function releaseOrphanArtifactCandidateAttemptRef(
  input: ReleaseOrphanArtifactCandidateAttemptRefInput,
): Promise<boolean> {
  const repository = await resolveRepository(input.repositoryDir, input.signal);
  const attempt = await verifyAttemptBase(repository, input.attempt, input.signal);
  const attemptRef = artifactCandidateAttemptRef(attempt);
  for (let retry = 0; retry < 4; retry += 1) {
    checkAbort(input.signal);
    const attemptHead = await readRef(repository, attemptRef, input.signal);
    if (attemptHead === null) return false;
    await assertCandidateFollowsAttemptBase(repository, attempt, attemptHead, input.signal);
    const transaction = [
      "start",
      `delete ${attemptRef} ${attemptHead}`,
      "prepare",
      "commit",
      "",
    ].join("\n");
    const result = await captureGit(repository.root, ["update-ref", "--stdin"], {
      signal: input.signal,
      input: transaction,
    });
    if (result.code === 0) return true;
    checkAbort(input.signal);
    if (await readRef(repository, attemptRef, input.signal) === null) return false;
  }
  throw new ArtifactCandidateRefConflictError(
    attemptRef,
    "durable orphan Artifact Attempt head kept changing during ref release",
  );
}
