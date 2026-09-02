import assert from "node:assert/strict";
import { execFile as execFileCallback, fork, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  deleteLocalFigmaCredential,
  getFigmaCredentialStatus,
  putLocalFigmaCredential,
  resolveFigmaCredential,
} from "../src/design/figma-credential-store.ts";

const execFile = promisify(execFileCallback);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function waitForWorkerMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (message === null || typeof message !== "object" || Array.isArray(message)
        || (message as Record<string, unknown>).type !== type) return;
      cleanup();
      resolve(message as Record<string, unknown>);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`credential worker exited before ${type}: ${code ?? signal ?? "unknown"}`));
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function pausedCredentialWorker(
  dataDir: string,
  token: string,
  env: Readonly<Record<string, string>> = {},
): ChildProcess {
  return fork(join(import.meta.dirname, "support", "figma-credential-worker.ts"), [dataDir, token, "pause"], {
    cwd: join(import.meta.dirname, "../../.."),
    execArgv: ["--experimental-strip-types", "--no-warnings"],
    env: { ...process.env, ...env },
    silent: true,
  });
}

test("local Figma PAT storage is private, atomic, non-echoing, and deletable", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-secret-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const token = "figd_private_token_0123456789";

  assert.deepEqual(await getFigmaCredentialStatus({ dataDir, env: {} }), { configured: false, source: null });
  assert.deepEqual(await putLocalFigmaCredential({ dataDir, token, env: {} }), { configured: true, source: "local" });
  assert.equal((await stat(join(dataDir, "secrets"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(dataDir, "secrets", "figma-pat.json"))).mode & 0o777, 0o600);
  const credential = await resolveFigmaCredential({ dataDir, env: {} });
  assert.equal(credential?.token, token);
  assert.match(credential?.subject ?? "", /^pat-[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(await getFigmaCredentialStatus({ dataDir, env: {} })).includes(token), false);

  assert.deepEqual(await deleteLocalFigmaCredential({ dataDir, env: {} }), { configured: false, source: null });
  await assert.rejects(lstat(join(dataDir, "secrets", "figma-pat.json")), { code: "ENOENT" });
});

test("FIGMA_ACCESS_TOKEN takes precedence without writing the environment secret", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-env-secret-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await putLocalFigmaCredential({ dataDir, token: "figd_local_token_0123456789", env: {} });
  const env = { FIGMA_ACCESS_TOKEN: "figd_environment_token_0123456789" };
  assert.deepEqual(await getFigmaCredentialStatus({ dataDir, env }), { configured: true, source: "environment" });
  assert.equal((await resolveFigmaCredential({ dataDir, env }))?.token, env.FIGMA_ACCESS_TOKEN);
  await deleteLocalFigmaCredential({ dataDir, env });
  assert.deepEqual(await getFigmaCredentialStatus({ dataDir, env }), { configured: true, source: "environment" });
});

test("Figma credential storage fails closed on corrupt or symlinked secret authority", async (t) => {
  const corruptDir = await mkdtemp(join(tmpdir(), "dezin-figma-corrupt-secret-"));
  t.after(() => rm(corruptDir, { recursive: true, force: true }));
  await mkdir(join(corruptDir, "secrets"), { mode: 0o700 });
  await writeFile(join(corruptDir, "secrets", "figma-pat.json"), "{broken", { mode: 0o600 });
  await assert.rejects(resolveFigmaCredential({ dataDir: corruptDir, env: {} }), /corrupt/);

  const linkedDir = await mkdtemp(join(tmpdir(), "dezin-figma-linked-secret-"));
  t.after(() => rm(linkedDir, { recursive: true, force: true }));
  const target = join(linkedDir, "target.json");
  await writeFile(target, JSON.stringify({ schemaVersion: 1, token: "figd_linked_token_0123456789" }), { mode: 0o600 });
  await mkdir(join(linkedDir, "secrets"), { mode: 0o700 });
  await symlink(target, join(linkedDir, "secrets", "figma-pat.json"));
  await assert.rejects(resolveFigmaCredential({ dataDir: linkedDir, env: {} }), /symlink|regular file/);
  await assert.rejects(putLocalFigmaCredential({ dataDir: linkedDir, token: "figd_replacement_0123456789", env: {} }), /symlink|regular file/);
  assert.equal(await readFile(target, "utf8"), JSON.stringify({ schemaVersion: 1, token: "figd_linked_token_0123456789" }));
});

