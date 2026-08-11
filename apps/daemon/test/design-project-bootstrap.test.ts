import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bootstrapDesignProject,
  DesignProjectBootstrapError,
  recoverDesignProjectBootstraps,
  type DesignProjectBootstrapPorts,
} from "../src/design/design-project-bootstrap.ts";
import {
  ensureDesignProjectAtId,
  getDesignProject,
  listDesignProjects,
} from "../src/design/design-project-store.ts";

function receiptRoot(dataDir: string, idempotencyKey: string): string {
  return join(
    dataDir,
    "design-bootstrap-jobs",
    createHash("sha256").update(idempotencyKey).digest("hex"),
  );
}

function attachmentItem(bytes: Buffer, name = "reference.html") {
  return {
    asset: { name, mimeType: "text/html", base64: bytes.toString("base64") },
    binding: {
      type: "create-node" as const,
      node: { id: "node-reference", kind: "document" as const, name: "Reference" },
    },
  };
}

function projectPorts(dataDir: string): DesignProjectBootstrapPorts {
  return {
    ensureProject: (input) => ensureDesignProjectAtId(dataDir, input).then(() => undefined),
    ensureAssetBatch: async () => {
      throw new Error("empty bootstrap must not import assets");
    },
    ensureMainTurn: async () => {
      throw new Error("empty bootstrap must not reserve a Main turn");
    },
  };
}

