import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildPortableDesignHtmlPlan,
  buildPortableDesignHtml,
  buildPortableDesignHtmlFromAssetLoader,
  materializePortableDesignHtml,
  MAX_PORTABLE_DESIGN_HTML_BYTES,
  PortableDesignHtmlError,
} from "../src/design/design-portable-html.ts";

const assetBytes = Buffer.from("portable-pixel", "utf8");
const checksum = createHash("sha256").update(assetBytes).digest("hex");
const assetId = `asset-${"1".repeat(32)}`;
const canonicalUrl = `/api/projects/project-1/design-canvas/assets/${assetId}/original.png`
  + `?nodeId=node-1&versionId=version-1&checksum=${checksum}`;

function asset(overrides: Partial<Parameters<typeof buildPortableDesignHtml>[0]["assets"][number]> = {}) {
  return {
    assetId,
    checksum,
    mimeType: "image/png",
    canonicalUrl,
    bytes: assetBytes,
    ...overrides,
  };
}

test("portable HTML replaces raw and HTML-escaped immutable Asset URLs with verified data URLs", () => {
  const html = Buffer.from(`<img src="${canonicalUrl}"><img src="${canonicalUrl.replaceAll("&", "&amp;")}">`);

  const portable = buildPortableDesignHtml({ html, assets: [asset()] }).toString("utf8");

  assert.equal(portable.includes("/api/projects/"), false);
  assert.equal(portable.match(/data:image\/png;base64,/g)?.length, 2);
  assert.equal(portable.includes(assetBytes.toString("base64")), true);
});

