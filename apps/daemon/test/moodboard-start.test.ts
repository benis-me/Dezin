import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { compensateMoodboardStart, recoverIncompleteMoodboards } from "../src/moodboard-handler.ts";

type StartBody = {
  name: string;
  prompt?: string;
  mode: "agent" | "generate";
  images?: Array<{ name: string; contentBase64: string; mimeType: string; width?: number; height?: number }>;
  imageModel?: string;
};

async function withServer(
  configure: (store: Store) => void,
  run: (ctx: { base: string; dataDir: string; store: Store }) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-moodboard-start-"));
  const store = new Store(":memory:");
  configure(store);
  const server = createApp({ store, dataDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ base: `http://127.0.0.1:${port}`, dataDir, store });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function start(base: string, body: StartBody, fetchImpl: typeof fetch = fetch): Promise<Response> {
  return fetchImpl(`${base}/api/moodboards/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function assertNoMoodboardState(dataDir: string, store: Store): void {
  assert.deepEqual(store.listMoodboards(), []);
  const row = store.db.prepare("SELECT COUNT(*) AS count FROM moodboards").get() as { count: number };
  assert.equal(row.count, 0);
  const root = join(dataDir, "moodboards");
  assert.equal(existsSync(root) ? readdirSync(root).length : 0, 0);
}

test("POST /api/moodboards/start creates uploads, nodes, and the first agent turn atomically", async () => {
  await withServer(
    () => {},
    async ({ base, dataDir, store }) => {
      const response = await start(base, {
        name: "Warm references",
        prompt: "Collect a calm hospitality direction",
        mode: "agent",
        images: [
          {
            name: "lobby.png",
            contentBase64: Buffer.from("PNGDATA").toString("base64"),
            mimeType: "image/png",
            width: 640,
            height: 480,
          },
        ],
      });
      const text = await response.text();
      assert.equal(response.status, 201, text);
      const board = JSON.parse(text) as { id: string; name: string };
      assert.equal(board.name, "Warm references");
      assert.equal(store.listMoodboards().length, 1);
      assert.equal(store.listMoodboardAssets(board.id).length, 1);
      assert.equal(store.listMoodboardNodes(board.id).length, 1);
      assert.equal(store.listMoodboardMessages(board.id).length, 2);
      assert.equal(existsSync(join(dataDir, "moodboards", board.id, "assets")), true);
    },
  );
});

for (const stage of ["upload", "nodes", "message"] as const) {
  test(`POST /api/moodboards/start compensates database and files after ${stage} failure`, async () => {
    await withServer(
      (store) => {
        if (stage === "upload") {
          store.createMoodboardAsset = (() => {
            throw new Error("upload failed");
          }) as Store["createMoodboardAsset"];
        } else if (stage === "nodes") {
          store.replaceMoodboardNodes = (() => {
            throw new Error("node save failed");
          }) as Store["replaceMoodboardNodes"];
        } else {
          store.addMoodboardMessage = (() => {
            throw new Error("message failed");
          }) as Store["addMoodboardMessage"];
        }
      },
      async ({ base, dataDir, store }) => {
        const response = await start(base, {
          name: `Failure at ${stage}`,
          prompt: stage === "message" ? "Start the direction" : undefined,
          mode: "agent",
          images:
            stage === "message"
              ? undefined
              : [
                  {
                    name: "reference.png",
                    contentBase64: Buffer.from("PNGDATA").toString("base64"),
                    mimeType: "image/png",
                  },
                ],
        });
        assert.equal(response.status, 500);
        assertNoMoodboardState(dataDir, store);
      },
    );
  });
}

test("POST /api/moodboards/start compensates database and files after generation failure", async () => {
  const previousFetch = globalThis.fetch;
  const httpFetch = previousFetch.bind(globalThis);
  try {
    globalThis.fetch = (async () => {
      throw new Error("generation failed");
    }) as typeof fetch;
    await withServer(
      (store) => {
        store.updateSettings({
          aiProviderId: "openai",
          aiProviderEnabled: true,
          imageApiBaseUrl: "https://api.openai.com/v1",
          imageApiKey: "test-key",
          imageModel: "gpt-image-1",
        });
      },
      async ({ base, dataDir, store }) => {
        const response = await start(base, {
          name: "Failed generation",
          prompt: "Generate a hero reference",
          mode: "generate",
          imageModel: "gpt-image-1",
        }, httpFetch);
        assert.equal(response.status, 500);
        assertNoMoodboardState(dataDir, store);
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("POST /api/moodboards/start keeps a delayed board hidden until it is fully published", async () => {
  const previousFetch = globalThis.fetch;
  const httpFetch = previousFetch.bind(globalThis);
  let enteredGeneration!: () => void;
  let releaseGeneration!: () => void;
  const generationEntered = new Promise<void>((resolve) => {
    enteredGeneration = resolve;
  });
  const generationGate = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
  try {
    globalThis.fetch = (async () => {
      enteredGeneration();
      await generationGate;
      throw new Error("finish delayed failure");
    }) as typeof fetch;
    await withServer(
      (store) => {
        store.updateSettings({
          aiProviderId: "openai",
          aiProviderEnabled: true,
          imageApiBaseUrl: "https://api.openai.com/v1",
          imageApiKey: "test-key",
          imageModel: "gpt-image-1",
        });
      },
      async ({ base, store }) => {
        const responsePromise = start(
          base,
          { name: "Still staging", prompt: "Generate slowly", mode: "generate", imageModel: "gpt-image-1" },
          httpFetch,
        );
        await generationEntered;
        const row = store.db.prepare("SELECT id FROM moodboards LIMIT 1").get() as { id: string } | undefined;
        assert.ok(row?.id);

        const listResponse = await httpFetch(`${base}/api/moodboards`);
        const listStatus = listResponse.status;
        const listBody = await listResponse.json();
        const detailResponse = await httpFetch(`${base}/api/moodboards/${row.id}`);
        const detailStatus = detailResponse.status;

        releaseGeneration();
        assert.equal((await responsePromise).status, 500);
        assert.equal(listStatus, 200);
        assert.deepEqual(listBody, []);
        assert.equal(detailStatus, 404);
      },
    );
  } finally {
    releaseGeneration?.();
    globalThis.fetch = previousFetch;
  }
});

test("POST /api/moodboards/start retries database compensation before leaving hidden state behind", async () => {
  let deleteAttempts = 0;
  await withServer(
    (store) => {
      const deleteMoodboard = store.deleteMoodboard.bind(store);
      store.deleteMoodboard = ((id: string) => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("database temporarily busy");
        deleteMoodboard(id);
      }) as Store["deleteMoodboard"];
      store.createMoodboardAsset = (() => {
        throw new Error("upload failed");
      }) as Store["createMoodboardAsset"];
    },
    async ({ base, dataDir, store }) => {
      const response = await start(base, {
        name: "Retry compensation",
        mode: "agent",
        images: [{ name: "broken.png", contentBase64: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/png" }],
      });
      assert.equal(response.status, 500);
      assert.equal(deleteAttempts, 2);
      assertNoMoodboardState(dataDir, store);
    },
  );
});

test("failed filesystem compensation keeps the staging row hidden and reports recovery work", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-moodboard-compensation-"));
  const store = new Store(":memory:");
  const board = store.createMoodboard({ name: "Hidden recovery" }, { status: "starting" });
  const warnings: unknown[][] = [];
  const previousWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    await compensateMoodboardStart(
      board.id,
      { store, dataDir },
      async () => {
        throw new Error("filesystem still busy");
      },
    );
    assert.equal(store.getMoodboard(board.id)?.id, board.id);
    assert.deepEqual(store.listMoodboards(), []);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /compensation incomplete/);
  } finally {
    console.warn = previousWarn;
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("startup recovery removes staging rows and their files before they can be listed", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-moodboard-recovery-"));
  const store = new Store(":memory:");
  const board = store.createMoodboard({ name: "Interrupted start" }, { status: "starting" });
  const dir = join(dataDir, "moodboards", board.id, "assets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "partial.png"), "partial");
  try {
    recoverIncompleteMoodboards({ store, dataDir });
    assert.equal(store.getMoodboard(board.id), null);
    assert.equal(existsSync(join(dataDir, "moodboards", board.id)), false);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