test("an empty Home bootstrap is durable and exact replay returns the same Project", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-project-bootstrap-empty-"));
  try {
    const input = {
      schemaVersion: 1 as const,
      idempotencyKey: "home-empty-0001",
      name: "Empty canvas",
      prompt: "",
      items: [],
    };

    const first = await bootstrapDesignProject({ dataDir, input, ports: projectPorts(dataDir), now: () => 1_000 });
    const replay = await bootstrapDesignProject({ dataDir, input, ports: projectPorts(dataDir), now: () => 2_000 });

    assert.equal(first.reused, false);
    assert.equal(replay.reused, true);
    assert.equal(first.job.status, "ready");
    assert.equal(first.job.completedPhase, "ready");
    assert.equal(first.job.mainJobId, null);
    assert.equal(replay.job.id, first.job.id);
    assert.equal(replay.job.projectId, first.job.projectId);
    assert.equal((await getDesignProject(dataDir, first.job.projectId))?.name, "Empty canvas");
    assert.deepEqual((await listDesignProjects(dataDir)).map((project) => project.projectId), [first.job.projectId]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("one Home bootstrap idempotency key cannot be rebound to a different request", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-project-bootstrap-conflict-"));
  try {
    const base = {
      schemaVersion: 1 as const,
      idempotencyKey: "home-conflict-0001",
      name: "Bound request",
      prompt: "",
      items: [],
    };
    const first = await bootstrapDesignProject({ dataDir, input: base, ports: projectPorts(dataDir) });

    await assert.rejects(
      bootstrapDesignProject({
        dataDir,
        input: { ...base, prompt: "Create a different page" },
        ports: projectPorts(dataDir),
      }),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "conflict",
    );
    assert.deepEqual((await listDesignProjects(dataDir)).map((project) => project.projectId), [first.job.projectId]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("concurrent exact Home bootstrap requests converge on one durable Project", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-project-bootstrap-concurrent-"));
  try {
    const input = {
      schemaVersion: 1 as const,
      idempotencyKey: "home-concurrent-0001",
      name: "One project",
      prompt: "",
      items: [],
    };
    const [left, right] = await Promise.all([
      bootstrapDesignProject({ dataDir, input, ports: projectPorts(dataDir) }),
      bootstrapDesignProject({ dataDir, input, ports: projectPorts(dataDir) }),
    ]);

    assert.equal(left.job.id, right.job.id);
    assert.equal(left.job.projectId, right.job.projectId);
    assert.equal(Number(left.reused) + Number(right.reused), 1);
    assert.deepEqual((await listDesignProjects(dataDir)).map((project) => project.projectId), [left.job.projectId]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a process crash after Project publication resumes the same bootstrap Job", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-project-bootstrap-crash-project-"));
  try {
    const input = {
      schemaVersion: 1 as const,
      idempotencyKey: "home-crash-project-0001",
      name: "Crash recovery",
      prompt: "",
      items: [],
    };
    await assert.rejects(
      bootstrapDesignProject({
        dataDir,
        input,
        ports: projectPorts(dataDir),
        testHooks: {
          simulateProcessCrash: true,
          afterPhase: (phase) => {
            if (phase === "project-created") throw new Error("simulated bootstrap crash");
          },
        },
      }),
      /simulated bootstrap crash/,
    );

    const resumed = await bootstrapDesignProject({ dataDir, input, ports: projectPorts(dataDir) });
    assert.equal(resumed.reused, true);
    assert.equal(resumed.job.status, "ready");
    assert.equal((await listDesignProjects(dataDir)).length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Home bootstrap runs only the durable phases required by empty, attachment, prompt, and combined inputs", async () => {
  const attachment = {
    asset: { name: "reference.html", mimeType: "text/html", base64: "SGk=" },
    binding: {
      type: "create-node" as const,
      node: { id: "node-reference", kind: "document" as const, name: "Reference" },
    },
  };
  const modes = [
    { label: "empty", items: [], prompt: "", expected: ["project"] },
    { label: "attachment", items: [attachment], prompt: "", expected: ["project", "assets"] },
    { label: "prompt", items: [], prompt: "Create a launch page", expected: ["project", "main"] },
    {
      label: "combined",
      items: [attachment],
      prompt: "Create a launch page",
      expected: ["project", "assets", "main"],
    },
  ];

  for (const [index, mode] of modes.entries()) {
    const dataDir = await mkdtemp(join(tmpdir(), `dezin-project-bootstrap-${mode.label}-`));
    const events: string[] = [];
    try {
      const result = await bootstrapDesignProject({
        dataDir,
        input: {
          schemaVersion: 1,
          idempotencyKey: `home-mode-000${index}`,
          name: `${mode.label} project`,
          prompt: mode.prompt,
          items: mode.items,
        },
        ports: {
          ensureProject: async (input) => {
            await ensureDesignProjectAtId(dataDir, input);
            events.push("project");
          },
          ensureAssetBatch: async () => { events.push("assets"); },
          ensureMainTurn: async () => {
            events.push("main");
            return { jobId: `job-${mode.label}` };
          },
        },
      });

      assert.deepEqual(events, mode.expected, mode.label);
      assert.equal(result.job.status, "ready", mode.label);
      assert.equal(result.job.mainJobId, mode.prompt ? `job-${mode.label}` : null, mode.label);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("daemon startup recovery resumes an accepted bootstrap without a browser handoff", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-project-bootstrap-startup-"));
  try {
    const input = {
      schemaVersion: 1 as const,
      idempotencyKey: "home-startup-0001",
      name: "Recovered on startup",
      prompt: "",
      items: [],
    };
    await assert.rejects(
      bootstrapDesignProject({
        dataDir,
        input,
        ports: projectPorts(dataDir),
        testHooks: {
          simulateProcessCrash: true,
          afterPhase: (phase) => {
            if (phase === "accepted") throw new Error("process exited after accepting bootstrap");
          },
        },
      }),
      /process exited after accepting bootstrap/,
    );

    const recovered = await recoverDesignProjectBootstraps({ dataDir, ports: projectPorts(dataDir) });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.job.status, "ready");
    assert.equal((await listDesignProjects(dataDir))[0]?.projectId, recovered[0]?.job.projectId);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a tampered durable bootstrap receipt fails closed instead of replaying altered authority", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-project-bootstrap-corrupt-"));
  try {
    const input = {
      schemaVersion: 1 as const,
      idempotencyKey: "home-corrupt-0001",
      name: "Original authority",
      prompt: "",
      items: [],
    };
    await bootstrapDesignProject({ dataDir, input, ports: projectPorts(dataDir) });
    const receipt = createHash("sha256").update(input.idempotencyKey).digest("hex");
    const path = join(dataDir, "design-bootstrap-jobs", receipt, "job.json");
    const stored = JSON.parse(await readFile(path, "utf8")) as { request: { name: string } };
    stored.request.name = "Tampered authority";
    await writeFile(path, `${JSON.stringify(stored)}\n`);

    await assert.rejects(
      bootstrapDesignProject({ dataDir, input, ports: projectPorts(dataDir) }),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "corrupt",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("raw attachment bytes are staged with a compact receipt and removed after ready", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-project-bootstrap-staged-"));
  const bytes = Buffer.from("secret raw attachment bytes");
  const input = {
    schemaVersion: 1 as const,
    idempotencyKey: "home-staged-0001",
    name: "Staged attachment",
    prompt: "",
    items: [attachmentItem(bytes)],
  };
  let stagedPath = "";
  try {
    const result = await bootstrapDesignProject({
      dataDir,
      input,
      ports: {
        ensureProject: (project) => ensureDesignProjectAtId(dataDir, project).then(() => undefined),
        ensureAssetBatch: async ({ items }) => {
          assert.equal(items[0]?.asset.base64, bytes.toString("base64"));
        },
        ensureMainTurn: async () => { throw new Error("prompt is empty"); },
      },
      testHooks: {
        afterPhase: async (phase) => {
          if (phase !== "accepted") return;
          const root = receiptRoot(dataDir, input.idempotencyKey);
          const raw = await readFile(join(root, "job.json"), "utf8");
          assert.equal(raw.includes(bytes.toString("base64")), false);
          const stored = JSON.parse(raw) as {
            request: { items: Array<{ asset: { source: { kind: string; sha256: string; bytes: number } } }> };
          };
          const source = stored.request.items[0]!.asset.source;
          assert.deepEqual(source, {
            kind: "staged-bytes",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
          });
          stagedPath = join(root, "payloads", source.sha256);
          assert.deepEqual(await readFile(stagedPath), bytes);
          assert.equal((await stat(stagedPath)).mode & 0o777, 0o600);
        },
      },
    });

    assert.equal(result.job.status, "ready");
    await assert.rejects(stat(stagedPath), (error: unknown) => (
      error instanceof Error && "code" in error && error.code === "ENOENT"
    ));
    const compactReceipt = await readFile(join(receiptRoot(dataDir, input.idempotencyKey), "job.json"), "utf8");
    assert.equal(compactReceipt.includes(bytes.toString("base64")), false);
    assert.match(compactReceipt, new RegExp(createHash("sha256").update(bytes).digest("hex")));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an ambiguous Asset commit replays from verified staged bytes before ready cleanup", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-project-bootstrap-asset-replay-"));
  const bytes = Buffer.from("replay me exactly");
  const input = {
    schemaVersion: 1 as const,
    idempotencyKey: "home-asset-replay-0001",
    name: "Asset replay",
    prompt: "",
    items: [attachmentItem(bytes)],
  };
  const observed: string[] = [];
  let calls = 0;
  const ports: DesignProjectBootstrapPorts = {
    ensureProject: (project) => ensureDesignProjectAtId(dataDir, project).then(() => undefined),
    ensureAssetBatch: async ({ items }) => {
      calls += 1;
      observed.push(items[0]?.asset.base64 ?? "");
      if (calls === 1) throw new Error("process exited after Asset authority committed");
    },
    ensureMainTurn: async () => { throw new Error("prompt is empty"); },
  };
  try {
    await assert.rejects(
      bootstrapDesignProject({ dataDir, input, ports, testHooks: { simulateProcessCrash: true } }),
      /Asset authority committed/,
    );
    assert.equal((await readdir(join(receiptRoot(dataDir, input.idempotencyKey), "payloads"))).length, 1);

    const replay = await bootstrapDesignProject({ dataDir, input, ports });
    assert.equal(replay.job.status, "ready");
    assert.equal(calls, 2);
    assert.deepEqual(observed, [bytes.toString("base64"), bytes.toString("base64")]);
    await assert.rejects(stat(join(receiptRoot(dataDir, input.idempotencyKey), "payloads")));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("missing or tampered staged bytes fail closed before the Asset port", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-project-bootstrap-staged-corrupt-"));
  const input = {
    schemaVersion: 1 as const,
    idempotencyKey: "home-staged-corrupt-0001",
    name: "Corrupt staged attachment",
    prompt: "",
    items: [attachmentItem(Buffer.from("original"))],
  };
  let assetCalls = 0;
  try {
    await assert.rejects(
      bootstrapDesignProject({
        dataDir,
        input,
        ports: {
          ensureProject: (project) => ensureDesignProjectAtId(dataDir, project).then(() => undefined),
          ensureAssetBatch: async () => { assetCalls += 1; },
          ensureMainTurn: async () => { throw new Error("prompt is empty"); },
        },
        testHooks: {
          afterPhase: async (phase) => {
            if (phase !== "accepted") return;
            const payloads = join(receiptRoot(dataDir, input.idempotencyKey), "payloads");
            const [payload] = await readdir(payloads);
            await writeFile(join(payloads, payload!), "tampered", { mode: 0o600 });
          },
        },
      }),
      (error: unknown) => error instanceof DesignProjectBootstrapError && error.code === "corrupt",
    );
    assert.equal(assetCalls, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("attachment byte budgets are rejected before any durable receipt is persisted", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-project-bootstrap-budget-"));
  const input = {
    schemaVersion: 1 as const,
    idempotencyKey: "home-budget-0001",
    name: "Oversized attachment",
    prompt: "",
    items: [attachmentItem(Buffer.alloc(5))],
  };
  try {
    await assert.rejects(
      bootstrapDesignProject({
        dataDir,
        input,
        ports: projectPorts(dataDir),
        testHooks: { assetByteLimits: { perAsset: 4, batch: 8 } },
      }),
      (error: unknown) => error instanceof DesignProjectBootstrapError && error.code === "invalid-input",
    );
    await assert.rejects(stat(receiptRoot(dataDir, input.idempotencyKey)));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("one bootstrap key cannot replay a different staged byte hash", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-project-bootstrap-byte-conflict-"));
  const base = {
    schemaVersion: 1 as const,
    idempotencyKey: "home-byte-conflict-0001",
    name: "Byte authority",
    prompt: "",
  };
  const ports: DesignProjectBootstrapPorts = {
    ensureProject: (project) => ensureDesignProjectAtId(dataDir, project).then(() => undefined),
    ensureAssetBatch: async () => undefined,
    ensureMainTurn: async () => { throw new Error("prompt is empty"); },
  };
  try {
    await bootstrapDesignProject({ ...{ dataDir, ports }, input: { ...base, items: [attachmentItem(Buffer.from("left"))] } });
    await assert.rejects(
      bootstrapDesignProject({ ...{ dataDir, ports }, input: { ...base, items: [attachmentItem(Buffer.from("right"))] } }),
      (error: unknown) => error instanceof DesignProjectBootstrapError && error.code === "conflict",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
