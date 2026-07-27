import assert from "node:assert/strict";
import test from "node:test";

import {
  extractProductionResearchEvidenceText,
} from "../src/research-evidence-text.ts";

function onePagePdf(text: string): Buffer {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const content = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const startXref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${startXref}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

test("Research evidence extraction turns HTML into deterministic visible text with inline punctuation intact", async () => {
  const source = Buffer.from(`
    <!doctype html>
    <html>
      <head>
        <style>.secret { display: block }</style>
        <script>window.privateToken = "must-not-be-evidence"</script>
      </head>
      <body>
        <main>
          <p>Design for <strong>small screens</strong> first &amp; keep the grid fluid.</p>
          <p>Foundation of <a href="/type">typography</a>, <a href="/layout">layout</a>, and color.</p>
        </main>
      </body>
    </html>
  `, "utf8");

  const result = await extractProductionResearchEvidenceText({
    bytes: source,
    mimeType: "text/html; charset=UTF-8",
    signal: new AbortController().signal,
  });

  assert.equal(
    result.text,
    "Design for small screens first & keep the grid fluid. Foundation of typography, layout, and color.",
  );
  assert.equal(result.text.includes("must-not-be-evidence"), false);
  assert.deepEqual(result.extractor, { id: "dezin.html-visible-text", version: 1 });
  assert.equal(result.sourceByteLength, source.byteLength);
  assert.match(result.sourceChecksum, /^[a-f0-9]{64}$/);
  assert.match(result.textChecksum, /^[a-f0-9]{64}$/);
});

test("Research HTML evidence excludes attribute-hidden subtrees while preserving explicitly visible content", async () => {
  const source = Buffer.from(`
    <!doctype html>
    <html>
      <head>
        <style>.hidden-by-stylesheet { display: none }</style>
        <script>script-secret-must-not-be-evidence</script>
      </head>
      <body>
        <main>
          <p>Visible research claim.</p>
          <section hidden>
            <p>hidden-attribute-secret <strong>hidden descendant secret</strong></p>
          </section>
          <section hidden="false">boolean-hidden-false-secret</section>
          <section aria-hidden="true">
            aria-hidden-secret <span>aria-hidden descendant secret</span>
          </section>
          <section aria-hidden=" TRUE ">aria-hidden-case-secret</section>
          <section inert>inert-secret <span>inert descendant secret</span></section>
          <section style="display:none">display-none-secret</section>
          <section style="DISPLAY : none !important">display-none-important-secret</section>
          <section style="visibility:hidden">visibility-hidden-secret</section>
          <section style="visibility: collapse">visibility-collapse-secret</section>
          <section style="opacity:0">opacity-zero-secret</section>
          <section style="opacity: 0.0 !important">opacity-zero-important-secret</section>
          <section style="opacity:0%">opacity-zero-percent-secret</section>
          <section style="content-visibility:hidden">content-visibility-hidden-secret</section>
          <template>template-secret-must-not-be-evidence</template>
          <noscript>noscript-secret-must-not-be-evidence</noscript>
          <section style="display:none; display:block; visibility:hidden; visibility:visible; opacity:0; opacity:1">
            Visible inline cascade claim.
          </section>
          <section aria-hidden="false" style="display: block; visibility: visible">
            Explicitly visible research claim &amp; supporting detail.
          </section>
        </main>
      </body>
    </html>
  `, "utf8");

  const result = await extractProductionResearchEvidenceText({
    bytes: source,
    mimeType: "text/html",
    signal: new AbortController().signal,
  });

  assert.equal(
    result.text,
    "Visible research claim. Visible inline cascade claim. Explicitly visible research claim & supporting detail.",
  );
  for (const invisibleMarker of [
    "script-secret",
    "hidden-attribute-secret",
    "hidden descendant",
    "boolean-hidden-false-secret",
    "aria-hidden-secret",
    "aria-hidden descendant",
    "aria-hidden-case-secret",
    "inert-secret",
    "inert descendant",
    "display-none-secret",
    "display-none-important-secret",
    "visibility-hidden-secret",
    "visibility-collapse-secret",
    "opacity-zero-secret",
    "opacity-zero-important-secret",
    "opacity-zero-percent-secret",
    "content-visibility-hidden-secret",
    "template-secret",
    "noscript-secret",
  ]) {
    assert.equal(
      result.text.includes(invisibleMarker),
      false,
      `${invisibleMarker} must not become canonical Research evidence`,
    );
  }
});

test("Research evidence extraction produces bounded canonical text from a PDF", async () => {
  const result = await extractProductionResearchEvidenceText({
    bytes: onePagePdf("Official poster for the 52nd Chicago International Film Festival"),
    mimeType: "application/pdf",
    signal: new AbortController().signal,
  });

  assert.equal(
    result.text,
    "Official poster for the 52nd Chicago International Film Festival",
  );
  assert.deepEqual(result.extractor, { id: "dezin.pdf-text", version: 1 });
});

test("Research HTML extraction remains abortable when adversarial nesting exhausts its parser budget", {
  timeout: 2_000,
}, async () => {
  const controller = new AbortController();
  const reason = new Error("stop adversarial HTML extraction");
  const source = Buffer.from(`${"<div>".repeat(30_000)}visible${"</div>".repeat(30_000)}`, "utf8");
  const startedAt = performance.now();
  const abortTimer = setTimeout(() => controller.abort(reason), 1);

  try {
    await assert.rejects(
      extractProductionResearchEvidenceText({
        bytes: source,
        mimeType: "text/html",
        signal: controller.signal,
      }),
      (error: unknown) => error === reason,
    );
  } finally {
    clearTimeout(abortTimer);
  }

  assert.ok(
    performance.now() - startedAt < 1_000,
    "untrusted HTML parsing must not block the daemon event loop",
  );
});
