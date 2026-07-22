import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentRunner, AgentTurnInput } from "../../../packages/agent/src/index.ts";
import {
  MAX_GENERATED_IMAGE_PLACEHOLDERS,
  type FetchLike,
} from "../src/image-gen.ts";
import {
  createProductionArtifactImagePostprocessingRunner,
  ProductionArtifactImagePostprocessingError,
} from "../src/orchestration/production-artifact-generation.ts";

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function imageProfile(overrides: Partial<{
  enabled: boolean;
  apiKey: string;
}> = {}) {
  return Object.freeze({
    protocol: "dezin.artifact-image-generation.v2" as const,
    enabled: overrides.enabled ?? true,
    providerId: "openai",
    baseUrl: "https://images.example.test/v1",
    model: "image-frozen",
    apiVersion: "2026-07-18",
    credentialRequired: true,
    checksum: "a".repeat(64),
    apiKey: overrides.apiKey ?? "exact-provider-secret",
  });
}

function turnInput(projectDir: string, signal = new AbortController().signal): AgentTurnInput {
  return {
    systemPrompt: "Create the exact design.",
    message: "Generate the page.",
    projectDir,
    signal,
  };
}

function artifactRunner(html: string, artifactPath = "index.html"): AgentRunner {
  return {
    id: "fixture-agent",
    async runTurn(input) {
      await writeFile(join(input.projectDir, artifactPath), html, "utf8");
      return { text: "Generated.", artifactHtml: html, artifactPath };
    },
  };
}

function imageFetch(bytes = VALID_PNG, calls?: string[]): FetchLike {
  return async (_input, init) => {
    calls?.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

test("production Artifact image postprocessing writes a validated PNG and canonical rewritten HTML", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  const calls: string[] = [];
  const html = '<main><img src="" data-gen-prompt="a quiet editorial landscape" alt="Cover"></main>';
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: artifactRunner(html),
    worktreeDir,
    imageGeneration: imageProfile(),
    fetchImpl: imageFetch(VALID_PNG, calls),
  });

  const result = await runner.runTurn(turnInput(worktreeDir));

  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /"output_format":"png"/);
  assert.doesNotMatch(result.artifactHtml, /data-gen-prompt/i);
  assert.match(result.artifactHtml, /src="assets\/gen-1\.png"/);
  assert.equal(await readFile(join(worktreeDir, "index.html"), "utf8"), result.artifactHtml);
  assert.deepEqual(await readFile(join(worktreeDir, "assets", "gen-1.png")), VALID_PNG);
});

test("production Artifact image postprocessing rejects a generation marker when frozen generation is disabled", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-disabled-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  let fetchCalls = 0;
  const html = '<img src="placeholder.png" data-gen-prompt="a quiet landscape" alt="Cover">';
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: artifactRunner(html),
    worktreeDir,
    imageGeneration: imageProfile({ enabled: false }),
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("disabled image provider must not be called");
    },
  });

  await assert.rejects(
    () => runner.runTurn(turnInput(worktreeDir)),
    (error: unknown) => {
      assert.ok(error instanceof ProductionArtifactImagePostprocessingError);
      assert.equal(error.code, "IMAGE_GENERATION_DISABLED");
      assert.equal(error.failureClass, "design");
      assert.match(error.message, /remove the generation marker|enable image generation/i);
      return true;
    },
  );
  assert.equal(fetchCalls, 0);
});

test("production Artifact image postprocessing rejects a marker without the exact provider credential", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-credential-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  const html = '<img src="placeholder.png" data-gen-prompt="a quiet landscape" alt="Cover">';
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: artifactRunner(html),
    worktreeDir,
    imageGeneration: imageProfile({ apiKey: "" }),
    fetchImpl: async () => {
      throw new Error("uncredentialed image provider must not be called");
    },
  });

  await assert.rejects(
    () => runner.runTurn(turnInput(worktreeDir)),
    (error: unknown) => {
      assert.ok(error instanceof ProductionArtifactImagePostprocessingError);
      assert.equal(error.code, "IMAGE_GENERATION_CREDENTIAL_UNAVAILABLE");
      assert.equal(error.failureClass, "provider");
      assert.match(error.message, /credential.*openai/i);
      return true;
    },
  );
});

