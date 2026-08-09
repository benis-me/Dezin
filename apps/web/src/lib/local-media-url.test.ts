import { expect, test } from "vitest";

import { explicitExternalImageHref, localPassiveImageSource } from "./local-media-url.ts";

test("localPassiveImageSource permits passive local bytes and paths only", () => {
  expect(localPassiveImageSource("/api/assets/preview.webp")).toBe("/api/assets/preview.webp");
  expect(localPassiveImageSource("./preview.png")).toBe("./preview.png");
  expect(localPassiveImageSource("images/preview.png")).toBe("images/preview.png");
  expect(localPassiveImageSource("data:image/png;base64,AA==")).toBe("data:image/png;base64,AA==");
  expect(localPassiveImageSource("blob:https://app.local/asset-id")).toBe("blob:https://app.local/asset-id");

  expect(localPassiveImageSource("https://example.com/tracker.png")).toBeNull();
  expect(localPassiveImageSource("//example.com/tracker.png")).toBeNull();
  expect(localPassiveImageSource("/\\example.com/tracker.png")).toBeNull();
  expect(localPassiveImageSource("javascript:alert(1)")).toBeNull();
  expect(localPassiveImageSource("data:image/svg+xml,<svg/>")).toBeNull();
});

test("explicitExternalImageHref permits only deliberate HTTP navigation", () => {
  expect(explicitExternalImageHref("https://example.com/image.png")).toBe("https://example.com/image.png");
  expect(explicitExternalImageHref("http://example.com/image.png")).toBe("http://example.com/image.png");
  expect(explicitExternalImageHref("javascript:alert(1)")).toBeNull();
  expect(explicitExternalImageHref("file:///tmp/private.png")).toBeNull();
  expect(explicitExternalImageHref("//example.com/image.png")).toBeNull();
});