test("portable HTML rewrites entity-decoded legacy background URLs on browser-fetching elements", () => {
  const entityUrl = canonicalUrl.replaceAll("&", "&#38;").replaceAll("/", "&#47;");
  const html = Buffer.from(`<!doctype html><html><head></head><body background="${entityUrl}">
    <table background="${entityUrl}"><tbody><tr><td background="${entityUrl}">cell</td></tr></tbody></table>
  </body></html>`);

  const portable = buildPortableDesignHtml({ html, assets: [asset()] }).toString("utf8");

  assert.equal(portable.match(/data:image\/png;base64,/g)?.length, 3);
  assert.doesNotMatch(portable, /&#47;api|\/api\/projects\//i);
});

test("portable HTML rewrites SVG href namespaces and presentation URL values from semantic attributes", () => {
  const entityUrl = canonicalUrl.replaceAll("&", "&#38;").replaceAll("/", "&#47;");
  const html = Buffer.from(`<!doctype html><html><head></head><body>
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <image href="${entityUrl}" width="10" height="10" />
      <image xlink:href="${entityUrl}" width="10" height="10" />
      <rect fill="url('${entityUrl}')" width="10" height="10" />
    </svg>
  </body></html>`);

  const portable = buildPortableDesignHtml({ html, assets: [asset()] }).toString("utf8");

  assert.equal(portable.match(/data:image\/png;base64,/g)?.length, 3);
  assert.match(portable, /xlink:href="data:image\/png;base64,/);
  assert.match(portable, /fill="url\('data:image\/png;base64,/);
  assert.doesNotMatch(portable, /&#47;api|\/api\/projects\//i);
});

test("portable HTML rewrites decoded URL attributes, srcset, and CSS URLs without touching script text", () => {
  const entityUrl = canonicalUrl
    .replaceAll("&", "&#38;")
    .replaceAll("/", "&#47;");
  const cssEscapedUrl = canonicalUrl.replaceAll("/", "\\2f ");
  const escapedScriptLiteral = canonicalUrl.replaceAll("&", "&#38;").replaceAll("/", "&#47;");
  const html = Buffer.from(`<!doctype html><html><head>
    <style>.hero {
      background-image: url("${cssEscapedUrl}");
      background-image: image-set("${canonicalUrl}" 1x);
    }</style>
  </head><body>
    <img src="${entityUrl}" srcset="${canonicalUrl.replaceAll("&", "&amp;")} 1x, ${entityUrl} 2x">
    <a href="${canonicalUrl.replaceAll("&", "&amp;")}">Download</a>
    <div style="background-image:url('${entityUrl}')"></div>
    <script>const inertAssetText = "${escapedScriptLiteral}";</script>
  </body></html>`);

  const portable = buildPortableDesignHtml({ html, assets: [asset()] }).toString("utf8");

  assert.equal(portable.match(/data:image\/png;base64,/g)?.length, 7);
  assert.equal(portable.match(/background-image:/g)?.length, 3);
  assert.equal(portable.includes(".hero {\n      background-image:"), true);
  assert.equal(portable.includes(escapedScriptLiteral), true);
  assert.equal(portable.includes(canonicalUrl), false);
});

test("portable HTML rejects entity-encoded unauthorized Dezin URLs and raw Dezin URLs inside scripts", () => {
  const unauthorized = canonicalUrl.replace(`checksum=${checksum}`, `checksum=${"0".repeat(64)}`)
    .replaceAll("&", "&#38;")
    .replaceAll("/", "&#47;");
  const unauthorizedCss = canonicalUrl.replace(`checksum=${checksum}`, `checksum=${"0".repeat(64)}`)
    .replaceAll("/", "\\2f ");
  assert.throws(
    () => buildPortableDesignHtml({
      html: Buffer.from(`<img src="${unauthorized}"><img src="${canonicalUrl}">`),
      assets: [asset()],
    }),
    (error: unknown) => error instanceof PortableDesignHtmlError
      && error.code === "corrupt"
      && /not authorized/.test(error.message),
  );
  assert.throws(
    () => buildPortableDesignHtml({
      html: Buffer.from(`<!doctype html><html><head></head><body background="${canonicalUrl
        .replaceAll("&", "&#38;")
        .replaceAll("/", "&#47;")}"></body></html>`),
      assets: [],
    }),
    (error: unknown) => error instanceof PortableDesignHtmlError
      && error.code === "corrupt"
      && /not authorized/.test(error.message),
  );
  assert.throws(
    () => buildPortableDesignHtml({
      html: Buffer.from(`<style>.unsafe { background: url('${unauthorizedCss}') }</style><img src="${canonicalUrl}">`),
      assets: [asset()],
    }),
    (error: unknown) => error instanceof PortableDesignHtmlError
      && error.code === "corrupt"
      && /not authorized/.test(error.message),
  );
  assert.throws(
    () => buildPortableDesignHtml({
      html: Buffer.from(`<img src="${canonicalUrl}"><script>const path = ${JSON.stringify(canonicalUrl)}</script>`),
      assets: [asset()],
    }),
    (error: unknown) => error instanceof PortableDesignHtmlError
      && error.code === "corrupt"
      && /still references/.test(error.message),
  );
});

test("portable planning rejects projected base64 output before an Asset payload loader can run", async () => {
  let reads = 0;
  await assert.rejects(
    buildPortableDesignHtmlFromAssetLoader({
      html: Buffer.from(`<img src="${canonicalUrl}">`),
      assets: [{
        assetId,
        checksum,
        mimeType: "image/png",
        canonicalUrl,
        byteLength: MAX_PORTABLE_DESIGN_HTML_BYTES,
      }],
    }, async () => {
      reads += 1;
      return assetBytes;
    }),
    (error: unknown) => error instanceof PortableDesignHtmlError && error.code === "limit",
  );
  assert.equal(reads, 0);
});

test("portable materialization reads a 1000-pin manifest sequentially and replaces in one bounded pass", async () => {
  const bytes = Buffer.from([0x2a]);
  const pinChecksum = createHash("sha256").update(bytes).digest("hex");
  const descriptors = Array.from({ length: 1_000 }, (_, index) => {
    const id = `asset-${index.toString(16).padStart(32, "0")}`;
    return {
      assetId: id,
      checksum: pinChecksum,
      mimeType: "image/png",
      canonicalUrl: `/api/projects/project-1/design-canvas/assets/${id}/original.png`
        + `?nodeId=node-1&versionId=version-1&checksum=${pinChecksum}`,
      byteLength: bytes.length,
    };
  });
  const plan = buildPortableDesignHtmlPlan({
    html: Buffer.from(descriptors.map((descriptor) => `<img src="${descriptor.canonicalUrl}">`).join("")),
    assets: descriptors,
  });
  let activeReads = 0;
  let maximumActiveReads = 0;
  let reads = 0;

  const portable = await materializePortableDesignHtml(plan, async () => {
    reads += 1;
    activeReads += 1;
    maximumActiveReads = Math.max(maximumActiveReads, activeReads);
    await Promise.resolve();
    activeReads -= 1;
    return bytes;
  });

  assert.equal(reads, 1_000);
  assert.equal(maximumActiveReads, 1);
  assert.equal(portable.toString("utf8").match(/data:image\/png;base64,/g)?.length, 1_000);
  assert.doesNotMatch(portable.toString("utf8"), /\/api\/projects\//);
});

test("portable HTML rejects corrupted, unreferenced, duplicate, or residual internal Assets", () => {
  const referenced = Buffer.from(`<img src="${canonicalUrl}">`);
  assert.throws(
    () => buildPortableDesignHtml({ html: referenced, assets: [asset({ bytes: Buffer.from("tampered") })] }),
    (error: unknown) => error instanceof PortableDesignHtmlError && error.code === "corrupt",
  );
  assert.throws(
    () => buildPortableDesignHtml({ html: Buffer.from("<main>offline</main>"), assets: [asset()] }),
    (error: unknown) => error instanceof PortableDesignHtmlError && /not referenced/.test(error.message),
  );
  assert.throws(
    () => buildPortableDesignHtml({ html: referenced, assets: [asset(), asset()] }),
    (error: unknown) => error instanceof PortableDesignHtmlError && /pinned more than once/.test(error.message),
  );
  assert.throws(
    () => buildPortableDesignHtml({
      html: Buffer.from("<img src=\"dezin-asset://unpinned\">") ,
      assets: [],
    }),
    (error: unknown) => error instanceof PortableDesignHtmlError && /not authorized|still references/.test(error.message),
  );
});

test("portable HTML rejects active-document Asset media types", () => {
  const referenced = Buffer.from(`<img src="${canonicalUrl}">`);
  for (const mimeType of [
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/xml",
    "application/atom+xml",
    "application/pdf",
  ]) {
    assert.throws(
      () => buildPortableDesignHtml({ html: referenced, assets: [asset({ mimeType })] }),
      (error: unknown) => error instanceof PortableDesignHtmlError
        && error.code === "corrupt"
        && /active|unsafe/.test(error.message),
      mimeType,
    );
  }
});

test("portable HTML semantically rejects historical JavaScript internal Asset sinks", () => {
  const scripts = [
    `const image = document.createElement("img"); image.src = "dezin" + "-asset://${assetId}";`,
    `const image = document.createElement("img"); image.src = "dezin\\x2dasset://${assetId}";`,
    `/* dezin-asset://${assetId} */ const image = document.createElement("img"); image.src = "dezin\\x2dasset://${assetId}";`,
    `const decoy = "dezin-asset://${assetId}"; const image = document.createElement("img"); image.src = "dezin" + "-asset://${assetId}"; void decoy;`,
    `const decoy = "dezin-asset://${assetId}"; const image = document.createElement("img"); image.src = "dezin\\x2dasset://${assetId}"; void decoy;`,
    `const exact = document.createElement("img"); exact.src = "dezin-asset://${assetId}"; const split = document.createElement("img"); split.src = "dezin" + "-asset://${assetId}";`,
    `const id = "${assetId}"; const image = document.createElement("img"); image.src = \`dezin-asset://\${id}\`;`,
  ];
  for (const script of scripts) {
    assert.throws(
      () => buildPortableDesignHtml({
        html: Buffer.from(`<!doctype html><html><head></head><body><script>${script}</script></body></html>`),
        assets: [],
      }),
      (error: unknown) => error instanceof PortableDesignHtmlError
        && error.code === "corrupt"
        && /Dezin|internal|authorized|invalid JavaScript/.test(error.message),
      script,
    );
  }
});

test("portable HTML rejects malformed UTF-8 instead of silently changing immutable source bytes", () => {
  assert.throws(
    () => buildPortableDesignHtml({
      html: Buffer.from([0x3c, 0x70, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x70, 0x3e]),
      assets: [],
    }),
    (error: unknown) => error instanceof PortableDesignHtmlError
      && error.code === "corrupt"
      && /UTF-8/.test(error.message),
  );
});