test("production Artifact image postprocessing exposes provider failure instead of publishing a placeholder", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-provider-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  const html = '<img src="placeholder.png" data-gen-prompt="a quiet landscape" alt="Cover">';
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: artifactRunner(html),
    worktreeDir,
    imageGeneration: imageProfile(),
    fetchImpl: async () => new Response(
      JSON.stringify({ error: { message: "provider unavailable" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    ),
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      () => runner.runTurn(turnInput(worktreeDir)),
      (error: unknown) => {
        assert.ok(error instanceof ProductionArtifactImagePostprocessingError);
        assert.equal(error.code, "IMAGE_GENERATION_PROVIDER_FAILED");
        assert.equal(error.failureClass, "provider");
        assert.match(error.message, /provider.*failed|image generation.*failed/i);
        return true;
      },
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("production Artifact image postprocessing rejects malformed provider PNG bytes before writing", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-invalid-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  const html = '<img src="placeholder.png" data-gen-prompt="a quiet landscape" alt="Cover">';
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: artifactRunner(html),
    worktreeDir,
    imageGeneration: imageProfile(),
    fetchImpl: imageFetch(Buffer.from("PNG-signature-only")),
  });

  await assert.rejects(
    () => runner.runTurn(turnInput(worktreeDir)),
    (error: unknown) => {
      assert.ok(error instanceof ProductionArtifactImagePostprocessingError);
      assert.equal(error.code, "IMAGE_GENERATION_OUTPUT_INVALID");
      assert.equal(error.failureClass, "provider");
      assert.match(error.message, /valid bounded PNG/i);
      return true;
    },
  );
  await assert.rejects(() => readFile(join(worktreeDir, "assets", "gen-1.png")), /ENOENT/);
});

test("production Artifact image postprocessing rejects provider output beyond its byte budget", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-base64-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  const html = '<img src="placeholder.png" data-gen-prompt="a quiet landscape" alt="Cover">';
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: artifactRunner(html),
    worktreeDir,
    imageGeneration: imageProfile(),
    fetchImpl: imageFetch(),
    maxOutputBytes: 4,
  });

  await assert.rejects(
    () => runner.runTurn(turnInput(worktreeDir)),
    (error: unknown) => {
      assert.ok(error instanceof ProductionArtifactImagePostprocessingError);
      assert.equal(error.code, "IMAGE_GENERATION_OUTPUT_INVALID");
      assert.equal(error.failureClass, "provider");
      return true;
    },
  );
});

test("production Artifact image postprocessing rejects an Artifact path traversal before provider access", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-traversal-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  let fetchCalls = 0;
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: {
      id: "traversal-agent",
      async runTurn() {
        return {
          text: "Generated.",
          artifactHtml: '<img src="placeholder.png" data-gen-prompt="escape" alt="Cover">',
          artifactPath: "../outside.html",
        };
      },
    },
    worktreeDir,
    imageGeneration: imageProfile(),
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(
    () => runner.runTurn(turnInput(worktreeDir)),
    (error: unknown) => {
      assert.ok(error instanceof ProductionArtifactImagePostprocessingError);
      assert.equal(error.code, "IMAGE_GENERATION_PATH_INVALID");
      assert.equal(error.failureClass, "build-infrastructure");
      return true;
    },
  );
  assert.equal(fetchCalls, 0);
});

test("production Artifact image postprocessing rejects a symlinked assets directory without writing outside", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-symlink-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-outside-"));
  t.after(() => Promise.all([
    rm(worktreeDir, { recursive: true, force: true }),
    rm(outsideDir, { recursive: true, force: true }),
  ]));
  await symlink(outsideDir, join(worktreeDir, "assets"), "dir");
  const html = '<img src="placeholder.png" data-gen-prompt="a quiet landscape" alt="Cover">';
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: artifactRunner(html),
    worktreeDir,
    imageGeneration: imageProfile(),
    fetchImpl: imageFetch(),
  });

  await assert.rejects(
    () => runner.runTurn(turnInput(worktreeDir)),
    (error: unknown) => {
      assert.ok(error instanceof ProductionArtifactImagePostprocessingError);
      assert.equal(error.code, "IMAGE_GENERATION_PATH_INVALID");
      assert.equal(error.failureClass, "build-infrastructure");
      return true;
    },
  );
  await assert.rejects(() => readFile(join(outsideDir, "gen-1.png")), /ENOENT/);
});

test("production Artifact image postprocessing rejects a symlinked canonical Artifact before provider access", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-artifact-link-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-artifact-outside-"));
  t.after(() => Promise.all([
    rm(worktreeDir, { recursive: true, force: true }),
    rm(outsideDir, { recursive: true, force: true }),
  ]));
  const outsidePath = join(outsideDir, "outside.html");
  await writeFile(outsidePath, "sentinel", "utf8");
  await symlink(outsidePath, join(worktreeDir, "index.html"), "file");
  let fetchCalls = 0;
  const html = '<img src="placeholder.png" data-gen-prompt="a quiet landscape" alt="Cover">';
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: {
      id: "artifact-symlink-agent",
      async runTurn() {
        return { text: "Generated.", artifactHtml: html, artifactPath: "index.html" };
      },
    },
    worktreeDir,
    imageGeneration: imageProfile(),
    fetchImpl: async () => {
      fetchCalls += 1;
      return imageFetch()("https://images.example.test/v1");
    },
  });

  await assert.rejects(
    () => runner.runTurn(turnInput(worktreeDir)),
    (error: unknown) => {
      assert.ok(error instanceof ProductionArtifactImagePostprocessingError);
      assert.equal(error.code, "IMAGE_GENERATION_PATH_INVALID");
      return true;
    },
  );
  assert.equal(fetchCalls, 0);
  assert.equal(await readFile(outsidePath, "utf8"), "sentinel");
});