test("Figma credential reads are exact-size and reject an in-place grow after fd stat", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-growing-secret-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await putLocalFigmaCredential({ dataDir, token: "figd_local_token_0123456789", env: {} });
  let changed = false;
  await assert.rejects(resolveFigmaCredential({
    dataDir,
    env: {},
    testHooks: {
      afterCredentialStat: async (path) => {
        changed = true;
        const current = await readFile(path);
        await writeFile(path, Buffer.concat([current, Buffer.from(" ")]), { mode: 0o600 });
      },
    },
  }), /changed while being read/);
  assert.equal(changed, true);
});

test("Figma PAT validation rejects JSON-escape characters that could bypass persisted secret canaries", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-secret-chars-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  for (const token of ["figd_bad_quote_123456\"", "figd_bad_slash_123456\\"] ) {
    await assert.rejects(putLocalFigmaCredential({ dataDir, token, env: {} }), /invalid/);
  }
});

test("credential authority root creation fsyncs its parent before PUT returns", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-secret-fsync-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const synced: string[] = [];
  await putLocalFigmaCredential({
    dataDir,
    token: "figd_private_token_0123456789",
    env: {},
    testHooks: { afterDirectorySync: (path) => { synced.push(path); } },
  });
  assert.deepEqual(synced.slice(0, 2), [dataDir, join(dataDir, "secrets")]);
});

test("a real crash after PAT pending fsync is cleaned by restart status and Forget", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-secret-crash-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const token = "figd_private_token_0123456789";
  const worker = join(import.meta.dirname, "support", "figma-credential-worker.ts");
  await assert.rejects(execFile(process.execPath, [
    "--experimental-strip-types", "--no-warnings", worker, dataDir, token,
  ], { cwd: join(import.meta.dirname, "../../..") }), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === 93);
  assert.deepEqual(await getFigmaCredentialStatus({ dataDir, env: {} }), { configured: false, source: null });
  assert.deepEqual(await deleteLocalFigmaCredential({ dataDir, env: {} }), { configured: false, source: null });
  const entries = await readdir(join(dataDir, "secrets"));
  assert.equal(entries.some((entry) => /^\.figma-pat\..+\.tmp$/.test(entry)), false);
  const contents = await Promise.all(entries.map((entry) => readFile(join(dataDir, "secrets", entry), "utf8").catch(() => "")));
  assert.equal(contents.join("\n").includes(token), false);
  assert.equal(contents.join("\n").includes(Buffer.from(token).toString("base64")), false);
});

