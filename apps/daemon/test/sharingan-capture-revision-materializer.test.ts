import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type {
  ImmutableSharinganCaptureReference,
  SharinganCaptureBundleFence,
  SharinganCaptureRevisionMaterializerPort,
} from "../src/orchestration/sharingan-capture-reference.ts";

const REFERENCE: ImmutableSharinganCaptureReference = Object.freeze({
  workspaceId: "workspace-1",
  contextPackId: `context-pack-${"c".repeat(64)}`,
  contextPackHash: "c".repeat(64),
  resourceId: "capture-1",
  revisionId: "capture-revision-1",
  revisionChecksum: "e".repeat(64),
});

interface MaterializationReceipt extends ImmutableSharinganCaptureReference {
  protocol: "dezin.sharingan-capture-materialization.v2";
  files: readonly {
    path: string;
    mode: 0o444;
    byteLength: number;
    checksum: string;
  }[];
}

interface MaterializerModule {
  ProductionSharinganCaptureRevisionMaterializer: new (options: {
    source: {
      materializeExactRevision(input: {
        reference: ImmutableSharinganCaptureReference;
        destinationDir: string;
        signal: AbortSignal;
      }): Promise<MaterializationReceipt>;
    };
  }) => SharinganCaptureRevisionMaterializerPort;
  ProductionSharinganCaptureRevisionMaterializerError: new (...args: never[]) => Error;
}

async function materializerModule(): Promise<Partial<MaterializerModule>> {
  return import("../src/orchestration/sharingan-capture-revision-materializer.ts")
    .catch(() => ({})) as Promise<Partial<MaterializerModule>>;
}

function receipt(overrides: Partial<MaterializationReceipt> = {}): MaterializationReceipt {
  const contents = new Map([
    [".sharingan/pages.json", JSON.stringify({ schemaVersion: 2, revisionId: REFERENCE.revisionId, pages: [{ id: "entry" }] })],
    [".sharingan/probe.mjs", "export const immutableProbe = true;\n"],
    ["public/_assets/source.png", "exact source asset\n"],
  ]);
  return {
    protocol: "dezin.sharingan-capture-materialization.v2",
    ...REFERENCE,
    files: Object.freeze([...contents.entries()].map(([path, content]) => Object.freeze({
      path,
      mode: 0o444 as const,
      byteLength: Buffer.byteLength(content),
      checksum: createHash("sha256").update(content).digest("hex"),
    }))),
    ...overrides,
  };
}

async function writeCompleteBundle(destinationDir: string, marker = REFERENCE.revisionId): Promise<void> {
  await mkdir(join(destinationDir, ".sharingan"), { recursive: true });
  await mkdir(join(destinationDir, "public", "_assets"), { recursive: true });
  await writeFile(
    join(destinationDir, ".sharingan", "pages.json"),
    JSON.stringify({ schemaVersion: 2, revisionId: marker, pages: [{ id: "entry" }] }),
    { mode: 0o444 },
  );
  await writeFile(
    join(destinationDir, ".sharingan", "probe.mjs"),
    "export const immutableProbe = true;\n",
    { mode: 0o444 },
  );
  await writeFile(
    join(destinationDir, "public", "_assets", "source.png"),
    "exact source asset\n",
    { mode: 0o444 },
  );
}

test("production Sharingan materializer stages an exact Revision bundle and returns a live fingerprint fence", async (t) => {
  const module = await materializerModule();
  assert.equal(typeof module.ProductionSharinganCaptureRevisionMaterializer, "function");
  if (typeof module.ProductionSharinganCaptureRevisionMaterializer !== "function") return;
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-sharingan-materializer-worktree-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  await mkdir(join(worktreeDir, "public"));
  await writeFile(join(worktreeDir, "public", "candidate-owned.txt"), "candidate public content\n");
  const destinations: string[] = [];
  const materializer = new module.ProductionSharinganCaptureRevisionMaterializer({
    source: {
      async materializeExactRevision(input) {
        destinations.push(input.destinationDir);
        assert.deepEqual(input.reference, REFERENCE);
        await writeCompleteBundle(input.destinationDir);
        return receipt();
      },
    },
  });

  const fence = await materializer.materializeExactRevision({
    reference: REFERENCE,
    worktreeDir,
    signal: new AbortController().signal,
  }) as SharinganCaptureBundleFence;
  try {
    assert.equal(destinations.length, 1);
    assert.notEqual(destinations[0], join(worktreeDir, ".sharingan"));
    assert.match(await readFile(join(worktreeDir, ".sharingan", "pages.json"), "utf8"), /capture-revision-1/);
    assert.equal(await readFile(join(worktreeDir, "public", "_assets", "source.png"), "utf8"), "exact source asset\n");
    assert.equal(await readFile(join(worktreeDir, "public", "candidate-owned.txt"), "utf8"), "candidate public content\n");
    assert.deepEqual(fence.reference, REFERENCE);
    assert.match(fence.fingerprint, /^[a-f0-9]{64}$/);
    await fence.verify(new AbortController().signal);
  } finally {
    await fence.dispose();
  }
});