test("production Artifact image postprocessing propagates cancellation through the image provider", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-cancel-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  const controller = new AbortController();
  const cancellation = new DOMException("cancel exact generation Attempt", "AbortError");
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const html = '<img src="placeholder.png" data-gen-prompt="a quiet landscape" alt="Cover">';
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: artifactRunner(html),
    worktreeDir,
    imageGeneration: imageProfile(),
    fetchImpl: async (_input, init) => {
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("image request did not receive the Attempt signal"));
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });

  const running = runner.runTurn(turnInput(worktreeDir, controller.signal));
  await started;
  controller.abort(cancellation);

  await assert.rejects(running, (error: unknown) => error === cancellation);
  await assert.rejects(() => readFile(join(worktreeDir, "assets", "gen-1.png")), /ENOENT/);
});

test("production Artifact image postprocessing rejects an unprocessed generation marker", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-placeholder-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  const html = '<img src="placeholder.png" data-gen-prompt=a-quiet-landscape alt="Cover">';
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: artifactRunner(html),
    worktreeDir,
    imageGeneration: imageProfile(),
    fetchImpl: async () => {
      throw new Error("malformed marker must not reach the provider");
    },
  });

  await assert.rejects(
    () => runner.runTurn(turnInput(worktreeDir)),
    (error: unknown) => {
      assert.ok(error instanceof ProductionArtifactImagePostprocessingError);
      assert.equal(error.code, "IMAGE_GENERATION_PLACEHOLDER_INVALID");
      assert.equal(error.failureClass, "design");
      assert.match(error.message, /valid quoted prompt|replace.*real asset/i);
      return true;
    },
  );
});

test("production Artifact image postprocessing is a provider-free no-op without markers", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-noop-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  const html = '<main><img src="cover.png" alt="Cover"></main>';
  let fetchCalls = 0;
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: artifactRunner(html),
    worktreeDir,
    imageGeneration: imageProfile({ enabled: false, apiKey: "" }),
    fetchImpl: async () => {
      fetchCalls += 1;
      return imageFetch()("https://images.example.test/v1");
    },
  });

  const result = await runner.runTurn(turnInput(worktreeDir));

  assert.equal(fetchCalls, 0);
  assert.equal(result.artifactHtml, html);
  assert.equal(await readFile(join(worktreeDir, "index.html"), "utf8"), html);
});

test("production Artifact image postprocessing classifies bounded-marker violations as design failures", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-count-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  const html = Array.from(
    { length: MAX_GENERATED_IMAGE_PLACEHOLDERS + 1 },
    (_, index) => `<img src="placeholder-${index}.png" data-gen-prompt="image ${index}">`,
  ).join("");
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: artifactRunner(html),
    worktreeDir,
    imageGeneration: imageProfile(),
    fetchImpl: async () => {
      throw new Error("unbounded marker set must not reach the provider");
    },
  });

  await assert.rejects(
    () => runner.runTurn(turnInput(worktreeDir)),
    (error: unknown) => {
      assert.ok(error instanceof ProductionArtifactImagePostprocessingError);
      assert.equal(error.code, "IMAGE_GENERATION_PLACEHOLDER_INVALID");
      assert.equal(error.failureClass, "design");
      assert.match(error.message, /placeholder.*limit/i);
      return true;
    },
  );
});

test("production Artifact image postprocessing runs before publication on every repair turn", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-repair-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  let turn = 0;
  const providerCalls: string[] = [];
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: {
      id: "repair-agent",
      async runTurn(input) {
        turn += 1;
        const html = `<img src="placeholder.png" data-gen-prompt="repair image ${turn}" alt="Cover">`;
        await writeFile(join(input.projectDir, "index.html"), html, "utf8");
        return { text: `Repair ${turn}.`, artifactHtml: html, artifactPath: "index.html" };
      },
    },
    worktreeDir,
    imageGeneration: imageProfile(),
    fetchImpl: imageFetch(VALID_PNG, providerCalls),
  });

  const initial = await runner.runTurn(turnInput(worktreeDir));
  const repair = await runner.runTurn({ ...turnInput(worktreeDir), isRepair: true });

  assert.equal(providerCalls.length, 2);
  assert.doesNotMatch(initial.artifactHtml, /data-gen-prompt/i);
  assert.doesNotMatch(repair.artifactHtml, /data-gen-prompt/i);
  assert.equal(await readFile(join(worktreeDir, "index.html"), "utf8"), repair.artifactHtml);
});

test("production Artifact image postprocessing stops provider work after the first failed placeholder", async (t) => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "dezin-artifact-images-fail-fast-"));
  t.after(() => rm(worktreeDir, { recursive: true, force: true }));
  const html = [
    '<img src="placeholder-1.png" data-gen-prompt="first image">',
    '<img src="placeholder-2.png" data-gen-prompt="second image">',
  ].join("");
  let providerCalls = 0;
  const runner = createProductionArtifactImagePostprocessingRunner({
    runner: artifactRunner(html),
    worktreeDir,
    imageGeneration: imageProfile(),
    fetchImpl: async () => {
      providerCalls += 1;
      return providerCalls === 1
        ? new Response("unavailable", { status: 503 })
        : imageFetch()("https://images.example.test/v1");
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      () => runner.runTurn(turnInput(worktreeDir)),
      ProductionArtifactImagePostprocessingError,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(providerCalls, 1);
});
