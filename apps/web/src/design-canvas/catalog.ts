import type { DesignNodeKind, DesignNodeGeometry } from "./types.ts";

export interface DesignNodeCatalogItem {
  kind: DesignNodeKind;
  label: string;
  description: string;
  category: "generate" | "context";
  defaultGeometry: Pick<DesignNodeGeometry, "width" | "height">;
  accepts?: string;
}
export const DESIGN_NODE_CATALOG: readonly DesignNodeCatalogItem[] = [
  { kind: "page", label: "Page", description: "A complete product page", category: "generate", defaultGeometry: { width: 520, height: 440 } },
  { kind: "component", label: "Component", description: "Reusable interface component", category: "generate", defaultGeometry: { width: 400, height: 300 } },
  { kind: "design-system", label: "Design system", description: "Visual language and rules", category: "generate", defaultGeometry: { width: 460, height: 340 } },
  { kind: "research", label: "Research", description: "Evidence, sources, and findings", category: "generate", defaultGeometry: { width: 420, height: 340 } },
  { kind: "design-tokens", label: "Design tokens", description: "Color, type, spacing, motion", category: "generate", defaultGeometry: { width: 400, height: 300 } },
  { kind: "design-document", label: "Design.md", description: "Durable design direction", category: "generate", defaultGeometry: { width: 420, height: 340 } },
  { kind: "layout", label: "Layout", description: "Structure and responsive rules", category: "generate", defaultGeometry: { width: 420, height: 320 } },
  { kind: "knowledge", label: "Knowledge", description: "Project knowledge base", category: "generate", defaultGeometry: { width: 420, height: 340 } },
  { kind: "image", label: "Image", description: "Reference image or artwork", category: "context", defaultGeometry: { width: 320, height: 300 }, accepts: "image/*" },
  { kind: "video", label: "Video", description: "Motion reference or footage", category: "context", defaultGeometry: { width: 400, height: 300 }, accepts: "video/*" },
  { kind: "document", label: "Document", description: "PDF, text, or rich document", category: "context", defaultGeometry: { width: 360, height: 260 }, accepts: ".pdf,.md,.txt,.doc,.docx,text/*,application/pdf" },
  { kind: "file", label: "File", description: "Any project context file", category: "context", defaultGeometry: { width: 340, height: 220 }, accepts: "*/*" },
] as const;

export function catalogItem(kind: DesignNodeKind): DesignNodeCatalogItem {
  const item = DESIGN_NODE_CATALOG.find((candidate) => candidate.kind === kind);
  if (!item) throw new TypeError(`Unknown Design node kind: ${kind}`);
  return item;
}

export function isMaterialNodeKind(kind: DesignNodeKind): boolean {
  return catalogItem(kind).category === "context";
}
