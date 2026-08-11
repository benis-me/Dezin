import type { DefaultTreeAdapterTypes } from "parse5";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

const SINGLE_URL_ATTRIBUTES = new Set([
  "src",
  "href",
  "poster",
  "action",
  "formaction",
  "data",
  "manifest",
]);
const RESPONSIVE_URL_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);
// HTML keeps these obsolete attributes for compatibility, and current Chrome
// still fetches every one when connected to a document.
const LEGACY_BACKGROUND_ELEMENTS = new Set([
  "body",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
]);
const SVG_PRESENTATION_URL_PROPERTIES = new Set([
  "clip-path",
  "cursor",
  "fill",
  "filter",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
  "mask",
  "stroke",
]);
const PORTABLE_SVG_HREF_ELEMENTS = new Set([
  "a",
  "animate",
  "animatemotion",
  "animatetransform",
  "discard",
  "feimage",
  "image",
  "lineargradient",
  "mpath",
  "pattern",
  "radialgradient",
  "set",
  "textpath",
  "use",
]);

type DesignHtmlAttribute = DefaultTreeAdapterTypes.Element["attrs"][number];

export type DesignHtmlUrlContextKind =
  | "single"
  | "responsive"
  | "space-separated"
  | "style"
  | "style-value"
  | "unsupported";

interface DesignHtmlUrlContextBase {
  /** parse5 keys source locations by the original qualified spelling. */
  readonly sourceAttributeName: string;
}

export type DesignHtmlUrlContext =
  | (DesignHtmlUrlContextBase & {
    readonly kind: Exclude<DesignHtmlUrlContextKind, "style-value">;
  })
  | (DesignHtmlUrlContextBase & {
    readonly kind: "style-value";
    readonly cssPropertyName: string;
  });

export function designHtmlSourceAttributeName(attribute: DesignHtmlAttribute): string {
  // In foreign content parse5 represents xlink:href as name="href" plus an
  // XLink namespace/prefix, while source locations retain "xlink:href".
  const prefix = "prefix" in attribute && typeof attribute.prefix === "string" && attribute.prefix
    ? `${attribute.prefix}:`
    : "";
  return `${prefix}${attribute.name}`.toLowerCase();
}

/**
 * One namespace-aware authority for URL-bearing markup. Callers decide whether
 * an allowed URL is merely validated or rewritten to an immutable data URL.
 */
export function designHtmlUrlContext(
  element: DefaultTreeAdapterTypes.Element,
  attribute: DesignHtmlAttribute,
): DesignHtmlUrlContext | null {
  const sourceAttributeName = designHtmlSourceAttributeName(attribute);
  const name = attribute.name.toLowerCase();
  const namespace = "namespace" in attribute ? attribute.namespace : undefined;

  if (namespace === XMLNS_NAMESPACE || sourceAttributeName === "xmlns") return null;
  if (namespace === XLINK_NAMESPACE) {
    if (name !== "href") return null;
    return element.namespaceURI === SVG_NAMESPACE
      && PORTABLE_SVG_HREF_ELEMENTS.has(element.tagName.toLowerCase())
      ? { kind: "single", sourceAttributeName }
      : { kind: "unsupported", sourceAttributeName };
  }
  if (namespace !== undefined && namespace !== null) {
    return SINGLE_URL_ATTRIBUTES.has(name) || sourceAttributeName.endsWith(":href")
      ? { kind: "unsupported", sourceAttributeName }
      : null;
  }
  if (sourceAttributeName === "xml:base" || sourceAttributeName.endsWith(":href")) {
    return { kind: "unsupported", sourceAttributeName };
  }
  if (name === "style") return { kind: "style", sourceAttributeName };
  if (element.namespaceURI === SVG_NAMESPACE && SVG_PRESENTATION_URL_PROPERTIES.has(name)) {
    return { kind: "style-value", sourceAttributeName, cssPropertyName: name };
  }
  if (element.namespaceURI === SVG_NAMESPACE && name === "href") {
    return PORTABLE_SVG_HREF_ELEMENTS.has(element.tagName.toLowerCase())
      ? { kind: "single", sourceAttributeName }
      : { kind: "unsupported", sourceAttributeName };
  }
  if (name === "background") {
    return element.namespaceURI === HTML_NAMESPACE && LEGACY_BACKGROUND_ELEMENTS.has(element.tagName.toLowerCase())
      ? { kind: "single", sourceAttributeName }
      : { kind: "unsupported", sourceAttributeName };
  }
  if (SINGLE_URL_ATTRIBUTES.has(name)) return { kind: "single", sourceAttributeName };
  if (RESPONSIVE_URL_ATTRIBUTES.has(name)) return { kind: "responsive", sourceAttributeName };
  if (name === "ping") return { kind: "space-separated", sourceAttributeName };
  return null;
}
