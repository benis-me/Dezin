import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRuntimeFailure } from "../src/design/design-node-runtime-gate.ts";

test("runtime gate failures are explained in one actionable sentence with the raw error kept", () => {
  const cors = describeRuntimeFailure(
    "runtime-error",
    "SecurityError: Failed to execute 'texImage2D' on 'WebGL2RenderingContext': The image element contains cross-origin data, and may not be loaded.",
  );
  assert.match(cors, /cross-origin image was blocked by the preview sandbox/);
  assert.match(cors, /crossorigin="anonymous"/);
  assert.match(cors, /texImage2D/);

  assert.match(describeRuntimeFailure("runtime-error", "Uncaught TypeError: Cannot read properties of null"), /script error stopped rendering/);
  assert.match(describeRuntimeFailure("runtime-error", "ReferenceError: gsap is not defined"), /script error stopped rendering/);
  assert.match(describeRuntimeFailure("runtime-error", "Something odd"), /runtime error \(Something odd\)/);
  assert.match(describeRuntimeFailure("blocked-request", "https://cdn.example/font.woff2"), /network request was blocked.*dezin-asset:\/\//);
});
