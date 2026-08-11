import { parse, type DefaultTreeAdapterTypes } from "parse5";

const MAX_NODE_NAME_BYTES = 256;

export class DesignPageTitleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignPageTitleError";
  }
}

function children(node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.Node[] {
  return "childNodes" in node && Array.isArray(node.childNodes) ? node.childNodes : [];
}

/**
 * Extract the one semantic document title used as first-publication Node
 * metadata. parse5 decodes entities for us; whitespace normalization keeps the
 * durable Canvas name stable across formatting-only HTML changes.
 */
export function extractDesignPageTitle(html: string): string {
  const document = parse(html);
  const titles: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node, insideHead: boolean): void => {
    const element = "tagName" in node ? node as DefaultTreeAdapterTypes.Element : null;
    const inHead = insideHead || element?.tagName.toLowerCase() === "head";
    if (inHead && element?.tagName.toLowerCase() === "title") titles.push(element);
    for (const child of children(node)) visit(child, inHead);
  };
  visit(document, false);
  if (titles.length !== 1) {
    throw new DesignPageTitleError("A Page first generation must contain exactly one non-empty <title> in <head>");
  }
  const text: string[] = [];
  const collect = (node: DefaultTreeAdapterTypes.Node): void => {
    if (node.nodeName === "#text" && "value" in node) text.push(node.value);
    for (const child of children(node)) collect(child);
  };
  collect(titles[0]!);
  const title = text.join("").replace(/\s+/gu, " ").trim();
  if (!title || Buffer.byteLength(title, "utf8") > MAX_NODE_NAME_BYTES) {
    throw new DesignPageTitleError(`A Page first-generation <title> must be 1-${MAX_NODE_NAME_BYTES} UTF-8 bytes`);
  }
  return title;
}
