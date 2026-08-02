import {
  Box,
  Braces,
  Component,
  File,
  FileText,
  Image as ImageIcon,
  LayoutTemplate,
  Library,
  Palette,
  Search,
  Video,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../lib/utils.ts";
import { DESIGN_NODE_CATALOG } from "./catalog.ts";
import type { DesignNodeKind } from "./types.ts";

const ICONS: Record<DesignNodeKind, LucideIcon> = {
  component: Component,
  page: LayoutTemplate,
  "design-system": Palette,
  research: Search,
  "design-tokens": Braces,
  "design-document": FileText,
  layout: Box,
  knowledge: Library,
  image: ImageIcon,
  video: Video,
  document: FileText,
  file: File,
};

export function NodeCatalogMenu({
  onChoose,
  className,
  style,
  labelledBy,
}: {
  onChoose: (kind: DesignNodeKind) => void;
  className?: string;
  style?: React.CSSProperties;
  labelledBy?: string;
}) {
  return (
    <div
      role="menu"
      aria-label={labelledBy ? undefined : "Add Design node"}
      aria-labelledby={labelledBy}
      className={cn("design-node-catalog", className)}
      style={style}
      onContextMenu={(event) => event.preventDefault()}
    >
      {(["generate", "context"] as const).map((category) => (
        <section key={category}>
          <p className="design-node-catalog__label">{category === "generate" ? "Generate" : "Add context"}</p>
          <div className="design-node-catalog__grid">
            {DESIGN_NODE_CATALOG.filter((item) => item.category === category).map((item) => {
              const Icon = ICONS[item.kind];
              return (
                <button key={item.kind} type="button" role="menuitem" onClick={() => onChoose(item.kind)}>
                  <span className="design-node-catalog__icon"><Icon aria-hidden /></span>
                  <span className="min-w-0">
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