test("credential status waits for an in-flight local PUT instead of deleting its live pending file", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-secret-put-status-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const pendingSynced = deferred();
  const releasePut = deferred();
  let putReleased = false;
  const put = putLocalFigmaCredential({
    dataDir,
    token: "figd_concurrent_status_0123456789",
    env: {},
    testHooks: {
      afterCredentialPendingSync: async () => {
        pendingSynced.resolve();
        await releasePut.promise;
      },
    },
  });
  await pendingSynced.promise;

  const status = getFigmaCredentialStatus({ dataDir, env: {} }).then((value) => ({
    value,
    completedBeforePut: !putReleased,
  }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  putReleased = true;
  releasePut.resolve();

  assert.deepEqual(await put, { configured: true, source: "local" });
  assert.deepEqual(await status, {
    value: { configured: true, source: "local" },
    completedBeforePut: false,
  });
});

test("credential Forget queues behind an in-flight local PUT and deletes the published credential", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-secret-put-delete-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const pendingSynced = deferred();
  const releasePut = deferred();
  let putReleased = false;
  const put = putLocalFigmaCredential({
    dataDir,
    token: "figd_concurrent_delete_0123456789",
    env: {},
    testHooks: {
      afterCredentialPendingSync: async () => {
        pendingSynced.resolve();
        await releasePut.promise;
      },
    },
  });
  await pendingSynced.promise;

  const forgotten = deleteLocalFigmaCredential({ dataDir, env: {} }).then((value) => ({
    value,
    completedBeforePut: !putReleased,
  }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  putReleased = true;
  releasePut.resolve();

  assert.deepEqual(await put, { configured: true, source: "local" });
  assert.deepEqual(await forgotten, {
    value: { configured: false, source: null },
    completedBeforePut: false,
  });
  assert.deepEqual(await getFigmaCredentialStatus({ dataDir, env: {} }), { configured: false, source: null });
});

test("a live child PUT survives concurrent credential status cleanup across different TZ and locale environments", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-secret-child-status-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const child = pausedCredentialWorker(dataDir, "figd_child_status_0123456789", {
    TZ: "Pacific/Honolulu",
    LC_ALL: "C",
    LANG: "C",
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await waitForWorkerMessage(child, "pending");

  const during = await getFigmaCredentialStatus({ dataDir, env: {} });
  const pendingDuring = (await readdir(join(dataDir, "secrets"))).filter((entry) => entry.endsWith(".tmp"));
  const result = waitForWorkerMessage(child, "result");
  child.send("release");
  const workerOutcome = await result.then(
    (message) => ({ ok: true as const, message }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  assert.deepEqual(during, { configured: false, source: null });
  assert.equal(pendingDuring.length, 1);
  if (!workerOutcome.ok) assert.fail(String(workerOutcome.error));
  assert.deepEqual(workerOutcome.message.status, { configured: true, source: "local" });
  assert.deepEqual(await getFigmaCredentialStatus({ dataDir, env: {} }), { configured: true, source: "local" });
});

test("a live child PUT survives concurrent Forget as the later overlapping write", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-secret-child-delete-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const child = pausedCredentialWorker(dataDir, "figd_child_delete_0123456789");
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await waitForWorkerMessage(child, "pending");

  const forgotten = await deleteLocalFigmaCredential({ dataDir, env: {} });
  const pendingDuring = (await readdir(join(dataDir, "secrets"))).filter((entry) => entry.endsWith(".tmp"));
  const result = waitForWorkerMessage(child, "result");
  child.send("release");
  const workerOutcome = await result.then(
    (message) => ({ ok: true as const, message }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  assert.deepEqual(forgotten, { configured: false, source: null });
  assert.equal(pendingDuring.length, 1);
  if (!workerOutcome.ok) assert.fail(String(workerOutcome.error));
  assert.deepEqual(workerOutcome.message.status, { configured: true, source: "local" });
  assert.deepEqual(await getFigmaCredentialStatus({ dataDir, env: {} }), { configured: true, source: "local" });
});

test("credential temp cleanup uses stable owner identity and a bounded malformed grace", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-secret-owner-identity-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const root = join(dataDir, "secrets");
  await mkdir(root, { mode: 0o700 });

  const malformed = join(root, ".figma-pat.json.malformed.tmp");
  await writeFile(malformed, "figd_malformed_temp_0123456789", { mode: 0o600 });
  assert.deepEqual(await getFigmaCredentialStatus({ dataDir, env: {} }), { configured: false, source: null });
  assert.equal((await lstat(malformed)).isFile(), true);
  const stale = new Date(Date.now() - 5_000);
  await utimes(malformed, stale, stale);
  assert.deepEqual(await getFigmaCredentialStatus({ dataDir, env: {} }), { configured: false, source: null });
  await assert.rejects(lstat(malformed), { code: "ENOENT" });

  const reusedPid = join(
    root,
    `.figma-pat.json.p${process.pid}.s${"0".repeat(32)}.00000000-0000-4000-8000-000000000000.tmp`,
  );
  await writeFile(reusedPid, "figd_reused_pid_temp_0123456789", { mode: 0o600 });
  assert.deepEqual(await getFigmaCredentialStatus({ dataDir, env: {} }), { configured: false, source: null });
  await assert.rejects(lstat(reusedPid), { code: "ENOENT" });
});

test("a configured SecretCipher seals the stored PAT; a daemon without the key sees no credential", async (t) => {
  const { createSecretCipher } = await import("@dezin/core");
  const { randomBytes } = await import("node:crypto");
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-sealed-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const token = "figd_sealed_token_0123456789";
  const secretCipher = createSecretCipher(randomBytes(32));

  assert.deepEqual(await putLocalFigmaCredential({ dataDir, token, env: {}, secretCipher }), { configured: true, source: "local" });
  const onDisk = JSON.parse(await readFile(join(dataDir, "secrets", "figma-pat.json"), "utf8")) as { token: string };
  assert.notEqual(onDisk.token, token);
  assert.match(onDisk.token, /^enc:v1:/);
  assert.equal((await resolveFigmaCredential({ dataDir, env: {}, secretCipher }))?.token, token);

  // No key, or the wrong key: the sealed file is left alone and reads as not configured.
  assert.equal(await resolveFigmaCredential({ dataDir, env: {} }), null);
  assert.equal(await resolveFigmaCredential({ dataDir, env: {}, secretCipher: createSecretCipher(randomBytes(32)) }), null);
  assert.deepEqual(await getFigmaCredentialStatus({ dataDir, env: {} }), { configured: false, source: null });
  assert.match(JSON.parse(await readFile(join(dataDir, "secrets", "figma-pat.json"), "utf8")).token, /^enc:v1:/);

  // Plain-text files written before the key existed keep working.
  await deleteLocalFigmaCredential({ dataDir, env: {}, secretCipher });
  await putLocalFigmaCredential({ dataDir, token, env: {} });
  assert.equal((await resolveFigmaCredential({ dataDir, env: {}, secretCipher }))?.token, token);
});