test("production Sharingan materializer rejects substituted receipts and removes only its own staged bytes", async (t) => {
  const module = await materializerModule();
  assert.equal(typeof module.ProductionSharinganCaptureRevisionMaterializer, "function");
  assert.equal(typeof module.ProductionSharinganCaptureRevisionMaterializerError, "function");
  if (typeof module.ProductionSharinganCaptureRevisionMaterializer !== "function") return;
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-sharingan-materializer-substitute-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  const materializer = new module.ProductionSharinganCaptureRevisionMaterializer({
    source: {
      async materializeExactRevision(input) {
        await writeCompleteBundle(input.destinationDir);
        return receipt({ revisionId: "substituted-revision" });
      },
    },
  });

  await assert.rejects(
    materializer.materializeExactRevision({
      reference: REFERENCE,
      worktreeDir,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof (
      module.ProductionSharinganCaptureRevisionMaterializerError as new (...args: never[]) => Error
    ) && (error as Error & { code?: string }).code === "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED"
      && (error as Error & { failureClass?: string }).failureClass === "context",
  );
  await assert.rejects(readFile(join(worktreeDir, ".sharingan", "pages.json")));
});

test("production Sharingan materializer rejects files injected outside the exact Revision manifest", async (t) => {
  const module = await materializerModule();
  const Materializer = module.ProductionSharinganCaptureRevisionMaterializer;
  assert.equal(typeof Materializer, "function");
  if (typeof Materializer !== "function") return;
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-sharingan-materializer-injected-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  const materializer = new Materializer({
    source: {
      async materializeExactRevision(input) {
        await writeCompleteBundle(input.destinationDir);
        await writeFile(join(input.destinationDir, ".sharingan", "injected.mjs"), "export default 'not revision owned';\n");
        return receipt();
      },
    },
  });

  await assert.rejects(
    materializer.materializeExactRevision({
      reference: REFERENCE,
      worktreeDir,
      signal: new AbortController().signal,
    }),
    (error: unknown) => (error as Error & { code?: string }).code === "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
  );
  await assert.rejects(readFile(join(worktreeDir, ".sharingan", "injected.mjs")));
  await assert.rejects(readFile(join(worktreeDir, "public", "_assets", "source.png")));
});

test("production Sharingan materializer never overwrites a preexisting worktree mount", async (t) => {
  const module = await materializerModule();
  assert.equal(typeof module.ProductionSharinganCaptureRevisionMaterializer, "function");
  if (typeof module.ProductionSharinganCaptureRevisionMaterializer !== "function") return;
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-sharingan-materializer-collision-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  await mkdir(join(worktreeDir, ".sharingan"));
  await writeFile(join(worktreeDir, ".sharingan", "owner.txt"), "preexisting\n");
  let sourceCalls = 0;
  const materializer = new module.ProductionSharinganCaptureRevisionMaterializer({
    source: {
      async materializeExactRevision() {
        sourceCalls += 1;
        return receipt();
      },
    },
  });

  await assert.rejects(
    materializer.materializeExactRevision({
      reference: REFERENCE,
      worktreeDir,
      signal: new AbortController().signal,
    }),
    (error: unknown) => (error as Error & { code?: string }).code === "SHARINGAN_CAPTURE_MOUNT_COLLISION",
  );
  assert.equal(sourceCalls, 0);
  assert.equal(await readFile(join(worktreeDir, ".sharingan", "owner.txt"), "utf8"), "preexisting\n");
});

test("production Sharingan materializer never overwrites preexisting public source assets", async (t) => {
  const module = await materializerModule();
  assert.equal(typeof module.ProductionSharinganCaptureRevisionMaterializer, "function");
  if (typeof module.ProductionSharinganCaptureRevisionMaterializer !== "function") return;
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-sharingan-materializer-assets-collision-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  await mkdir(join(worktreeDir, "public", "_assets"), { recursive: true });
  await writeFile(join(worktreeDir, "public", "_assets", "owner.txt"), "preexisting\n");
  let sourceCalls = 0;
  const materializer = new module.ProductionSharinganCaptureRevisionMaterializer({
    source: {
      async materializeExactRevision() {
        sourceCalls += 1;
        return receipt();
      },
    },
  });

  await assert.rejects(
    materializer.materializeExactRevision({
      reference: REFERENCE,
      worktreeDir,
      signal: new AbortController().signal,
    }),
    (error: unknown) => (error as Error & { code?: string }).code === "SHARINGAN_CAPTURE_MOUNT_COLLISION",
  );
  assert.equal(sourceCalls, 0);
  assert.equal(await readFile(join(worktreeDir, "public", "_assets", "owner.txt"), "utf8"), "preexisting\n");
});

test("production Sharingan materializer rejects missing, extra, linked, and non-regular staged entries without partial installs", async (t) => {
  const module = await materializerModule();
  const Materializer = module.ProductionSharinganCaptureRevisionMaterializer;
  if (typeof Materializer !== "function") return;
  const variants = ["missing-root", "extra-root", "checksum", "symlink", "depth", ...(process.platform === "win32" ? [] : ["fifo"])] as const;
  for (const variant of variants) {
    await t.test(variant, async () => {
      const root = await mkdtemp(join(tmpdir(), `dezin-sharingan-materializer-${variant}-`));
      const worktreeDir = join(root, "worktree");
      await mkdir(worktreeDir);
      const outside = join(root, "outside.txt");
      await writeFile(outside, "outside owner\n");
      const materializer = new Materializer({
        source: {
          async materializeExactRevision(input) {
            await writeCompleteBundle(input.destinationDir);
            if (variant === "missing-root") {
              await rm(join(input.destinationDir, "public"), { recursive: true, force: true });
            } else if (variant === "extra-root") {
              await writeFile(join(input.destinationDir, "extra.txt"), "extra\n");
            } else if (variant === "checksum") {
              const source = join(input.destinationDir, "public", "_assets", "source.png");
              await chmod(source, 0o644);
              await writeFile(source, "same path, substituted bytes\n");
              await chmod(source, 0o444);
            } else if (variant === "symlink") {
              await rm(join(input.destinationDir, "public", "_assets", "source.png"));
              await import("node:fs/promises").then(({ symlink }) => symlink(
                outside,
                join(input.destinationDir, "public", "_assets", "source.png"),
              ));
            } else if (variant === "depth") {
              let directory = join(input.destinationDir, ".sharingan");
              for (let index = 0; index < 65; index += 1) {
                directory = join(directory, `depth-${index}`);
                await mkdir(directory);
              }
            } else {
              await rm(join(input.destinationDir, "public", "_assets", "source.png"));
              const created = spawnSync("mkfifo", [join(input.destinationDir, "public", "_assets", "source.png")]);
              assert.equal(created.status, 0);
            }
            return receipt();
          },
        },
      });
      try {
        await assert.rejects(
          materializer.materializeExactRevision({
            reference: REFERENCE,
            worktreeDir,
            signal: new AbortController().signal,
          }),
          (error: unknown) => (error as Error & { code?: string }).code === "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        );
        await assert.rejects(lstat(join(worktreeDir, ".sharingan")));
        await assert.rejects(lstat(join(worktreeDir, "public", "_assets")));
        assert.equal(await readFile(outside, "utf8"), "outside owner\n");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("production Sharingan materializer removes its installed mount when staging cleanup fails", async (t) => {
  const module = await materializerModule();
  assert.equal(typeof module.ProductionSharinganCaptureRevisionMaterializer, "function");
  assert.equal(typeof module.ProductionSharinganCaptureRevisionMaterializerError, "function");
  if (typeof module.ProductionSharinganCaptureRevisionMaterializer !== "function") return;
  const testRoot = await mkdtemp(join(tmpdir(), "dezin-sharingan-materializer-cleanup-"));
  const worktreeDir = join(testRoot, "worktree");
  await mkdir(worktreeDir);
  let stagingRoot = "";
  t.after(async () => {
    if (stagingRoot !== "") await chmod(stagingRoot, 0o700).catch(() => {});
    await rm(testRoot, { recursive: true, force: true });
  });
  const materializer = new module.ProductionSharinganCaptureRevisionMaterializer({
    source: {
      async materializeExactRevision(input) {
        stagingRoot = dirname(input.destinationDir);
        await writeCompleteBundle(input.destinationDir);
        for (let index = 0; index < 128; index += 1) {
          await writeFile(join(input.destinationDir, ".sharingan", `capture-${index}.json`), `{ "index": ${index} }\n`);
        }
        await writeFile(join(stagingRoot, "undeletable.txt"), "owned staging residue\n");
        await chmod(stagingRoot, 0o500);
        return receipt();
      },
    },
  });

  await assert.rejects(
    materializer.materializeExactRevision({
      reference: REFERENCE,
      worktreeDir,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof (
      module.ProductionSharinganCaptureRevisionMaterializerError as new (...args: never[]) => Error
    ) && (error as Error & { code?: string }).code === "SHARINGAN_CAPTURE_CLEANUP_FAILED"
      && (error as Error & { failureClass?: string }).failureClass === "storage",
  );
  await assert.rejects(readFile(join(worktreeDir, ".sharingan", "pages.json")));
});

test("production Sharingan materializer rejects accessor-backed source configuration without invoking it", async () => {
  const module = await materializerModule();
  assert.equal(typeof module.ProductionSharinganCaptureRevisionMaterializer, "function");
  assert.equal(typeof module.ProductionSharinganCaptureRevisionMaterializerError, "function");
  const Materializer = module.ProductionSharinganCaptureRevisionMaterializer;
  const ErrorType = module.ProductionSharinganCaptureRevisionMaterializerError;
  if (typeof Materializer !== "function" || typeof ErrorType !== "function") return;
  let invoked = false;
  const hostileOptions = Object.defineProperty({}, "source", {
    enumerable: true,
    get() {
      invoked = true;
      return { materializeExactRevision: async () => receipt() };
    },
  });

  assert.throws(
    () => new Materializer(hostileOptions as never),
    (error: unknown) => error instanceof ErrorType
      && (error as Error & { code?: string }).code === "SHARINGAN_CAPTURE_SOURCE_UNAVAILABLE"
      && (error as Error & { failureClass?: string }).failureClass === "adapter",
  );
  assert.equal(invoked, false);
});

test("production Sharingan materializer aborts a stalled Revision source and removes owned staging", async (t) => {
  const module = await materializerModule();
  assert.equal(typeof module.ProductionSharinganCaptureRevisionMaterializer, "function");
  const Materializer = module.ProductionSharinganCaptureRevisionMaterializer;
  if (typeof Materializer !== "function") return;
  const testRoot = await mkdtemp(join(tmpdir(), "dezin-sharingan-materializer-abort-"));
  const worktreeDir = join(testRoot, "worktree");
  await mkdir(worktreeDir);
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  let destinationDir = "";
  let signalSourceStarted!: () => void;
  const sourceStarted = new Promise<void>((resolve) => { signalSourceStarted = resolve; });
  const materializer = new Materializer({
    source: {
      materializeExactRevision(input) {
        destinationDir = input.destinationDir;
        signalSourceStarted();
        return new Promise<MaterializationReceipt>(() => {});
      },
    },
  });
  const controller = new AbortController();
  const materialization = materializer.materializeExactRevision({
    reference: REFERENCE,
    worktreeDir,
    signal: controller.signal,
  });
  await sourceStarted;

  const reason = new Error("stop stalled Sharingan Revision source");
  controller.abort(reason);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Sharingan materializer did not observe cancellation")),
      250,
    );
  });
  await assert.rejects(Promise.race([materialization, timeout]), (error: unknown) => error === reason);
  if (timer !== undefined) clearTimeout(timer);

  assert.notEqual(destinationDir, "");
  await assert.rejects(lstat(destinationDir));
  await assert.rejects(lstat(dirname(destinationDir)));
  await assert.rejects(lstat(join(worktreeDir, ".sharingan")));
});
