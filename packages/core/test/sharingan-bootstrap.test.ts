import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SHARINGAN_BOOTSTRAP_STATE_PROTOCOL,
  SharinganBootstrapStateError,
  normalizeSharinganBootstrapState,
} from "../src/index.ts";

const base = {
  protocol: SHARINGAN_BOOTSTRAP_STATE_PROTOCOL,
  projectId: "project-1",
  sourceUrl: "https://source.example/",
  initialTurnId: "turn-11111111-1111-4111-8111-111111111111",
  bootstrapBaseGraphRevision: 0,
  bootstrapBaseSnapshotId: "snapshot-0",
  attempt: 1,
  updatedAt: 10,
} as const;

test("Sharingan bootstrap state preserves explicit retryable failure across reload", () => {
  const encoded = JSON.stringify({
    ...base,
    status: "failed",
    error: {
      code: "SHARINGAN_BOOTSTRAP_CAPTURE_FAILED",
      message: "The source page could not be captured.",
      retryable: true,
    },
  });

  assert.deepEqual(normalizeSharinganBootstrapState(JSON.parse(encoded)), {
    ...base,
    status: "failed",
    error: {
      code: "SHARINGAN_BOOTSTRAP_CAPTURE_FAILED",
      message: "The source page could not be captured.",
      retryable: true,
    },
  });
});

test("Sharingan bootstrap ready state requires exact immutable Resource identity", () => {
  assert.deepEqual(normalizeSharinganBootstrapState({
    ...base,
    status: "ready",
    resourceId: "resource-1",
    revisionId: "revision-1",
    readyGraphRevision: 1,
    readySnapshotId: "snapshot-1",
  }), {
    ...base,
    status: "ready",
    resourceId: "resource-1",
    revisionId: "revision-1",
    readyGraphRevision: 1,
    readySnapshotId: "snapshot-1",
  });

  assert.throws(
    () => normalizeSharinganBootstrapState({
      ...base,
      status: "ready",
      resourceId: "resource-1",
    }),
    SharinganBootstrapStateError,
  );
});

test("Sharingan bootstrap state accepts common non-canonical and fragment URLs without credentials", () => {
  assert.equal(normalizeSharinganBootstrapState({
    ...base,
    sourceUrl: "https://example.com",
    status: "pending",
  }).sourceUrl, "https://example.com");
  assert.equal(normalizeSharinganBootstrapState({
    ...base,
    sourceUrl: "https://example.com/product#pricing",
    status: "capturing",
  }).sourceUrl, "https://example.com/product#pricing");
});

test("Sharingan bootstrap state rejects credentials and client-authored fields", () => {
  assert.throws(
    () => normalizeSharinganBootstrapState({
      ...base,
      sourceUrl: "https://user:secret@source.example/",
      status: "capturing",
    }),
    SharinganBootstrapStateError,
  );
  assert.throws(
    () => normalizeSharinganBootstrapState({
      ...base,
      status: "pending",
      fabricatedResourceId: "resource-1",
    }),
    SharinganBootstrapStateError,
  );
});
