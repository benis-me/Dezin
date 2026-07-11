import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_CAPTURE_LIMIT_BYTES, runCapture } from "../src/providers/cli.ts";

test("runCapture returns bounded normal probe output", async () => {
  const result = await runCapture(process.execPath, ["-e", "process.stdout.write('v1.2.3')"], 2000);
  assert.deepEqual(result, { code: 0, out: "v1.2.3" });
});

test("runCapture terminates and returns null when combined output exceeds 1 MiB", async () => {
  const result = await runCapture(
    process.execPath,
    ["-e", `process.on('SIGTERM',()=>{}); process.stdout.write(Buffer.alloc(${PROVIDER_CAPTURE_LIMIT_BYTES + 64 * 1024}, 120)); setInterval(()=>{},1000)`],
    3000,
  );
  assert.equal(result, null);
});
