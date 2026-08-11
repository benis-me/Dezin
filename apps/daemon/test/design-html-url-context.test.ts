import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import puppeteer from "puppeteer-core";

import { findDesignExportChrome } from "../src/design/design-export-visual-gate.ts";
import { validateDesignHtml } from "../src/design/design-storage.ts";

function html(body: string): string {
  return `<!doctype html><html><head></head>${body}</html>`;
}

test("Design HTML rejects external legacy background URLs that Chrome fetches", () => {
  const external = "https://assets.example.test/tracker.png";
  const entityExternal = external.replaceAll("/", "&#47;");
  const documents = [external, entityExternal].flatMap((url) => [
    html(`<body background="${url}"></body>`),
    html(`<body><table background="${url}"><tbody><tr><td>cell</td></tr></tbody></table></body>`),
    html(`<body><table><tbody><tr><td background="${url}">cell</td></tr></tbody></table></body>`),
  ]);

  for (const document of documents) {
    assert.throws(
      () => validateDesignHtml(document, { allowCanonicalAssets: true }),
      /unpinned|external|URL-bearing/i,
    );
  }
});

test("Design HTML fails closed for unsupported namespaced and SVG presentation URL contexts", () => {
  const external = "https://assets.example.test/tracker.svg";
  assert.throws(
    () => validateDesignHtml(html(`<body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="url(${external})" /></svg>
    </body>`)),
    /unpinned|external|URL-bearing/i,
  );
  assert.throws(
    () => validateDesignHtml(html(`<body>
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:vendor="urn:vendor">
        <image vendor:href="${external}" width="10" height="10" />
      </svg>
    </body>`)),
    /unsupported URL-bearing/i,
  );
  assert.throws(
    () => validateDesignHtml(html(`<body>
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <image xlink:href="${external}" width="10" height="10" />
      </svg>
    </body>`)),
    /unpinned|external/i,
  );
});

test("Design HTML rejects SVG script URL contexts that cannot be made safely portable", () => {
  assert.throws(
    () => validateDesignHtml(html(`<body>
      <svg xmlns="http://www.w3.org/2000/svg">
        <script href="data:text/javascript,document.body.dataset.compromised='true'"></script>
      </svg>
    </body>`)),
    /inline|unsupported URL-bearing/i,
  );
});

test("non-URL XLink metadata is not mistaken for a fetch context", () => {
  assert.doesNotThrow(() => validateDesignHtml(html(`<body>
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <a href="#target" xlink:title="Local target"><text>Jump</text></a>
    </svg>
  </body>`)));
});

test("Chrome really fetches every legacy background URL over loopback", {
  skip: !findDesignExportChrome() && "no Chrome",
}, async (context) => {
  const requested = new Set<string>();
  const expected = [
    "/body.png",
    "/table.png",
    "/thead.png",
    "/tbody.png",
    "/tfoot.png",
    "/tr.png",
    "/td.png",
    "/th.png",
  ];
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head></head><body background="/body.png">
        <table background="/table.png">
          <thead background="/thead.png"><tr background="/tr.png"><th background="/th.png">head</th></tr></thead>
          <tbody background="/tbody.png"><tr><td background="/td.png">body</td></tr></tbody>
          <tfoot background="/tfoot.png"><tr><td>foot</td></tr></tfoot>
        </table>
      </body></html>`);
      return;
    }
    if (request.url) requested.add(request.url);
    response.setHeader("content-type", "image/png");
    response.end(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XfD0WQAAAABJRU5ErkJggg==",
      "base64",
    ));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const browser = await puppeteer.launch({
    executablePath: findDesignExportChrome()!,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  context.after(() => browser.close());

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle0" });

  assert.deepEqual([...requested].filter((path) => path.endsWith(".png")).sort(), expected.sort());
});
