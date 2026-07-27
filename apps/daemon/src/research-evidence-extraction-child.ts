import { parse } from "parse5";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_INTERMEDIATE_TEXT_BYTES = MAX_TEXT_BYTES * 2;
const MAX_HTML_NODES = 200_000;
const MAX_HTML_DEPTH = 2_048;
const MAX_PDF_PAGES = 64;
const HIDDEN_HTML_ELEMENTS = new Set([
  "script", "style", "noscript", "template", "svg", "canvas",
]);
const BLOCK_HTML_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

interface HtmlNode {
  nodeName: string;
  value?: string;
  attrs?: Array<{
    name: string;
    value: string;
  }>;
  childNodes?: HtmlNode[];
}

interface ExtractionSuccess {
  ok: true;
  text: string;
  extractorId: "dezin.html-visible-text" | "dezin.pdf-text";
  processId: number;
}

interface ExtractionFailure {
  ok: false;
  message: string;
  processId: number;
}

function extractionFailure(message: string): never {
  throw new Error(message);
}

function normalizedText(value: string): string {
  const text = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  const byteLength = Buffer.byteLength(text, "utf8");
  if (text.length === 0 || byteLength > MAX_TEXT_BYTES) {
    return extractionFailure(
      "Research evidence canonical text is empty or exceeds its byte budget",
    );
  }
  return text;
}

function appendBounded(
  chunks: string[],
  value: string,
  currentByteLength: number,
): number {
  const nextByteLength = currentByteLength + Buffer.byteLength(value, "utf8");
  if (nextByteLength > MAX_INTERMEDIATE_TEXT_BYTES) {
    return extractionFailure("Research evidence text exceeds its extraction budget");
  }
  chunks.push(value);
  return nextByteLength;
}

function htmlAttribute(node: HtmlNode, name: string): string | null {
  const attribute = node.attrs?.find(
    (candidate) => candidate.name.toLowerCase() === name,
  );
  return attribute?.value ?? null;
}

function inlineStyleHidesElement(style: string): boolean {
  const withoutComments = style.replace(/\/\*[\s\S]*?\*\//gu, "");
  const declarations = new Map<string, { value: string; important: boolean }>();
  for (const rawDeclaration of withoutComments.split(";")) {
    const separator = rawDeclaration.indexOf(":");
    if (separator < 0) continue;
    const property = rawDeclaration.slice(0, separator).trim().toLowerCase();
    if (property !== "display" && property !== "visibility"
      && property !== "opacity" && property !== "content-visibility") {
      continue;
    }
    const rawValue = rawDeclaration.slice(separator + 1).trim();
    const important = /\s*!important\s*$/iu.test(rawValue);
    const value = rawValue.replace(/\s*!important\s*$/iu, "").trim().toLowerCase();
    const previous = declarations.get(property);
    if (previous === undefined || important || !previous.important) {
      declarations.set(property, { value, important });
    }
  }
  const opacity = declarations.get("opacity")?.value;
  const opacityNumber = opacity === undefined
    ? null
    : opacity.endsWith("%")
      ? opacity.slice(0, -1).trim()
      : opacity;
  const hidesWithOpacity = opacityNumber !== null
    && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(opacityNumber)
    && Number(opacityNumber) <= 0;
  return declarations.get("display")?.value === "none"
    || ["hidden", "collapse"].includes(declarations.get("visibility")?.value ?? "")
    || declarations.get("content-visibility")?.value === "hidden"
    || hidesWithOpacity;
}

function htmlElementHidesSubtree(node: HtmlNode): boolean {
  const attributes = node.attrs ?? [];
  if (attributes.some((attribute) => {
    const name = attribute.name.toLowerCase();
    return name === "hidden" || name === "inert";
  })) {
    return true;
  }
  if (htmlAttribute(node, "aria-hidden")?.trim().toLowerCase() === "true") {
    return true;
  }
  const style = htmlAttribute(node, "style");
  return style !== null && inlineStyleHidesElement(style);
}

function htmlVisibleText(bytes: Uint8Array): string {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return extractionFailure("Research HTML evidence is not UTF-8");
  }
  let document: HtmlNode;
  try {
    document = parse(html) as unknown as HtmlNode;
  } catch {
    return extractionFailure("Research HTML evidence could not be parsed");
  }
  const chunks: string[] = [];
  let chunkBytes = 0;
  let visitedNodes = 0;
  const stack: Array<{
    node: HtmlNode;
    depth: number;
    phase: "enter" | "exit";
  }> = [{ node: document, depth: 0, phase: "enter" }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.phase === "exit") {
      chunkBytes = appendBounded(chunks, "\n", chunkBytes);
      continue;
    }
    visitedNodes += 1;
    if (visitedNodes > MAX_HTML_NODES || frame.depth > MAX_HTML_DEPTH) {
      return extractionFailure("Research HTML evidence exceeds its structural budget");
    }
    if (frame.node.nodeName === "#text") {
      chunkBytes = appendBounded(chunks, frame.node.value ?? "", chunkBytes);
      continue;
    }
    if (HIDDEN_HTML_ELEMENTS.has(frame.node.nodeName)) continue;
    if (htmlElementHidesSubtree(frame.node)) continue;
    const block = BLOCK_HTML_ELEMENTS.has(frame.node.nodeName);
    if (block) {
      chunkBytes = appendBounded(chunks, "\n", chunkBytes);
      stack.push({ ...frame, phase: "exit" });
    }
    const children = frame.node.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index]!,
        depth: frame.depth + 1,
        phase: "enter",
      });
    }
  }
  return normalizedText(chunks.join(""));
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    stopAtErrors: true,
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    const document = await loadingTask.promise;
    if (!Number.isSafeInteger(document.numPages)
      || document.numPages < 1 || document.numPages > MAX_PDF_PAGES) {
      return extractionFailure(
        "Research PDF page count is empty or exceeds its page budget",
      );
    }
    const chunks: string[] = [];
    let chunkBytes = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        for (const raw of content.items) {
          if (!raw || typeof raw !== "object" || !("str" in raw)
            || typeof raw.str !== "string" || typeof raw.hasEOL !== "boolean") continue;
          chunkBytes = appendBounded(chunks, raw.str, chunkBytes);
          chunkBytes = appendBounded(chunks, raw.hasEOL ? "\n" : " ", chunkBytes);
        }
        chunkBytes = appendBounded(chunks, "\n", chunkBytes);
      } finally {
        page.cleanup();
      }
    }
    return normalizedText(chunks.join(""));
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

async function readSourceBytes(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    byteLength += chunk.byteLength;
    if (byteLength > MAX_SOURCE_BYTES) {
      return extractionFailure("Research extraction source exceeds its byte budget");
    }
    chunks.push(chunk);
  }
  if (byteLength < 1) return extractionFailure("Research extraction source is empty");
  return Buffer.concat(chunks, byteLength);
}

async function writeResult(result: ExtractionSuccess | ExtractionFailure): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(result), "utf8");
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(bytes, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  const kind = process.argv[2];
  if (kind !== "html" && kind !== "pdf") {
    return extractionFailure("Research extraction kind is invalid");
  }
  const bytes = await readSourceBytes();
  const result: ExtractionSuccess = kind === "html"
    ? {
        ok: true,
        text: htmlVisibleText(bytes),
        extractorId: "dezin.html-visible-text",
        processId: process.pid,
      }
    : {
        ok: true,
        text: await pdfText(bytes),
        extractorId: "dezin.pdf-text",
        processId: process.pid,
      };
  await writeResult(result);
}

try {
  await main();
} catch (error) {
  await writeResult({
    ok: false,
    message: error instanceof Error
      ? error.message.slice(0, 1_024)
      : "Research evidence extraction failed",
    processId: process.pid,
  }).catch(() => {});
}
